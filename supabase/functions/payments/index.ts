// =============================================================================
// Edge Function « payments » : seule pièce qui parle à Stripe avec la clé secrète.
//
// Secrets requis (Supabase > Edge Functions > Secrets) :
//   STRIPE_SECRET_KEY            sk_test_… (jamais dans le code ni dans le navigateur)
// Fournis automatiquement par Supabase : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//
// Secret optionnel : PLATFORM_FEE_PERCENT (commission WattStop en %, 0 par défaut)
//
// Appel : POST /functions/v1/<adresse>  { action, … }  avec le jeton de l'utilisateur.
// Réservation (booking_id) :
//   authorize : (conducteur) crée ou reprend le blocage du montant maximal → client_secret
//   sync      : (conducteur) relit Stripe et enregistre « authorized » si la carte est validée
//   capture   : (conducteur ou hôte) prélève le montant réel, puis transfère la part de l'hôte
//   release   : (conducteur ou hôte) libère le blocage d'une réservation qui n'a pas eu lieu
// Automatique (pg_cron toutes les 10 min, sans connexion) :
//   release_stale : libère les montants encore bloqués des réservations non honorées, expirées,
//                   annulées, refusées ou recharges oubliées non facturées. Ne peut ni prélever ni transférer : sans risque si appelé par d'autres.
// Notifications push (Web Push) :
//   push_public_key : clé publique VAPID pour abonner un appareil (générée et stockée en base au 1er appel)
//   notify_booking  : (déclencheur SQL, sans connexion) notifie le bon destinataire du statut actuel ;
//                     une seule notification par (réservation, statut), contenu toujours relu en base
//   push_reminders  : (tâche toutes les 5 min) rappel au conducteur 10 min avant la fin de son créneau
//   push_test       : (utilisateur connecté) notification de test sur ses propres appareils
//   notify_message  : (déclencheur SQL, sans connexion) nouveau message de la messagerie → destinataire ;
//                     contenu relu en base, une seule notification par message
// Carte enregistrée du conducteur (garantie de la réservation, rien n'est prélevé à l'enregistrement) :
//   card_setup  : (conducteur) crée le client Stripe si besoin → client_secret d'un SetupIntent
//   card_sync   : (conducteur) relit le SetupIntent chez Stripe et enregistre la carte (marque, 4 chiffres)
//   card_remove : (conducteur) retire sa carte, si aucune réservation ni frais n'est en cours
// Frais d'annulation tardive / d'absence (décidés par la base, table booking_fees) :
//   charge_fees : (déclencheur SQL + tâche toutes les 10 min, sans connexion) prélève les frais en attente
//                 sur la carte enregistrée, puis reverse la part de l'hôte. Ne prélève que ce que la base a décidé.
// Hôte (Stripe Connect, comptes Express) :
//   connect_onboard   : crée le compte Stripe de l'hôte si besoin → lien du formulaire Stripe (origin requis)
//   connect_status    : relit l'état du compte chez Stripe, transfère les sommes en attente
//   connect_dashboard : lien vers l'espace Stripe de l'hôte (virements, IBAN)
//
// Modèle : la plateforme encaisse, puis transfère la part de l'hôte (« separate charges and transfers »).
// Si l'hôte n'a pas encore activé ses paiements, sa part attend et part dès l'activation.
// Les montants viennent TOUJOURS de la base, jamais de la requête.
// =============================================================================
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.49.1";
import webpush from "npm:web-push@3.6.7";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const MIN_CHARGE_CENTS = 50; // minimum Stripe en euros
const HOLD_MARGIN = 1.05; // même tolérance que le plafond anti-fraude du check-out
const PLATFORM_FEE_PERCENT = Math.min(100, Math.max(0, Number(Deno.env.get("PLATFORM_FEE_PERCENT") ?? "0") || 0));

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Booking = {
  id: string;
  driver_id: string;
  host_id: string;
  status: string;
  start_at: string;
  end_at: string;
  price_per_kwh: number;
  total_price: number | null;
  spot: { power_kw: number; title: string } | null;
};
type Payment = {
  booking_id: string;
  stripe_payment_intent_id: string;
  status: string;
  amount_authorized_cents: number;
  amount_captured_cents: number | null;
  payout_status?: string;
  host_amount_cents?: number | null;
  platform_fee_cents?: number | null;
  stripe_transfer_id?: string | null;
};
type DriverCard = {
  driver_id: string;
  stripe_customer_id: string;
  stripe_payment_method_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
};
type Fee = {
  booking_id: string;
  kind: "late_cancellation" | "no_show";
  amount_cents: number;
  status: "pending" | "charged" | "failed" | "waived";
  stripe_payment_intent_id: string | null;
  payout_status: string;
  host_amount_cents: number | null;
};
type PayoutAccount = {
  host_id: string;
  stripe_account_id: string;
  details_submitted: boolean;
  payouts_enabled: boolean;
  transfers_active: boolean;
};

async function currentUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Authentification requise");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Session invalide");
  return data.user;
}

