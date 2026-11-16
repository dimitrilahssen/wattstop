"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callPayments, paymentsEnabled } from "@/lib/payments";
import { eur, kwh } from "@/lib/format";
import { markSelfAction } from "@/lib/live-store";

/**
 * Recharge oubliée : l'hôte déclare les kWh lus sur son compteur.
 * Le plafond affiché est celui que la base applique (puissance × durée branchée × 1,05).
 */
export function MeterDeclaration({
  bookingId,
  maxKwh,
  pricePerKwh,
  deadline,
}: {
  bookingId: string;
  maxKwh: number;
  pricePerKwh: number;
  deadline: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const energy = Number(value.replace(",", "."));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    markSelfAction(bookingId, "completed");
    const { error } = await createClient().rpc("declare_meter", { p_booking_id: bookingId, p_energy_kwh: energy });
    if (error) {
      setBusy(false);
      return setError(error.message);
    }
    // Comme une recharge terminée normalement : prélèvement du montant réel puis reversement
    if (paymentsEnabled) await callPayments("capture", bookingId).catch((err: Error) => setError(err.message));
    setBusy(false);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid gap-2 rounded-lg bg-soft p-3" data-testid="meter-declaration">
      <p className="text-sm">
        Le conducteur n&apos;a pas terminé la recharge. Relevez les kWh sur votre compteur (au plus {kwh(maxKwh)}) avant le{" "}
        {deadline} : sans relevé, la recharge ne sera pas facturée.
      </p>
      <div className="flex gap-2">
        <label className="sr-only" htmlFor={`meter-${bookingId}`}>kWh relevés</label>
        <input
          id={`meter-${bookingId}`}
          className="input flex-1"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          max={maxKwh}
          required
          placeholder="kWh relevés"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="btn-primary py-2" disabled={busy || !value}>
          {busy ? "…" : "Déclarer"}
        </button>
      </div>
      {value && Number.isFinite(energy) && <p className="text-sm text-muted">Montant : {eur(energy * pricePerKwh)}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
    </form>
  );
}
