import { createClient } from "@/lib/supabase/server";
import { SPOT_COLUMNS, type Spot } from "@/types/db";
import { CONNECTOR_LABELS, eur } from "@/lib/format";
import { SpotForm } from "@/components/spot-form";
import { SpotQr } from "@/components/spot-qr";

export const metadata = { title: "Mes spots" };

export default async function HostPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data } = await supabase
    .from("spots")
    .select(SPOT_COLUMNS)
    .eq("host_id", user!.id)
    .order("created_at", { ascending: false });
  const spots = (data ?? []) as Spot[];

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Mes spots</h1>
      {spots.map((s) => (
        <article key={s.id} className="card grid gap-3">
          <div>
            <p className="font-semibold">{s.title} {!s.is_active && <span className="text-xs text-white/50">(inactif)</span>}</p>
            <p className="text-sm text-white/60">
              {CONNECTOR_LABELS[s.connector_type]} · {s.power_kw} kW · {eur(s.price_per_kwh)}/kWh
            </p>
          </div>
          <SpotQr spotId={s.id} title={s.title} />
        </article>
      ))}
      <div>
        <h2 className="mb-3 text-lg font-semibold">Ajouter un spot</h2>
        <SpotForm hostId={user!.id} />
      </div>
    </section>
  );
}