async function loadBooking(id: string): Promise<Booking> {
  const { data, error } = await admin
    .from("bookings")
    .select("id, driver_id, host_id, status, start_at, end_at, price_per_kwh, total_price, spot:spots(power_kw, title)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new HttpError(500, error.message);
  if (!data) throw new HttpError(404, "Réservation introuvable");
  return data as unknown as Booking;
}

async function loadPayment(bookingId: string): Promise<Payment | null> {
  const { data } = await admin.from("payments").select("*").eq("booking_id", bookingId).maybeSingle();
  return data as Payment | null;
}

/** Crée (ou remplace) la ligne de paiement complète d'une réservation. */
async function insertPayment(row: Payment) {
  const { error } = await admin.from("payments").upsert(row, { onConflict: "booking_id" });
  if (error) throw new HttpError(500, error.message);
}

/** Met à jour quelques champs d'une ligne existante. */
async function updatePayment(bookingId: string, fields: Partial<Payment>) {
  const { error } = await admin.from("payments").update(fields).eq("booking_id", bookingId);
  if (error) throw new HttpError(500, error.message);
}

/** Met la base en phase avec l'état réel du PaymentIntent chez Stripe. */
async function syncFromStripe(p: Payment) {
  const pi = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id);
  const status =
    pi.status === "requires_capture" ? "authorized"
    : pi.status === "succeeded" ? "captured"
    : pi.status === "canceled" ? (p.status === "waived" ? "waived" : "canceled")
    : "requires_authorization";
  const amount_captured_cents = pi.status === "succeeded" ? pi.amount_received : p.amount_captured_cents;
  if (status !== p.status || amount_captured_cents !== p.amount_captured_cents) {
    await updatePayment(p.booking_id, { status, amount_captured_cents });
  }
  return { status, pi };
}

/** Montant maximal bloqué : puissance × durée restante du créneau × tarif × 1,05. */
function holdCents(b: Booking) {
  const from = Math.max(Date.now(), new Date(b.start_at).getTime());
  const hours = Math.max(0, new Date(b.end_at).getTime() - from) / 3_600_000;
  const max = (b.spot?.power_kw ?? 0) * hours * Number(b.price_per_kwh) * HOLD_MARGIN;
  return Math.max(MIN_CHARGE_CENTS, Math.ceil(max * 100));
}

async function authorize(b: Booking, userId: string) {
  if (b.driver_id !== userId) throw new HttpError(403, "Seul le conducteur peut payer cette réservation");
  if (b.status !== "confirmed") throw new HttpError(409, "La réservation doit être confirmée par l'hôte");
  const startWindow = new Date(b.start_at).getTime() - 15 * 60_000;
  if (Date.now() < startWindow) throw new HttpError(409, "Le paiement s'ouvre 15 minutes avant le créneau");
  if (Date.now() > new Date(b.end_at).getTime()) throw new HttpError(409, "Le créneau est terminé");

  const existing = await loadPayment(b.id);
  if (existing) {
    const { status, pi } = await syncFromStripe(existing);
    if (status === "authorized") return { status, amount_cents: existing.amount_authorized_cents };
    if (status === "requires_authorization" && pi.client_secret)
      return { status, client_secret: pi.client_secret, amount_cents: existing.amount_authorized_cents };
    if (status !== "canceled") throw new HttpError(409, "Paiement déjà finalisé pour cette réservation");
  }

  const amount = holdCents(b);

  // Carte enregistrée : blocage direct, sans ressaisie. Si la banque demande une validation
  // (3-D Secure) ou refuse, on retombe sur le formulaire de carte classique.
  const card = await loadCard(b.driver_id);
  if (card?.stripe_payment_method_id) {
    try {
      const saved = await stripe.paymentIntents.create(
        {
          amount,
          currency: "eur",
          capture_method: "manual",
          customer: card.stripe_customer_id,
          payment_method: card.stripe_payment_method_id,
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: "never" },
          description: `WattStop · ${b.spot?.title ?? "recharge"}`,
          metadata: { booking_id: b.id, driver_id: b.driver_id, host_id: b.host_id },
        },
        { idempotencyKey: `authorize-saved-${b.id}-${existing?.stripe_payment_intent_id ?? "first"}` },
      );
      if (saved.status === "requires_capture") {
        await insertPayment({
          booking_id: b.id,
          stripe_payment_intent_id: saved.id,
          status: "authorized",
          amount_authorized_cents: amount,
          amount_captured_cents: null,
        });
        return { status: "authorized", amount_cents: amount, saved_card: true };
      }
      await stripe.paymentIntents.cancel(saved.id).catch(() => {});
    } catch (e) {
      console.error("Carte enregistrée non utilisable, formulaire de carte", b.id, (e as Error).message);
    }
  }

  const pi = await stripe.paymentIntents.create(
    {
      amount,
      currency: "eur",
      capture_method: "manual",
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: `WattStop · ${b.spot?.title ?? "recharge"}`,
      metadata: { booking_id: b.id, driver_id: b.driver_id, host_id: b.host_id },
    },
    { idempotencyKey: `authorize-${b.id}-${existing?.stripe_payment_intent_id ?? "first"}` },
  );
  await insertPayment({
    booking_id: b.id,
    stripe_payment_intent_id: pi.id,
    status: "requires_authorization",
    amount_authorized_cents: amount,
    amount_captured_cents: null,
  });
  return { status: "requires_authorization", client_secret: pi.client_secret, amount_cents: amount };
}

