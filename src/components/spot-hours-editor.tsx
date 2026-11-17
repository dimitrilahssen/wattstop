"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DAY_LONG, formatClosure, hhmm, weekSummary, type SpotClosure, type SpotHour } from "@/lib/availability";

type Range = { opens: string; closes: string };
type Week = Range[][]; // index 0 = lundi

const toWeek = (hours: SpotHour[]): Week =>
  DAY_LONG.map((_, i) =>
    hours
      .filter((h) => h.weekday === i + 1)
      .map((h) => ({ opens: hhmm(h.opens), closes: hhmm(h.closes) }))
      .sort((a, b) => a.opens.localeCompare(b.opens))
  );

const PRESETS: { label: string; week: Week }[] = [
  {
    label: "Soirs et nuits en semaine, week-end entier",
    week: DAY_LONG.map((_, i) => (i < 4 ? [{ opens: "18:00", closes: "08:00" }] : i === 4 ? [{ opens: "18:00", closes: "00:00" }] : [{ opens: "00:00", closes: "00:00" }])),
  },
  { label: "Tous les jours 8 h → 20 h", week: DAY_LONG.map(() => [{ opens: "08:00", closes: "20:00" }]) },
];

/**
 * Hôte : horaires hebdomadaires (remplacés d'un bloc par set_spot_hours) et fermetures ponctuelles.
 * Plage dont la fin est avant le début : elle se termine le lendemain. 00:00 → 00:00 : toute la journée.
 */
