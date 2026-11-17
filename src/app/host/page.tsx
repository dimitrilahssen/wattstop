import { createClient } from "@/lib/supabase/server";
import { SPOT_COLUMNS, type Spot } from "@/types/db";
import { CONNECTOR_LABELS, eur } from "@/lib/format";
import { SpotForm } from "@/components/spot-form";
import { SpotQr } from "@/components/spot-qr";
import { SpotActiveToggle } from "@/components/spot-active-toggle";
import { HostPayouts } from "@/components/host-payouts";
import { SpotHoursEditor } from "@/components/spot-hours-editor";
import type { SpotClosure, SpotHour } from "@/lib/availability";
import { Suspense } from "react";

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

  // Horaires et fermetures à venir de tous les spots (vides si la migration n'est pas encore appliquée)
  const ids = spots.map((s) => s.id);
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: hoursRows }, { data: closureRows }] = ids.length
    ? await Promise.all([
        supabase.from("spot_hours").select("spot_id, weekday, opens, closes").in("spot_id", ids),
        supabase.from("spot_closures").select("id, spot_id, starts_on, ends_on, reason").in("spot_id", ids).gte("ends_on", today).order("starts_on"),
      ])
    : [{ data: [] }, { data: [] }];
  const hoursOf = (id: string) => ((hoursRows ?? []) as (SpotHour & { spot_id: string })[]).filter((h) => h.spot_id === id);
  const closuresOf = (id: string) => ((closureRows ?? []) as (SpotClosure & { spot_id: string })[]).filter((c) => c.spot_id === id);

  return (
    <section className="grid gap-6">
      <h1 className="text-2xl font-bold">Mes spots</h1>
      {/* useSearchParams (retour du formulaire Stripe) exige une frontière Suspense */}
      <Suspense fallback={null}>
        <HostPayouts />
      </Suspense>
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
          {s.is_active && <SpotHoursEditor spotId={s.id} hours={hoursOf(s.id)} closures={closuresOf(s.id)} />}
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
