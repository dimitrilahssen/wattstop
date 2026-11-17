"use client";
import { useEffect, useState } from "react";
import { formatClosure, formatSlot, weekSummary, type BusySlot, type SpotClosure, type SpotHour } from "@/lib/availability";

/** Fiche du spot : horaires, fermetures à venir et créneaux déjà pris (heure locale de l'appareil). */
export function SpotAvailabilityCard({ hours, closures, busy }: { hours: SpotHour[]; closures: SpotClosure[]; busy: BusySlot[] }) {
  const week = weekSummary(hours);
  // Heures des créneaux pris : affichées après montage, dans le fuseau de l'appareil (pas celui du serveur)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <section className="card grid gap-3" data-testid="spot-availability">
      <h2 className="font-semibold">🕒 Disponibilités</h2>
      {week.length === 0 ? (
        <p className="text-sm text-muted">Disponible à toute heure, 7 jours sur 7.</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          {week.map((w) => (
            <div key={w.days} className="contents">
              <dt className="text-subtle">{w.days}</dt>
              <dd className={w.label === "Fermé" ? "text-muted" : ""}>{w.label}</dd>
            </div>
          ))}
        </dl>
      )}
      {closures.length > 0 && (
        <div className="grid gap-1 text-sm">
          <p className="text-subtle">Fermetures</p>
          {closures.map((c) => (
            <p key={c.id ?? c.starts_on}>
              🚧 {formatClosure(c)}
              {c.reason ? <span className="text-muted"> · {c.reason}</span> : null}
            </p>
          ))}
        </div>
      )}
      {mounted && busy.length > 0 && (
        <div className="grid gap-1 text-sm">
          <p className="text-subtle">Déjà réservé</p>
          {busy.slice(0, 8).map((b) => (
            <p key={b.start_at} className="text-muted">{formatSlot(new Date(b.start_at), new Date(b.end_at))}</p>
          ))}
        </div>
      )}
    </section>
  );
}
