"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Booking } from "@/types/db";
import { markSelfAction } from "@/lib/live-store";
import { callPayments, paymentsEnabled } from "@/lib/payments";
import { lateCancellation, type CancellationPolicy } from "@/lib/cancellation";
import { eur } from "@/lib/format";

export function BookingActions({ booking, asHost, policy }: { booking: Booking; asHost: boolean; policy?: CancellationPolicy }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Annulation tardive par le conducteur : on demande confirmation en affichant les frais
  const [confirmFee, setConfirmFee] = useState(false);

  async function call(fn: "respond_booking" | "cancel_booking", args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    // Pas de notification temps réel pour sa propre action
    const target = fn === "cancel_booking" ? "cancelled" : args.p_accept ? "confirmed" : "rejected";
    markSelfAction(booking.id, target);
    const { error } = await createClient().rpc(fn, args);
    setBusy(false);
    if (error) return setError(error.message);
    // Une réservation annulée ne doit pas garder d'argent bloqué sur la carte
    if (fn === "cancel_booking" && paymentsEnabled) await callPayments("release", booking.id).catch(() => {});
    router.refresh();
  }

  const canCancel = booking.status === "pending" || booking.status === "confirmed";
  if (!canCancel) return null;

  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        {asHost && booking.status === "pending" && (
          <>
            <button disabled={busy} className="btn-primary flex-1 py-2" onClick={() => call("respond_booking", { p_booking_id: booking.id, p_accept: true })}>Accepter</button>
            <button disabled={busy} className="btn-ghost flex-1 py-2" onClick={() => call("respond_booking", { p_booking_id: booking.id, p_accept: false })}>Refuser</button>
          </>
        )}
        {(!asHost || booking.status === "confirmed") && (
          <button
            disabled={busy}
            className="btn-ghost flex-1 py-2"
            onClick={() => {
              if (!asHost && policy && lateCancellation(booking, policy)) return setConfirmFee(true);
              call("cancel_booking", { p_booking_id: booking.id });
            }}
          >
            Annuler
          </button>
        )}
      </div>
      {confirmFee && policy && (
        <div role="alertdialog" aria-label="Annulation tardive" className="grid gap-2 rounded-lg bg-soft p-3 text-sm" data-testid="late-cancel">
          <p>
            Annuler maintenant coûte <strong>{eur(policy.cancellation_fee_cents / 100)}</strong>, prélevés sur votre carte et reversés à l&apos;hôte
            (moins de {Math.round(policy.free_cancellation_minutes / 60)} h avant le début).
          </p>
          <div className="flex gap-2">
            <button disabled={busy} className="btn-primary flex-1 py-2" onClick={() => call("cancel_booking", { p_booking_id: booking.id })}>
              Annuler quand même
            </button>
            <button disabled={busy} className="btn-ghost flex-1 py-2" onClick={() => setConfirmFee(false)}>
              Garder ma réservation
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