async function sync(b: Booking, userId: string) {
  if (b.driver_id !== userId && b.host_id !== userId) throw new HttpError(403, "Accès refusé");
  const p = await loadPayment(b.id);
  if (!p) return { status: "none" };
  const { status } = await syncFromStripe(p);
  return { status, amount_cents: p.amount_authorized_cents };
}

async function capture(b: Booking, userId: string) {
  if (b.driver_id !== userId && b.host_id !== userId) throw new HttpError(403, "Accès refusé");
  if (b.status !== "completed" || b.total_price == null) throw new HttpError(409, "La recharge n'est pas terminée");
  const p = await loadPayment(b.id);
  if (!p) return { status: "none" };
  const { status } = await syncFromStripe(p);
  if (status === "captured") {
    // Déjà prélevé (nouvel appel) : on retente seulement le reversement s'il n'est pas fait
    const fresh = (await loadPayment(b.id))!;
    return { status, amount_cents: fresh.amount_captured_cents, payout_status: await payoutPayment(fresh, b.host_id) };
  }
  if (status !== "authorized") return { status, amount_cents: p.amount_captured_cents };

  const due = Math.round(Number(b.total_price) * 100);
  if (due < MIN_CHARGE_CENTS) {
    // Sous le minimum Stripe : on libère le blocage, rien n'est prélevé
    await stripe.paymentIntents.cancel(p.stripe_payment_intent_id, undefined, { idempotencyKey: `waive-${b.id}` });
    await updatePayment(b.id, { status: "waived", amount_captured_cents: 0 });
    return { status: "waived", amount_cents: 0 };
  }
  const amount = Math.min(due, p.amount_authorized_cents);
  const pi = await stripe.paymentIntents.capture(
    p.stripe_payment_intent_id,
    { amount_to_capture: amount },
    { idempotencyKey: `capture-${b.id}` },
  );
  await updatePayment(b.id, { status: "captured", amount_captured_cents: pi.amount_received });
  const payout = await payoutPayment({ ...p, status: "captured", amount_captured_cents: pi.amount_received }, b.host_id);
  return { status: "captured", amount_cents: pi.amount_received, payout_status: payout };
}

/** Statuts de réservation pour lesquels aucun argent ne doit rester bloqué. */
const DEAD_BOOKING_STATUSES = ["no_show", "expired", "cancelled", "rejected", "unbilled"];

/**
 * Libère les blocages caducs. La liste vient de la base (réservations qui n'auront pas lieu),
 * chaque paiement est revérifié chez Stripe avant d'être libéré. Par lots de 50.
 */
async function releaseStale() {
  const { data, error } = await admin
    .from("payments")
    .select("*, booking:bookings!inner(id, status)")
    .in("status", ["authorized", "requires_authorization"])
    .in("booking.status", DEAD_BOOKING_STATUSES)
    .limit(50);
  if (error) throw new HttpError(500, error.message);
  let released = 0;
  const failures: string[] = [];
  for (const p of (data ?? []) as Payment[]) {
    try {
      const { status } = await syncFromStripe(p);
      if (status === "authorized" || status === "requires_authorization") {
        await stripe.paymentIntents.cancel(p.stripe_payment_intent_id, undefined, { idempotencyKey: `release-${p.booking_id}` });
      }
      if (status !== "captured") {
        await updatePayment(p.booking_id, { status: "canceled" });
        released++;
      }
    } catch (e) {
      console.error("Libération impossible", p.booking_id, e);
      failures.push(p.booking_id);
    }
  }
  return { released, failed: failures.length };
}

// ---------------------------------------------------------------------------
// Notifications push (Web Push)
// ---------------------------------------------------------------------------

let vapid: { publicKey: string; privateKey: string } | null = null;

/** Clés VAPID du projet : relues en base, ou générées une fois puis stockées (table inaccessible au navigateur). */
async function getVapid() {
  if (vapid) return vapid;
  const read = async () => (await admin.from("push_config").select("public_key, private_key").maybeSingle()).data;
  let row = await read();
  if (!row) {
    const k = webpush.generateVAPIDKeys();
    const { error } = await admin.from("push_config").insert({ public_key: k.publicKey, private_key: k.privateKey });
    row = error ? await read() : { public_key: k.publicKey, private_key: k.privateKey }; // si un autre appel a gagné la course
    if (!row) throw new HttpError(500, "Clés de notification indisponibles");
  }
  vapid = { publicKey: row.public_key, privateKey: row.private_key };
  webpush.setVapidDetails(Deno.env.get("PUSH_CONTACT") ?? "mailto:contact@wattstop.app", vapid.publicKey, vapid.privateKey);
  return vapid;
}

type PushMessage = { title: string; body: string; url?: string; tag?: string };

