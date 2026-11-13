// =============================================================================
// Edge Function « payments » : seule pièce qui parle à Stripe avec la clé secrète.
//
// Secrets requis (Supabase > Edge Functions > Secrets) :
//   STRIPE_SECRET_KEY            sk_test_… (jamais dans le code ni dans le navigateur)
// Fournis automatiquement par Supabase : SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//
// Appel : POST /functions/v1/payments  { action, booking_id }  avec le jeton de l'utilisateur.
//   authorize : (conducteur) crée ou reprend le blocage du montant maximal → client_secret
//   sync      : (conducteur) relit Stripe et enregistre « authorized » si la carte est validée
//   capture   : (conducteur ou hôte) prélève le montant réel d'une recharge terminée
//   release   : (conducteur ou hôte) libère le blocage d'une réservation qui n'a pas eu lieu
//
// Les montants viennent TOUJOURS de la base, jamais de la requête.
// =============================================================================
import Stripe from "npm:stripe@17.7.0";
import { createClient } from "npm:@supabase/supabase-js@2.49.1";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const MIN_CHARGE_CENTS = 50; // minimum Stripe en euros
const HOLD_MARGIN = 1.05; // même tolérance que le plafond anti-fraude du check-out

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
};

async function currentUserId(req: Request) {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Authentification requise");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Session invalide");
  return data.user.id;
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
  return { status: "captured", amount_cents: pi.amount_received };
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
    if (!Deno.env.get("STRIPE_SECRET_KEY")) throw new HttpError(500, "STRIPE_SECRET_KEY manquant dans les secrets de la fonction");
    const userId = await currentUserId(req);
    const { action, booking_id } = await req.json().catch(() => ({}));
    if (typeof booking_id !== "string" || !/^[0-9a-f-]{36}$/i.test(booking_id)) throw new HttpError(400, "booking_id invalide");
    const booking = await loadBooking(booking_id);
    const handlers = { authorize, sync, capture, release } as const;
    const handler = handlers[action as keyof typeof handlers];
    if (!handler) throw new HttpError(400, "Action inconnue");
    return json(await handler(booking, userId));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof Stripe.errors.StripeError) return json({ error: `Stripe : ${e.message}` }, 402);
    console.error(e);
    return json({ error: "Erreur interne" }, 500);
  }
});
