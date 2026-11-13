import { createClient } from "@/lib/supabase/server";
import { SPOT_COLUMNS, type Spot } from "@/types/db";
import { CONNECTOR_LABELS, eur } from "@/lib/format";
import { SpotForm } from "@/components/spot-form";
import { SpotQr } from "@/components/spot-qr";
import { SpotActiveToggle } from "@/components/spot-active-toggle";

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
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: false });
  const spots = (data ?? []) as Spot[];

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Mes spots</h1>
      {spots.map((s) => (
        <article key={s.id} className={`card grid gap-3 ${s.is_active ? "" : "bg-soft"}`}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className={`font-semibold ${s.is_active ? "" : "text-muted"}`}>{s.title}</p>
              <p className="text-sm text-muted">
                {CONNECTOR_LABELS[s.connector_type]} · {s.power_kw} kW · {eur(s.price_per_kwh)}/kWh
              </p>
            </div>
            <span
              className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${
                s.is_active ? "bg-accent/10 text-accent" : "bg-line text-muted"
              }`}
            >
              {s.is_active ? "Actif" : "Désactivé"}
            </span>
          </div>
          {!s.is_active && <p className="text-sm text-muted">Masqué de la carte : aucune nouvelle réservation possible.</p>}
          {s.is_active && <SpotQr spotId={s.id} title={s.title} />}
          <SpotActiveToggle spotId={s.id} isActive={s.is_active} />
        </article>
      ))}
      <div>
        <h2 className="mb-3 text-lg font-semibold">Ajouter un spot</h2>
        <SpotForm hostId={user!.id} />
      </div>
    </section>
  );
}