/** Envoie à tous les appareils d'un utilisateur ; supprime les abonnements expirés. */
async function pushTo(userId: string, msg: PushMessage) {
  await getVapid();
  const { data: subs } = await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("user_id", userId);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ url: "/bookings", ...msg }),
        { TTL: 6 * 3600, urgency: "high" },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("id", s.id);
      else console.error("Notification non envoyée", code, (e as Error).message);
    }
  }
  return sent;
}

/** Réserve l'envoi d'un événement : vrai la première fois seulement (anti-doublon). */
async function claim(bookingId: string, event: string) {
  const { error } = await admin.from("push_log").insert({ booking_id: bookingId, event });
  return !error;
}

const euro = (v: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(v);
const kwhFr = (v: number) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(v)} kWh`;
const hourFr = (iso: string) => new Intl.DateTimeFormat("fr-FR", { timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(iso));

/** Notifie le(s) bon(s) destinataire(s) du statut ACTUEL de la réservation (relu en base). */
async function notifyBooking(bookingId: string) {
  const { data: b } = await admin
    .from("bookings")
    .select("id, status, driver_id, host_id, cancelled_by, auto_closed_at, energy_kwh, total_price, spot:spots(title)")
    .eq("id", bookingId)
    .maybeSingle();
  if (!b) return { sent: 0 };
  const spot = (b.spot as { title?: string } | null)?.title ?? "Spot";
  // Frais décidés par la base (annulation tardive, absence) : mentionnés dans le message
  const fee = ["cancelled", "no_show"].includes(b.status)
    ? ((await admin.from("booking_fees").select("amount_cents").eq("booking_id", b.id).maybeSingle()).data as { amount_cents: number } | null)
    : null;
  const out: { to: string; msg: PushMessage }[] = [];
  const host = (title: string, body = spot) => out.push({ to: b.host_id, msg: { title, body } });
  const driver = (title: string, body = spot) => out.push({ to: b.driver_id, msg: { title, body } });
  switch (b.status) {
    case "pending": host("🔔 Nouvelle demande de réservation"); break;
    case "confirmed": driver("✅ Réservation acceptée"); break;
    case "rejected": driver("Réservation refusée par l'hôte"); break;
    case "cancelled":
      if (b.cancelled_by === b.driver_id) {
        if (fee) {
          host("Réservation annulée tardivement par le conducteur", `${spot} · ${euro(fee.amount_cents / 100)} de dédommagement pour vous`);
          driver("Annulation tardive", `${spot} · ${euro(fee.amount_cents / 100)} de frais, reversés à l'hôte`);
        } else host("Réservation annulée par le conducteur");
      } else if (b.cancelled_by === b.host_id) driver("Réservation annulée par l'hôte");
      break;
    case "active": host("⚡ Recharge démarrée"); break;
    case "completed": {
      const detail = `${spot} · ${kwhFr(Number(b.energy_kwh ?? 0))} · ${euro(Number(b.total_price ?? 0))}`;
      host("✅ Recharge terminée", detail);
      if (b.auto_closed_at) driver("✅ Recharge facturée", detail); // relevé déclaré par l'hôte
      break;
    }
    case "expired":
      driver("⏰ Demande expirée : l'hôte n'a pas répondu à temps");
      host("⏰ Demande expirée sans réponse");
      break;
    case "no_show":
      host("Le conducteur ne s'est pas présenté", fee ? `${spot} · ${euro(fee.amount_cents / 100)} de dédommagement pour vous` : spot);
      driver("Réservation non honorée : créneau terminé sans recharge", fee ? `${spot} · ${euro(fee.amount_cents / 100)} de frais d'absence, reversés à l'hôte` : spot);
      break;
    case "awaiting_meter":
      host("⏰ Recharge oubliée : déclarez les kWh relevés");
      driver("⏰ Recharge clôturée automatiquement", `${spot} · vous aviez oublié de la terminer`);
      break;
    case "unbilled":
      host("Recharge oubliée clôturée sans facturation");
      driver("Recharge oubliée non facturée");
      break;
  }
  if (!out.length) return { status: b.status, claimed: false, sent: 0 };
  // claimed = false : déjà notifié (par le déclencheur, ou un appel précédent)
  if (!(await claim(b.id, b.status))) return { status: b.status, claimed: false, sent: 0 };
  let sent = 0;
  for (const o of out) sent += await pushTo(o.to, { ...o.msg, tag: `booking-${b.id}` });
  return { status: b.status, claimed: true, sent };
}

