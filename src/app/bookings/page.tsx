import { createClient } from "@/lib/supabase/server";
import type { Booking } from "@/types/db";
import { dateTime, eur, kwh } from "@/lib/format";
import { BookingActions } from "@/components/booking-actions";
import { MeterDeclaration } from "@/components/meter-declaration";
import { PushToggle } from "@/components/push-toggle";
import { ReviewForm } from "@/components/review-form";
import { Stars } from "@/components/stars";
import { ratingLabel, REVIEW_DAYS, type ProfileRating, type Review } from "@/lib/ratings";
import { PAYMENTS_FUNCTION, paymentsEnabled, type PaymentStatus, type PayoutStatus } from "@/lib/payments";

export const metadata = { title: "Mes réservations" };

const STATUS_LABEL: Record<Booking["status"], string> = {
  pending: "En attente",
  confirmed: "Confirmée",
  active: "En charge",
  completed: "Terminée",
  cancelled: "Annulée",
  rejected: "Refusée",
  expired: "Expirée",
  no_show: "Non honorée",
  awaiting_meter: "Relevé à saisir",
  unbilled: "Non facturée",
};

/** Explication affichée sous les statuts posés automatiquement. */
const STATUS_HINT: Partial<Record<Booking["status"], { host: string; driver: string }>> = {
  expired: {
    host: "Demande restée sans réponse au début du créneau.",
    driver: "L'hôte n'a pas répondu avant le début du créneau. Le créneau est libéré.",
  },
  no_show: {
    host: "Le créneau s'est terminé sans que la recharge démarre.",
    driver: "Le créneau s'est terminé sans que la recharge démarre.",
  },
  awaiting_meter: {
    host: "Recharge oubliée : clôturée automatiquement 1 h après la fin du créneau.",
    driver: "Vous n'avez pas terminé la recharge : elle a été clôturée 1 h après la fin du créneau. L'hôte va déclarer les kWh relevés sur son compteur ; seule la durée du créneau compte.",
  },
  unbilled: {
    host: "Recharge oubliée sans relevé sous 24 h : rien n'a été facturé.",
    driver: "Recharge oubliée clôturée sans facturation. Le montant bloqué a été libéré.",
  },
};