export function SpotHoursEditor({ spotId, hours, closures }: { spotId: string; hours: SpotHour[]; closures: SpotClosure[] }) {
  const router = useRouter();
  const [always, setAlways] = useState(hours.length === 0);
  const [week, setWeek] = useState<Week>(() => (hours.length ? toWeek(hours) : PRESETS[0].week));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [closure, setClosure] = useState({ starts_on: "", ends_on: "", reason: "" });

  const summary = weekSummary(hours);
  const update = (day: number, fn: (r: Range[]) => Range[]) => setWeek((w) => w.map((r, i) => (i === day ? fn(r) : r)));

  async function save() {
    setBusy(true);
    setMessage(null);
    const payload = always ? [] : week.flatMap((ranges, i) => ranges.map((r) => ({ weekday: i + 1, ...r })));
    if (!always && payload.length === 0) {
      setBusy(false);
      return setMessage({ ok: false, text: "Ajoutez au moins une plage, ou choisissez « À toute heure »." });
    }
    const { error } = await createClient().rpc("set_spot_hours", { p_spot_id: spotId, p_hours: payload });
    setBusy(false);
    if (error) return setMessage({ ok: false, text: error.message });
    setMessage({ ok: true, text: "Horaires enregistrés." });
    router.refresh();
  }

  async function addClosure(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const ends_on = closure.ends_on || closure.starts_on;
    if (ends_on < closure.starts_on) return setMessage({ ok: false, text: "La date de fin doit suivre la date de début." });
    const { error } = await createClient()
      .from("spot_closures")
      .insert({ spot_id: spotId, starts_on: closure.starts_on, ends_on, reason: closure.reason || null });
    if (error) return setMessage({ ok: false, text: error.message });
    setClosure({ starts_on: "", ends_on: "", reason: "" });
    router.refresh();
  }

  async function removeClosure(id: string) {
    const { error } = await createClient().from("spot_closures").delete().eq("id", id);
    if (error) return setMessage({ ok: false, text: error.message });
    router.refresh();
  }

  return (
    <details className="grid gap-3 rounded-xl border border-line p-3" data-testid="spot-hours">
      <summary className="cursor-pointer list-none">
        <span className="font-medium">🕒 Horaires et fermetures</span>
        <span className="block text-sm text-muted">
          {summary.length === 0 ? "Disponible à toute heure" : summary.map((s) => `${s.days} : ${s.label}`).join(" · ")}
          {closures.length > 0 ? ` · ${closures.length} fermeture${closures.length > 1 ? "s" : ""} prévue${closures.length > 1 ? "s" : ""}` : ""}
        </span>
      </summary>

      <div className="mt-3 grid gap-3">
        <fieldset className="grid gap-2 text-sm">
          <legend className="sr-only">Disponibilité</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name={`mode-${spotId}`} checked={always} onChange={() => setAlways(true)} /> À toute heure
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name={`mode-${spotId}`} checked={!always} onChange={() => setAlways(false)} /> Selon des horaires
          </label>
        </fieldset>

        {!always && (
          <div className="grid gap-3">
            <div className="flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button key={p.label} type="button" className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-accent/50" onClick={() => setWeek(p.week)}>
                  {p.label}
                </button>
              ))}
            </div>
            {week.map((ranges, day) => (
              <div key={day} className="grid gap-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{DAY_LONG[day]}</p>
                  <div className="flex gap-3 text-xs">
                    {day > 0 && (
                      <button type="button" className="text-muted hover:text-accent" onClick={() => update(day, () => week[day - 1].map((r) => ({ ...r })))}>
                        Comme la veille
                      </button>
                    )}
                    <button type="button" className="text-accent" onClick={() => update(day, (r) => [...r, { opens: "18:00", closes: "22:00" }])}>
                      + Plage
                    </button>
                  </div>
                </div>
                {ranges.length === 0 && <p className="text-sm text-subtle">Fermé</p>}
                {ranges.map((r, k) => (
                  <div key={k} className="flex flex-wrap items-center gap-2 text-sm">
                    <input
                      className="input w-28 py-1.5"
                      type="time"
                      aria-label={`${DAY_LONG[day]} : début de la plage ${k + 1}`}
                      value={r.opens}
                      onChange={(e) => update(day, (rs) => rs.map((x, j) => (j === k ? { ...x, opens: e.target.value } : x)))}
                    />
                    →
                    <input
                      className="input w-28 py-1.5"
                      type="time"
                      aria-label={`${DAY_LONG[day]} : fin de la plage ${k + 1}`}
                      value={r.closes}
                      onChange={(e) => update(day, (rs) => rs.map((x, j) => (j === k ? { ...x, closes: e.target.value } : x)))}
                    />
                    {r.closes <= r.opens && r.closes !== "00:00" && <span className="text-xs text-subtle">le lendemain</span>}
                    {r.opens === "00:00" && r.closes === "00:00" && <span className="text-xs text-subtle">toute la journée</span>}
                    <button
                      type="button"
                      className="ml-auto text-muted hover:text-danger"
                      aria-label={`Retirer la plage ${k + 1} du ${DAY_LONG[day].toLowerCase()}`}
                      onClick={() => update(day, (rs) => rs.filter((_, j) => j !== k))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}

        <button type="button" className="btn-primary py-2" disabled={busy} onClick={save}>
          {busy ? "…" : "Enregistrer les horaires"}
        </button>

        <div className="grid gap-2 border-t border-line pt-3">
          <p className="text-sm font-medium">Fermetures ponctuelles</p>
          {closures.length === 0 && <p className="text-sm text-subtle">Aucune fermeture prévue.</p>}
          {closures.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                🚧 {formatClosure(c)}
                {c.reason ? <span className="text-muted"> · {c.reason}</span> : null}
              </span>
              <button type="button" className="text-muted hover:text-danger" onClick={() => removeClosure(c.id!)}>
                Retirer
              </button>
            </div>
          ))}
          <form onSubmit={addClosure} className="grid gap-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-sm">Du
                <input className="input py-1.5" type="date" required value={closure.starts_on} onChange={(e) => setClosure({ ...closure, starts_on: e.target.value })} />
              </label>
              <label className="grid gap-1 text-sm">Au (inclus)
                <input className="input py-1.5" type="date" value={closure.ends_on} min={closure.starts_on || undefined} onChange={(e) => setClosure({ ...closure, ends_on: e.target.value })} />
              </label>
            </div>
            <input className="input py-1.5" maxLength={200} placeholder="Motif (optionnel, visible des conducteurs)" value={closure.reason} onChange={(e) => setClosure({ ...closure, reason: e.target.value })} />
            <button className="btn-ghost py-2">Ajouter une fermeture</button>
          </form>
        </div>

        {message && <p className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>{message.text}</p>}
        <p className="text-xs text-subtle">Les réservations déjà acceptées ne sont pas modifiées.</p>
      </div>
    </details>
  );
}