/** Nouveau message d'une conversation : notifie l'autre participant de la réservation. */
async function notifyMessage(messageId: string) {
  const { data: m } = await admin
    .from("booking_messages")
    .select("id, booking_id, sender_id, body, booking:bookings(driver_id, host_id, spot:spots(title))")
    .eq("id", messageId)
    .maybeSingle();
  if (!m) return { sent: 0 };
  const b = m.booking as unknown as { driver_id: string; host_id: string; spot: { title?: string } | null } | null;
  if (!b) return { sent: 0 };
  const to = m.sender_id === b.driver_id ? b.host_id : b.driver_id;
  if (!(await claim(m.booking_id, `msg:${m.id}`))) return { claimed: false, sent: 0 };
  const { data: sender } = await admin.from("profiles").select("full_name").eq("id", m.sender_id).maybeSingle();
  const name = (sender?.full_name ?? "").trim().split(/\s+/)[0] || (m.sender_id === b.driver_id ? "Le conducteur" : "L'hôte");
  const text = m.body.length > 140 ? `${m.body.slice(0, 137)}…` : m.body;
  const sent = await pushTo(to, {
    title: `💬 ${name} · ${b.spot?.title ?? "Réservation"}`,
    body: text,
    url: `/bookings#booking-${m.booking_id}`,
    tag: `chat-${m.booking_id}`,
  });
  return { claimed: true, sent };
}

/** Rappel au conducteur 10 minutes avant la fin d'une recharge en cours. */
async function pushReminders() {
  const now = Date.now();
  const { data } = await admin
    .from("bookings")
    .select("id, driver_id, end_at, spot:spots(title)")
    .eq("status", "active")
    .gt("end_at", new Date(now).toISOString())
    .lte("end_at", new Date(now + 10 * 60_000).toISOString());
  let sent = 0;
  for (const b of data ?? []) {
    if (!(await claim(b.id, "reminder_end"))) continue;
    sent += await pushTo(b.driver_id, {
      title: `⏰ Votre créneau se termine à ${hourFr(b.end_at)}`,
      body: `${(b.spot as { title?: string } | null)?.title ?? "Spot"} · scannez le QR pour terminer la recharge`,
      tag: `booking-${b.id}`,
    });
  }
  return { sent };
}

// ---------------------------------------------------------------------------
// Reversement à l'hôte (Stripe Connect)
// ---------------------------------------------------------------------------

/** Relit le compte Stripe de l'hôte et met la base à jour. null si l'hôte n'a pas encore commencé. */
async function refreshAccount(hostId: string): Promise<PayoutAccount | null> {
  const { data } = await admin.from("host_payout_accounts").select("*").eq("host_id", hostId).maybeSingle();
  if (!data) return null;
  const acc = await stripe.accounts.retrieve(data.stripe_account_id);
  const fresh = {
    details_submitted: !!acc.details_submitted,
    payouts_enabled: !!acc.payouts_enabled,
    transfers_active: acc.capabilities?.transfers === "active",
  };
  if (fresh.details_submitted !== data.details_submitted || fresh.payouts_enabled !== data.payouts_enabled || fresh.transfers_active !== data.transfers_active) {
    await admin.from("host_payout_accounts").update(fresh).eq("host_id", hostId);
  }
  return { ...(data as PayoutAccount), ...fresh };
}

/**
 * Transfère la part de l'hôte d'un paiement prélevé. Idempotent : un paiement n'est transféré qu'une fois.
 * Renvoie l'état du reversement.
 */
async function payoutPayment(p: Payment, hostId: string, account?: PayoutAccount | null): Promise<string> {
  if (p.status !== "captured") return "none";
  return payoutRow("payments", p.booking_id, p.stripe_payment_intent_id, p.amount_captured_cents ?? 0, p.payout_status, hostId, account);
}

/** Reverse à l'hôte des frais d'annulation tardive ou d'absence prélevés. */
async function payoutFee(f: Fee, hostId: string, account?: PayoutAccount | null): Promise<string> {
  if (f.status !== "charged" || !f.stripe_payment_intent_id) return "none";
  return payoutRow("booking_fees", f.booking_id, f.stripe_payment_intent_id, f.amount_cents, f.payout_status, hostId, account);
}

/** Transfert idempotent de la part de l'hôte (paiement de recharge ou frais), état enregistré dans la table. */
async function payoutRow(
  table: "payments" | "booking_fees",
  bookingId: string,
  paymentIntentId: string,
  captured: number,
  payoutStatus: string | undefined,
  hostId: string,
  account?: PayoutAccount | null,
): Promise<string> {
  const p = { booking_id: bookingId, stripe_payment_intent_id: paymentIntentId };
  const save = async (fields: Record<string, unknown>) => {
    const { error } = await admin.from(table).update(fields).eq("booking_id", bookingId);
    if (error) throw new HttpError(500, error.message);
  };
  if (captured <= 0) return "none";
  if (payoutStatus === "transferred") return "transferred";
  const fee = Math.round((captured * PLATFORM_FEE_PERCENT) / 100);
  const hostAmount = captured - fee;
  const acct = account === undefined ? await refreshAccount(hostId) : account;
  if (!acct?.transfers_active) {
    await save({ payout_status: "awaiting_host_account", host_amount_cents: hostAmount, platform_fee_cents: fee });
    return "awaiting_host_account";
  }
  try {
    const pi = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id);
    const transfer = await stripe.transfers.create(
      {
        amount: hostAmount,
        currency: "eur",
        destination: acct.stripe_account_id,
        // Lié au paiement : le transfert part même si les fonds ne sont pas encore disponibles
        source_transaction: typeof pi.latest_charge === "string" ? pi.latest_charge : pi.latest_charge?.id,
        transfer_group: `booking_${p.booking_id}`,
        metadata: { booking_id: p.booking_id, host_id: hostId, kind: table === "payments" ? "charge" : "fee" },
      },
      { idempotencyKey: table === "payments" ? `transfer-${p.booking_id}` : `transfer-fee-${p.booking_id}` },
    );
    await save({
      payout_status: "transferred",
      host_amount_cents: hostAmount,
      platform_fee_cents: fee,
      stripe_transfer_id: transfer.id,
    });
    return "transferred";
  } catch (e) {
    // On réessaiera au prochain passage (ouverture de « Mes spots », nouveau prélèvement…)
    console.error("Transfert à l'hôte impossible", p.booking_id, e);
    await save({ payout_status: "awaiting_host_account", host_amount_cents: hostAmount, platform_fee_cents: fee });
    return "awaiting_host_account";
  }
}

