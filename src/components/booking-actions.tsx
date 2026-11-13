"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Booking } from "@/types/db";

export function BookingActions({ booking, asHost }: { booking: Booking; asHost: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(fn: "respond_booking" | "cancel_booking", args: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc(fn, args);
    setBusy(false);
    if (error) setError(error.message);
    else router.refresh();
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
          <button disabled={busy} className="btn-ghost flex-1 py-2" onClick={() => call("cancel_booking", { p_booking_id: booking.id })}>Annuler</button>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
