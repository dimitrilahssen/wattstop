"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  availabilityChecker,
  formatSlot,
  PROBLEM_LABELS,
  type BusySlot,
  type SpotClosure,
  type SpotHour,
} from "@/lib/availability";

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function BookingForm({
  spotId,
  driverId,
  hours = [],
  closures = [],
  busy = [],
}: {
  spotId: string;
  driverId: string;
  hours?: SpotHour[];
  closures?: SpotClosure[];
  busy?: BusySlot[];
}) {
  const router = useRouter();
  const checker = useMemo(() => availabilityChecker(hours, closures, busy), [hours, closures, busy]);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [noSlot, setNoSlot] = useState(false);

  // Créneau proposé par défaut : le premier libre dans 30 min ou plus (calculé côté navigateur)
  useEffect(() => {
    const slot = checker.nextSlot(Date.now() + 30 * 60_000);
    if (slot) {
      setStart(toLocalInput(slot.start));
      setEnd(toLocalInput(slot.end));
    } else {
      setNoSlot(true);
    }
  }, [checker]);

  const from = start ? new Date(start).getTime() : NaN;
  const to = end ? new Date(end).getTime() : NaN;
  const problem = Number.isFinite(from) && Number.isFinite(to) ? checker.problem(from, to) : null;
  const suggestion = useMemo(
    () => (problem && problem !== "order" && problem !== "too_long" && Number.isFinite(from) ? checker.nextSlot(Math.max(from, Date.now() + 5 * 60_000), Math.max(to - from, 15 * 60_000)) : null),
    [problem, from, to, checker]
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    // host_id, price_per_kwh et status sont imposés par le trigger SQL ; les horaires sont revérifiés par la base.
    const { error } = await createClient().from("bookings").insert({
      spot_id: spotId,
      driver_id: driverId,
      start_at: new Date(start).toISOString(),
      end_at: new Date(end).toISOString(),
      driver_note: note || null,
    });
    setLoading(false);
    if (error) {
      setError(error.code === "23P01" ? "Ce créneau est déjà réservé." : error.message);
      return;
    }
    // Pas de router.refresh() ici : lancé juste après push, il peut annuler la navigation
    // (on reste sur la fiche du spot). /bookings est dynamique, push la charge déjà à jour.
    router.push("/bookings");
  }

  return (
    <form onSubmit={onSubmit} className="card grid gap-3">
      <h2 className="font-semibold">Réserver un créneau</h2>
      {noSlot && <p className="text-sm text-muted">Aucun créneau libre dans les 14 prochains jours.</p>}
      <label className="grid gap-1 text-sm">Début
        <input className="input" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="grid gap-1 text-sm">Fin
        <input className="input" type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
      </label>
      {problem && (
        <div className="grid gap-2 rounded-lg bg-soft p-3 text-sm" role="alert" data-testid="slot-problem">
          <p>⚠️ {PROBLEM_LABELS[problem]}</p>
          {suggestion && (
            <button
              type="button"
              className="btn-ghost py-2"
              onClick={() => {
                setStart(toLocalInput(suggestion.start));
                setEnd(toLocalInput(suggestion.end));
              }}
            >
              Prochain créneau libre : {formatSlot(suggestion.start, suggestion.end)}
            </button>
          )}
        </div>
      )}
      <textarea className="input" maxLength={500} placeholder="Message pour l'hôte (optionnel)" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="btn-primary" disabled={loading || !start || !end || !!problem}>{loading ? "Envoi…" : "Demander la réservation"}</button>
    </form>
  );
}
