"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function BookingForm({ spotId, driverId }: { spotId: string; driverId: string }) {
  const router = useRouter();
  const now = new Date();
  const [start, setStart] = useState(toLocalInput(new Date(now.getTime() + 30 * 60_000)));
  const [end, setEnd] = useState(toLocalInput(new Date(now.getTime() + 150 * 60_000)));
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    // host_id, price_per_kwh et status sont imposés par le trigger SQL.
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
      <label className="grid gap-1 text-sm">Début
        <input className="input" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="grid gap-1 text-sm">Fin
        <input className="input" type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
      </label>
      <textarea className="input" maxLength={500} placeholder="Message pour l'hôte (optionnel)" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="btn-primary" disabled={loading}>{loading ? "Envoi…" : "Demander la réservation"}</button>
    </form>
  );
}
