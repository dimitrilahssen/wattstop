import { createClient } from "@/lib/supabase/server";
import type { Booking } from "@/types/db";
import { dateTime, eur } from "@/lib/format";
import { BookingActions } from "@/components/booking-actions";

export const metadata = { title: "Mes réservations" };

const STATUS_LABEL: Record<Booking["status"], string> = {
  pending: "En attente",
  confirmed: "Confirmée",
  active: "En charge",
  completed: "Terminée",
  cancelled: "Annulée",
  rejected: "Refusée",
};

export default async function BookingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // La RLS ne renvoie que les réservations où l'on est conducteur OU hôte.
  const { data } = await supabase
    .from("bookings")
    .select("*, spot:spots(title, address)")
    .order("start_at", { ascending: false })
    .limit(50);

  const bookings = (data ?? []) as (Booking & { spot: { title: string; address: string } | null })[];

  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold">Réservations</h1>
      {bookings.length === 0 && <p className="text-white/60">Aucune réservation pour l&apos;instant.</p>}
      {bookings.map((b) => {
        const asHost = b.host_id === user?.id;
        return (
          <article key={b.id} className="card grid gap-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{b.spot?.title}</p>
                <p className="text-xs text-white/50">{asHost ? "Vous êtes l'hôte" : "Vous êtes le conducteur"}</p>
              </div>
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{STATUS_LABEL[b.status]}</span>
            </div>
            <p className="text-sm text-white/70">{dateTime(b.start_at)} → {dateTime(b.end_at)}</p>
            {b.status === "completed" && b.total_price != null && (
              <p className="text-sm">{b.energy_kwh} kWh · <strong>{eur(b.total_price)}</strong></p>
            )}
            <BookingActions booking={b} asHost={asHost} />
          </article>
        );
      })}
    </section>
  );
}
