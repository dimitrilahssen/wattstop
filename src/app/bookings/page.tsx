import { createClient } from "@/lib/supabase/server";
import type { Booking } from "@/types/db";
import { dateTime, eur, kwh } from "@/lib/format";
import { BookingActions } from "@/components/booking-actions";
import { paymentsEnabled, type PaymentStatus } from "@/lib/payments";

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
};

export default async function BookingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Applique tout de suite les règles d'expiration (la tâche planifiée ne passe que toutes les 5 min)
  await supabase.rpc("expire_bookings");

  // La RLS ne renvoie que les réservations où l'on est conducteur OU hôte.
  const { data } = await supabase
    .from("bookings")
    .select("*, spot:spots(title, address), driver:profiles!bookings_driver_id_fkey(full_name), payment:payments(status, amount_authorized_cents, amount_captured_cents)")
    .order("start_at", { ascending: false })
    .limit(50);

  const bookings = (data ?? []) as (Booking & {
    spot: { title: string; address: string } | null;
    driver: { full_name: string | null } | null;
    payment: { status: PaymentStatus; amount_authorized_cents: number; amount_captured_cents: number | null } | null;
  })[];

  // Filet de sécurité : une recharge terminée dont le montant est encore seulement bloqué
  // (page fermée trop tôt…) est prélevée maintenant. Le montant vient de la base, pas du client.
  const toCapture = paymentsEnabled ? bookings.filter((b) => b.status === "completed" && b.payment?.status === "authorized") : [];
  if (toCapture.length) {
    await Promise.all(toCapture.map((b) => supabase.functions.invoke("payments", { body: { action: "capture", booking_id: b.id } })));
    const { data: fresh } = await supabase
      .from("payments")
      .select("booking_id, status, amount_authorized_cents, amount_captured_cents")
      .in("booking_id", toCapture.map((b) => b.id));
    for (const p of fresh ?? []) {
      const b = bookings.find((x) => x.id === p.booking_id);
      if (b) b.payment = p as (typeof bookings)[number]["payment"];
    }
  }

  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold">Réservations</h1>
      {bookings.length === 0 && <p className="text-muted">Aucune réservation pour l&apos;instant.</p>}
      {bookings.map((b) => {
        const asHost = b.host_id === user?.id;
        return (
          <article key={b.id} className="card grid gap-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{b.spot?.title}</p>
                <p className="text-xs text-subtle">
                  {asHost ? `Conducteur : ${b.driver?.full_name ?? "sans nom"}` : "Vous êtes le conducteur"}
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
            <BookingActions booking={b} asHost={asHost} />
          </article>
        );
      })}
    </section>
  );
}

function PaymentLine({
  payment: p,
  asHost,
}: {
  payment: { status: PaymentStatus; amount_authorized_cents: number; amount_captured_cents: number | null };
  asHost: boolean;
}) {
  const amount = (cents: number | null) => eur((cents ?? 0) / 100);
  const text: Record<PaymentStatus, string> = {
    requires_authorization: "Carte pas encore validée",
    authorized: `${amount(p.amount_authorized_cents)} bloqués sur la carte (pas encore prélevés)`,
    captured: asHost ? `${amount(p.amount_captured_cents)} encaissés` : `${amount(p.amount_captured_cents)} payés`,
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
