"use client";
import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { Booking, ResolvedQr } from "@/types/db";
import { CONNECTOR_LABELS, dateTime, eur } from "@/lib/format";

export function ChargeSession({ qrKey, initial }: { qrKey: string; initial: ResolvedQr }) {
  const { spot, is_host } = initial;
  const [booking, setBooking] = useState(initial.booking);
  const [result, setResult] = useState<Booking | null>(null);
  const [kwh, setKwh] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function checkIn() {
    setBusy(true); setError(null);
    const { data, error } = await createClient().rpc("check_in", { p_qr_key: qrKey });
    setBusy(false);
    if (error) return setError(error.message);
    setBooking({ ...booking!, status: "active", checked_in_at: (data as Booking).checked_in_at });
  }

  async function checkOut(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const { data, error } = await createClient().rpc("check_out", { p_qr_key: qrKey, p_energy_kwh: Number(kwh) });
    setBusy(false);
    if (error) return setError(error.message);
    setResult(data as Booking);
  }

  return (
    <section className="grid gap-4">
      <div className="card">
        <p className="text-xs uppercase tracking-wide text-brand-400">Spot scanné</p>
        <h1 className="text-xl font-bold">{spot.title}</h1>
        <p className="text-sm text-white/60">{spot.address}</p>
        <p className="mt-2 text-sm">{CONNECTOR_LABELS[spot.connector_type]} · {spot.power_kw} kW · {eur(spot.price_per_kwh)}/kWh</p>
        {spot.access_instructions && <p className="mt-3 rounded-lg bg-white/5 p-3 text-sm">🔑 {spot.access_instructions}</p>}
      </div>

      {is_host && <p className="card text-sm">Vous êtes l&apos;hôte de ce spot. Ce QR fonctionne ✅</p>}

      {result ? (
        <div className="card text-center">
          <p className="text-4xl">✅</p>
          <p className="mt-2 text-lg font-semibold">Recharge terminée</p>
          <p className="text-white/70">{result.energy_kwh} kWh · <strong>{eur(result.total_price ?? 0)}</strong></p>
          <Link href="/bookings" className="btn-ghost mt-4 w-full">Voir mes réservations</Link>
        </div>
      ) : !booking ? (
        !is_host && (
          <div className="card grid gap-3 text-sm">
            <p>Aucune réservation confirmée sur ce spot pour le moment.</p>
            <Link href={`/spots/${spot.id}`} className="btn-primary">Réserver ce spot</Link>
          </div>
        )
      ) : booking.status === "confirmed" ? (
        <div className="card grid gap-3">
          <p className="text-sm text-white/70">Créneau : {dateTime(booking.start_at)} → {dateTime(booking.end_at)}</p>
          <button className="btn-primary" disabled={busy} onClick={checkIn}>⚡ Démarrer la recharge</button>
        </div>
      ) : (
        <form onSubmit={checkOut} className="card grid gap-3">
          <p className="text-sm text-white/70">En charge depuis {booking.checked_in_at && dateTime(booking.checked_in_at)}</p>
          <label className="grid gap-1 text-sm">Énergie rechargée (kWh, lue sur le tableau de bord du véhicule)
            <input className="input" type="number" step="0.01" min="0" required value={kwh} onChange={(e) => setKwh(e.target.value)} />
          </label>
          {kwh && <p className="text-sm">Total estimé : <strong>{eur(Number(kwh) * spot.price_per_kwh)}</strong></p>}
          <button className="btn-primary" disabled={busy}>🏁 Terminer la recharge</button>
        </form>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
