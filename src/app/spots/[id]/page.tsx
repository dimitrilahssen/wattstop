import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SPOT_COLUMNS, type Spot } from "@/types/db";
import { CONNECTOR_LABELS, eur } from "@/lib/format";
import { BookingForm } from "@/components/booking-form";
import { SpotAvailabilityCard } from "@/components/spot-availability-card";
import type { BusySlot, SpotClosure, SpotHour } from "@/lib/availability";

export default async function SpotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: spot } = await supabase.from("spots").select(SPOT_COLUMNS).eq("id", id).maybeSingle<Spot>();
  if (!spot) notFound();

  const today = new Date().toISOString().slice(0, 10);
  const [
    {
      data: { user },
    },
    { data: hours },
    { data: closures },
    { data: busy },
  ] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from("spot_hours").select("weekday, opens, closes").eq("spot_id", id),
    supabase.from("spot_closures").select("id, starts_on, ends_on, reason").eq("spot_id", id).gte("ends_on", today).order("starts_on"),
    supabase.rpc("spot_busy_slots", { p_spot_id: id }),
  ]);
  // Tables absentes (migration pas encore appliquée) : le spot reste réservable à toute heure
  const h = (hours ?? []) as SpotHour[];
  const c = (closures ?? []) as SpotClosure[];
  const b = (busy ?? []) as BusySlot[];

  return (
    <section className="grid gap-4">
      <div>
        <h1 className="text-2xl font-bold">{spot.title}</h1>
        <p className="text-muted">{spot.address}</p>
      </div>
      <div className="card grid grid-cols-3 gap-2 text-center text-sm">
        <div><p className="text-subtle">Prise</p><p className="font-semibold">{CONNECTOR_LABELS[spot.connector_type]}</p></div>
        <div><p className="text-subtle">Puissance</p><p className="font-semibold">{spot.power_kw} kW</p></div>
        <div><p className="text-subtle">Tarif</p><p className="font-semibold">{eur(spot.price_per_kwh)}/kWh</p></div>
      </div>
      {spot.description && <p className="text-muted">{spot.description}</p>}
      <SpotAvailabilityCard hours={h} closures={c} busy={b} />
      {user && user.id !== spot.host_id ? (
        <BookingForm spotId={spot.id} driverId={user.id} hours={h} closures={c} busy={b} />
      ) : !user ? (
        <a href={`/login?next=/spots/${spot.id}`} className="btn-primary">Se connecter pour réserver</a>
      ) : (
        <p className="card text-sm text-muted">C&apos;est votre spot.</p>
      )}
    </section>
  );
}