/** Transfère toutes les sommes de l'hôte encore en attente, et renvoie les totaux. */
async function sweepHost(hostId: string, account: PayoutAccount | null) {
  const { data } = await admin
    .from("payments")
    .select("*, booking:bookings!inner(host_id)")
    .eq("booking.host_id", hostId)
    .eq("status", "captured");
  let pending = 0, transferred = 0;
  for (const p of (data ?? []) as Payment[]) {
    const state = await payoutPayment(p, hostId, account);
    const amount = p.host_amount_cents ?? Math.round((p.amount_captured_cents ?? 0) * (1 - PLATFORM_FEE_PERCENT / 100));
    if (state === "transferred") transferred += amount;
    else if (state === "awaiting_host_account") pending += amount;
  }
  const { data: fees } = await admin
    .from("booking_fees")
    .select("*, booking:bookings!inner(host_id)")
    .eq("booking.host_id", hostId)
    .eq("status", "charged");
  for (const f of (fees ?? []) as Fee[]) {
    const state = await payoutFee(f, hostId, account);
    const amount = f.host_amount_cents ?? Math.round(f.amount_cents * (1 - PLATFORM_FEE_PERCENT / 100));
    if (state === "transferred") transferred += amount;
    else if (state === "awaiting_host_account") pending += amount;
  }
  return { pending_cents: pending, transferred_cents: transferred };
}

