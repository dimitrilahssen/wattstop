import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SPOT_COLUMNS, type Spot } from "@/types/db";
import { CONNECTOR_LABELS, eur } from "@/lib/format";
import { BookingForm } from "@/components/booking-form";

export default async function SpotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: spot } = await supabase.from("spots").select(SPOT_COLUMNS).eq("id", id).maybeSingle<Spot>();
  if (!spot) notFound();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <section className="grid gap-4">
      <div>
        <h1 className="text-2xl font-bold">{spot.title}</h1>
        <p className="text-white/60">{spot.address}</p>
      </div>
      <div className="card grid grid-cols-3 gap-2 text-center text-sm">
        <div><p className="text-white/50">Prise</p><p className="font-semibold">{CONNECTOR_LABELS[spot.connector_type]}</p></div>
        <div><p className="text-white/50">Puissance</p><p className="font-semibold">{spot.power_kw} kW</p></div>
        <div><p className="text-white/50">Tarif</p><p className="font-semibold">{eur(spot.price_per_kwh)}/kWh</p></div>
      </div>
      {spot.description && <p className="text-white/80">{spot.description}</p>}
      {user && user.id !== spot.host_id ? (
        <BookingForm spotId={spot.id} driverId={user.id} />
      ) : !user ? (
        <a href={`/login?next=/spots/${spot.id}`} className="btn-primary">Se connecter pour réserver</a>
      ) : (
        <p className="card text-sm text-white/60">C&apos;est votre spot.</p>
      )}
    </section>
  );
}