export default async function BookingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Applique tout de suite les règles d'expiration (la tâche planifiée ne passe que toutes les 5 min)
  await supabase.rpc("expire_bookings");

  // La RLS ne renvoie que les réservations où l'on est conducteur OU hôte.
  const BASE = "*, spot:spots(title, address, power_kw), driver:profiles!bookings_driver_id_fkey(full_name)";
  const list = (columns: string) => supabase.from("bookings").select(columns).order("start_at", { ascending: false }).limit(50);
  let { data, error } = await list(`${BASE}, payment:payments(status, amount_authorized_cents, amount_captured_cents, payout_status, host_amount_cents)`);
  // Bases plus anciennes : sans les colonnes de reversement, puis sans la table payments
  if (error) ({ data, error } = await list(`${BASE}, payment:payments(status, amount_authorized_cents, amount_captured_cents)`));
  if (error) ({ data, error } = await list(BASE));
  if (error) console.error("Réservations :", error.message);

  const bookings = (data ?? []) as unknown as (Booking & {
    spot: { title: string; address: string; power_kw: number } | null;
    driver: { full_name: string | null } | null;
    payment: Payment | null;
  })[];

  // Filet de sécurité : une recharge terminée dont le montant est encore seulement bloqué
  // (page fermée trop tôt…) est prélevée maintenant. Le montant vient de la base, pas du client.
  const toCapture = paymentsEnabled ? bookings.filter((b) => b.status === "completed" && b.payment?.status === "authorized") : [];
  if (toCapture.length) {
    await Promise.all(toCapture.map((b) => supabase.functions.invoke(PAYMENTS_FUNCTION, { body: { action: "capture", booking_id: b.id } })));
    const { data: fresh } = await supabase
      .from("payments")
      .select("booking_id, status, amount_authorized_cents, amount_captured_cents, payout_status, host_amount_cents")
      .in("booking_id", toCapture.map((b) => b.id));
    for (const p of fresh ?? []) {
      const b = bookings.find((x) => x.id === p.booking_id);
      if (b) b.payment = p as (typeof bookings)[number]["payment"];
    }
  }

  // Avis : les miens et ceux reçus déjà publiés (la RLS cache les autres), notes des conducteurs pour l'hôte.
  // Bases sans la migration des avis : listes vides, la page s'affiche normalement.
  const ids = bookings.map((b) => b.id);
  const driverIds = [...new Set(bookings.filter((b) => b.host_id === user?.id).map((b) => b.driver_id))];
  const [{ data: reviewRows }, { data: ratingRows }] = await Promise.all([
    ids.length ? supabase.from("reviews").select("*").in("booking_id", ids) : Promise.resolve({ data: [] }),
    driverIds.length ? supabase.rpc("profile_ratings", { p_ids: driverIds }) : Promise.resolve({ data: [] }),
  ]);
  const reviews = (reviewRows ?? []) as Review[];
  const driverRatings = new Map(((ratingRows ?? []) as ProfileRating[]).map((r) => [r.user_id, r]));
  const reviewsEnabled = reviewRows !== null;

  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold">Réservations</h1>
      <PushToggle />
      {bookings.length === 0 && <p className="text-muted">Aucune réservation pour l&apos;instant.</p>}
      {bookings.map((b) => {
        const asHost = b.host_id === user?.id;
        const mine = reviews.find((r) => r.booking_id === b.id && r.author_id === user?.id);
        const received = reviews.find((r) => r.booking_id === b.id && r.author_id !== user?.id);
        const reviewDeadline = new Date(new Date(b.checked_out_at ?? b.end_at).getTime() + REVIEW_DAYS * 86_400_000);
        const canReview = reviewsEnabled && b.status === "completed" && !mine && reviewDeadline.getTime() > Date.now();
        const driverRating = asHost ? driverRatings.get(b.driver_id) : undefined;
        const driverLabel = ratingLabel(driverRating?.driver_avg, driverRating?.driver_count);
        return (
          <article key={b.id} className="card grid gap-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{b.spot?.title}</p>
                <p className="text-xs text-subtle">
                  {asHost ? `Conducteur : ${b.driver?.full_name ?? "sans nom"}` : "Vous êtes le conducteur"}
                  {asHost && (driverLabel ? <span className="text-star"> · {driverLabel}</span> : <span> · nouveau conducteur</span>)}
                </p>
              </div>
              <span className="shrink-0 whitespace-nowrap rounded-full bg-soft px-2 py-0.5 text-xs">{STATUS_LABEL[b.status]}</span>
            </div>
            <p className="text-sm text-muted">{dateTime(b.start_at)} → {dateTime(b.end_at)}</p>
            {STATUS_HINT[b.status] && (
              <p className="text-sm text-muted">⏰ {STATUS_HINT[b.status]![asHost ? "host" : "driver"]}</p>
            )}
            {b.driver_note && (
              <p className="rounded-lg bg-soft p-2 text-sm">💬 {asHost ? "" : "Votre message : "}{b.driver_note}</p>
            )}
            {b.status === "completed" && b.total_price != null && (
              <p className="text-sm">{kwh(b.energy_kwh ?? 0)} · <strong>{eur(b.total_price)}</strong></p>
            )}
            {b.payment && <PaymentLine payment={b.payment} asHost={asHost} />}
            {asHost && b.status === "awaiting_meter" && b.checked_in_at && b.checked_out_at && b.auto_closed_at && (
              <MeterDeclaration
                bookingId={b.id}
                // Même plafond que la base : puissance × durée branchée (jusqu'à la fin du créneau) × 1,05
                maxKwh={Math.floor(((b.spot?.power_kw ?? 0) * (new Date(b.checked_out_at).getTime() - new Date(b.checked_in_at).getTime()) / 3_600_000) * 1.05 * 100) / 100}
                pricePerKwh={Number(b.price_per_kwh)}
                deadline={dateTime(new Date(new Date(b.auto_closed_at).getTime() + 24 * 3_600_000).toISOString())}
              />
            )}
            {mine && (
              <div className="grid gap-1 text-sm" data-testid="my-review">
                <p>Votre note : <Stars value={mine.rating} />{mine.comment ? <span className="text-muted"> « {mine.comment} »</span> : null}</p>
                {!received && (
                  <p className="text-xs text-subtle">
                    Visible quand {asHost ? "le conducteur" : "l'hôte"} aura noté à son tour, ou le {dateTime(reviewDeadline.toISOString())} au plus tard.
                  </p>
                )}
              </div>
            )}
            {received && (
              <p className="text-sm" data-testid="received-review">
                Avis {asHost ? "du conducteur" : "de l'hôte"} : <Stars value={received.rating} />
                {received.comment ? <span className="text-muted"> « {received.comment} »</span> : null}
              </p>
            )}
            {canReview && (
              <ReviewForm bookingId={b.id} targetLabel={asHost ? "le conducteur" : "l'hôte et son spot"} deadline={dateTime(reviewDeadline.toISOString())} />
            )}
            <BookingActions booking={b} asHost={asHost} />
          </article>
        );
      })}
    </section>
  );
}

type Payment = {
  status: PaymentStatus;
  amount_authorized_cents: number;
  amount_captured_cents: number | null;
  payout_status?: PayoutStatus;
  host_amount_cents?: number | null;
};

function PaymentLine({
  payment: p,
  asHost,
}: {
  payment: Payment;
  asHost: boolean;
}) {
  const amount = (cents: number | null) => eur((cents ?? 0) / 100);
  const text: Record<PaymentStatus, string> = {
    requires_authorization: "Carte pas encore validée",
    authorized: `${amount(p.amount_authorized_cents)} bloqués sur la carte (pas encore prélevés)`,
    captured: !asHost
      ? `${amount(p.amount_captured_cents)} payés`
      : p.payout_status === "transferred"
        ? `${amount(p.amount_captured_cents)} encaissés · ${amount(p.host_amount_cents ?? p.amount_captured_cents)} reversés sur votre compte`
        : p.payout_status === "awaiting_host_account"
          ? `${amount(p.amount_captured_cents)} encaissés · reversement en attente : activez vos paiements dans Mes spots`
          : `${amount(p.amount_captured_cents)} encaissés`,
    waived: "Moins de 0,50 € : rien n'a été prélevé",
    canceled: "Montant bloqué libéré, rien n'a été prélevé",
    failed: "Échec du paiement",
  };
  return (
    <p className="text-sm text-muted" data-testid="payment-line">
      💳 {text[p.status]}
    </p>
  );
}