/** Origine de l'app pour les liens de retour du formulaire Stripe (http/https uniquement). */
function appOrigin(origin: unknown) {
  if (typeof origin !== "string") throw new HttpError(400, "origin manquant");
  let url: URL;
  try { url = new URL(origin); } catch { throw new HttpError(400, "origin invalide"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new HttpError(400, "origin invalide");
  const allowed = (Deno.env.get("APP_ORIGINS") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(url.origin)) throw new HttpError(400, "origin non autorisée");
  return url.origin;
}

async function isHost(userId: string) {
  const { data } = await admin.from("profiles").select("role").eq("id", userId).maybeSingle();
  return data?.role === "host" || data?.role === "both";
}

async function connectOnboard(user: { id: string; email?: string }, body: Record<string, unknown>) {
  if (!(await isHost(user.id))) throw new HttpError(403, "Publiez d'abord un spot pour devenir hôte");
  const origin = appOrigin(body.origin);
  let row = (await admin.from("host_payout_accounts").select("*").eq("host_id", user.id).maybeSingle()).data as PayoutAccount | null;
  if (!row) {
    const acc = await stripe.accounts.create(
      {
        type: "express",
        country: "FR",
        email: user.email,
        business_type: "individual",
        capabilities: { transfers: { requested: true } },
        business_profile: { product_description: "Recharge de véhicules électriques entre particuliers (WattStop)", mcc: "5552" },
        metadata: { host_id: user.id },
      },
      { idempotencyKey: `connect-account-${user.id}` },
    );
    const { error } = await admin.from("host_payout_accounts").insert({ host_id: user.id, stripe_account_id: acc.id });
    if (error) throw new HttpError(500, error.message);
    row = { host_id: user.id, stripe_account_id: acc.id, details_submitted: false, payouts_enabled: false, transfers_active: false };
  }
  const link = await stripe.accountLinks.create({
    account: row.stripe_account_id,
    type: "account_onboarding",
    refresh_url: `${origin}/host?stripe=refresh`,
    return_url: `${origin}/host?stripe=return`,
  });
  return { url: link.url };
}

async function connectStatus(user: { id: string }) {
  const account = await refreshAccount(user.id);
  const totals = await sweepHost(user.id, account);
  return {
    account: account && {
      details_submitted: account.details_submitted,
      payouts_enabled: account.payouts_enabled,
      transfers_active: account.transfers_active,
    },
    ...totals,
  };
}

async function connectDashboard(user: { id: string }) {
  const account = await refreshAccount(user.id);
  if (!account?.details_submitted) throw new HttpError(409, "Terminez d'abord l'activation de vos paiements");
  const link = await stripe.accounts.createLoginLink(account.stripe_account_id);
  return { url: link.url };
}

// ---------------------------------------------------------------------------
// Carte enregistrée et frais d'annulation
// ---------------------------------------------------------------------------

async function loadCard(driverId: string): Promise<DriverCard | null> {
  const { data } = await admin.from("driver_cards").select("*").eq("driver_id", driverId).maybeSingle();
  return data as DriverCard | null;
}

/** Client Stripe du conducteur (créé une seule fois). */
async function ensureCustomer(user: { id: string; email?: string }): Promise<DriverCard> {
  const existing = await loadCard(user.id);
  if (existing) return existing;
  const customer = await stripe.customers.create(
    { email: user.email, metadata: { driver_id: user.id } },
    { idempotencyKey: `customer-${user.id}` },
  );
  const { error } = await admin.from("driver_cards").insert({ driver_id: user.id, stripe_customer_id: customer.id });
  if (error) {
    const again = await loadCard(user.id); // un autre appel a gagné la course
    if (again) return again;
    throw new HttpError(500, error.message);
  }
  return { driver_id: user.id, stripe_customer_id: customer.id, stripe_payment_method_id: null, card_brand: null, card_last4: null };
}

async function cardSetup(user: { id: string; email?: string }) {
  const card = await ensureCustomer(user);
  const si = await stripe.setupIntents.create({
    customer: card.stripe_customer_id,
    usage: "off_session",
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
    metadata: { driver_id: user.id },
  });
  return { client_secret: si.client_secret, setup_intent_id: si.id };
}

async function cardSync(user: { id: string }, body: Record<string, unknown>) {
  const id = body.setup_intent_id;
  if (typeof id !== "string" || !/^seti_[A-Za-z0-9]+$/.test(id)) throw new HttpError(400, "setup_intent_id invalide");
  const card = await loadCard(user.id);
  if (!card) throw new HttpError(404, "Aucune carte en cours d'enregistrement");
  const si = await stripe.setupIntents.retrieve(id);
  if (si.customer !== card.stripe_customer_id) throw new HttpError(403, "Accès refusé");
  if (si.status !== "succeeded" || !si.payment_method) throw new HttpError(409, "Carte pas encore validée");
  const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method.id;
  const pm = await stripe.paymentMethods.retrieve(pmId);
  await stripe.customers.update(card.stripe_customer_id, { invoice_settings: { default_payment_method: pmId } });
  const previous = card.stripe_payment_method_id;
  const fields = {
    stripe_payment_method_id: pmId,
    card_brand: pm.card?.brand ?? pm.type,
    card_last4: pm.card?.last4 ?? null,
    card_exp_month: pm.card?.exp_month ?? null,
    card_exp_year: pm.card?.exp_year ?? null,
  };
  const { error } = await admin.from("driver_cards").update(fields).eq("driver_id", user.id);
  if (error) throw new HttpError(500, error.message);
  if (previous && previous !== pmId) await stripe.paymentMethods.detach(previous).catch(() => {});
  return { card: { brand: fields.card_brand, last4: fields.card_last4, exp_month: fields.card_exp_month, exp_year: fields.card_exp_year } };
}

async function cardRemove(user: { id: string }) {
  const card = await loadCard(user.id);
  if (!card?.stripe_payment_method_id) return { removed: false };
  const { count } = await admin
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("driver_id", user.id)
    .in("status", ["pending", "confirmed", "active", "awaiting_meter"]);
  if (count) throw new HttpError(409, "Annulez ou terminez d'abord vos réservations en cours");
  const { data: fees } = await admin.from("booking_fees").select("booking_id, booking:bookings!inner(driver_id)").eq("booking.driver_id", user.id).eq("status", "pending");
  if (fees?.length) throw new HttpError(409, "Des frais sont en cours de règlement");
  await stripe.paymentMethods.detach(card.stripe_payment_method_id).catch(() => {});
  await admin.from("driver_cards").update({ stripe_payment_method_id: null, card_brand: null, card_last4: null, card_exp_month: null, card_exp_year: null }).eq("driver_id", user.id);
  return { removed: true };
}

/**
 * Prélève les frais d'annulation tardive / d'absence en attente (décidés par la base), sur la carte
 * enregistrée, puis reverse la part de l'hôte. Idempotent : une clé Stripe par réservation.
 */
async function chargeFees(bookingId?: string) {
  let q = admin.from("booking_fees").select("*").eq("status", "pending").limit(50);
  if (bookingId) q = q.eq("booking_id", bookingId);
  const { data, error } = await q;
  if (error) throw new HttpError(500, error.message);
  let charged = 0, failed = 0;
  for (const f of (data ?? []) as Fee[]) {
    const { data: b } = await admin.from("bookings").select("id, driver_id, host_id, spot:spots(title)").eq("id", f.booking_id).maybeSingle();
    if (!b) continue;
    const save = (fields: Record<string, unknown>) => admin.from("booking_fees").update(fields).eq("booking_id", f.booking_id);
    if (f.amount_cents < MIN_CHARGE_CENTS) {
      await save({ status: "waived" });
      continue;
    }
    const card = await loadCard(b.driver_id);
    if (!card?.stripe_payment_method_id) {
      await save({ status: "failed", failure_message: "Aucune carte enregistrée" });
      failed++;
      continue;
    }
    const label = f.kind === "no_show" ? "absence" : "annulation tardive";
    try {
      const pi = await stripe.paymentIntents.create(
        {
          amount: f.amount_cents,
          currency: "eur",
          customer: card.stripe_customer_id,
          payment_method: card.stripe_payment_method_id,
          off_session: true,
          confirm: true,
          description: `WattStop · frais d'${label} · ${(b.spot as { title?: string } | null)?.title ?? "spot"}`,
          metadata: { booking_id: b.id, driver_id: b.driver_id, host_id: b.host_id, kind: f.kind },
        },
        { idempotencyKey: `fee-${f.booking_id}` },
      );
      if (pi.status !== "succeeded") {
        await save({ status: "failed", stripe_payment_intent_id: pi.id, failure_message: `Paiement ${pi.status}` });
        failed++;
        continue;
      }
      await save({ status: "charged", stripe_payment_intent_id: pi.id, failure_message: null });
      charged++;
      await payoutFee({ ...f, status: "charged", stripe_payment_intent_id: pi.id }, b.host_id);
    } catch (e) {
      if (e instanceof Stripe.errors.StripeIdempotencyError) continue; // l'autre appel s'en charge
      const err = e as { message?: string; payment_intent?: { id?: string } };
      console.error("Frais non prélevés", f.booking_id, err.message);
      await save({ status: "failed", stripe_payment_intent_id: err.payment_intent?.id ?? null, failure_message: err.message ?? "Paiement refusé" });
      failed++;
    }
  }
  return { charged, failed };
}

async function release(b: Booking, userId: string) {
  if (b.driver_id !== userId && b.host_id !== userId) throw new HttpError(403, "Accès refusé");
  if (["active", "completed"].includes(b.status)) throw new HttpError(409, "Recharge en cours ou terminée");
  const p = await loadPayment(b.id);
  if (!p) return { status: "none" };
  const { status } = await syncFromStripe(p);
  if (status === "authorized" || status === "requires_authorization") {
    await stripe.paymentIntents.cancel(p.stripe_payment_intent_id, undefined, { idempotencyKey: `release-${b.id}` });
    await updatePayment(b.id, { status: "canceled" });
    return { status: "canceled" };
  }
  return { status };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée" }, 405);
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const { action, booking_id } = body;
    // Actions sans connexion (tâches planifiées, déclencheur SQL, clé publique) : sans effet nuisible si répétées
    if (action === "release_stale") return json(await releaseStale());
    if (action === "push_public_key") return json({ public_key: (await getVapid()).publicKey });
    if (action === "push_reminders") return json(await pushReminders());
    if (action === "charge_fees") {
      if (!Deno.env.get("STRIPE_SECRET_KEY")) throw new HttpError(500, "STRIPE_SECRET_KEY manquant");
      const id = typeof booking_id === "string" && /^[0-9a-f-]{36}$/i.test(booking_id) ? booking_id : undefined;
      return json(await chargeFees(id));
    }
    if (action === "notify_message") {
      const id = body.message_id;
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, "message_id invalide");
      return json(await notifyMessage(id));
    }
    if (action === "notify_booking") {
      if (typeof booking_id !== "string" || !/^[0-9a-f-]{36}$/i.test(booking_id)) throw new HttpError(400, "booking_id invalide");
      return json(await notifyBooking(booking_id));
    }

    const user = await currentUser(req);
    if (action === "push_test") {
      const sent = await pushTo(user.id, { title: "🔔 Notifications WattStop activées", body: "Vous serez prévenu de vos réservations, même app fermée." });
      return json({ sent });
    }

    const cardActions = { card_setup: cardSetup, card_sync: cardSync, card_remove: cardRemove } as const;
    const cardHandler = cardActions[action as keyof typeof cardActions];
    if (cardHandler) {
      if (!Deno.env.get("STRIPE_SECRET_KEY")) throw new HttpError(500, "STRIPE_SECRET_KEY manquant");
      return json(await cardHandler(user, body));
    }

    const hostActions = { connect_onboard: connectOnboard, connect_status: connectStatus, connect_dashboard: connectDashboard } as const;
    const hostHandler = hostActions[action as keyof typeof hostActions];
    if (hostHandler) return json(await hostHandler(user, body));

    if (typeof booking_id !== "string" || !/^[0-9a-f-]{36}$/i.test(booking_id)) throw new HttpError(400, "booking_id invalide");
    if (!Deno.env.get("STRIPE_SECRET_KEY")) throw new HttpError(500, "STRIPE_SECRET_KEY manquant dans les secrets de la fonction");
    const booking = await loadBooking(booking_id);
    const handlers = { authorize, sync, capture, release } as const;
    const handler = handlers[action as keyof typeof handlers];
    if (!handler) throw new HttpError(400, "Action inconnue");
    return json(await handler(booking, user.id));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof Stripe.errors.StripeError) return json({ error: `Stripe : ${e.message}` }, 402);
    console.error(e);
    return json({ error: "Erreur interne" }, 500);
  }
});
