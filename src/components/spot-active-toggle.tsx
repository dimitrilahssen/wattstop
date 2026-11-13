"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Désactive / réactive un spot. Un spot désactivé disparaît de la carte et n'accepte
 * plus de réservations ni de démarrage de recharge ; l'historique est conservé.
 */
export function SpotActiveToggle({ spotId, isActive }: { spotId: string; isActive: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setError(null);
    const supabase = createClient();

    if (isActive) {
      // Les réservations à venir ne sont pas annulées automatiquement : on prévient l'hôte.
      const { count } = await supabase
        .from("bookings")
        .select("id", { count: "exact", head: true })
        .eq("spot_id", spotId)
        .in("status", ["pending", "confirmed"]);
      const upcoming = count ?? 0;
      const message =
        upcoming > 0
          ? `Ce spot a ${upcoming} réservation${upcoming > 1 ? "s" : ""} à venir. Une fois désactivé, les conducteurs ne pourront plus démarrer la recharge : pensez à les annuler dans Réservations.\n\nDésactiver quand même ?`
          : "Le spot disparaîtra de la carte et ne pourra plus être réservé. Vous pourrez le réactiver à tout moment.\n\nDésactiver ?";
      if (!confirm(message)) return;
    }

    setBusy(true);
    const { error } = await supabase.from("spots").update({ is_active: !isActive }).eq("id", spotId);
    setBusy(false);
    if (error) return setError(error.message);
    router.refresh();
  }

  return (
    <div className="grid gap-1">
      <button className="btn-ghost py-2" disabled={busy} onClick={toggle}>
        {busy ? "…" : isActive ? "⏸ Désactiver le spot" : "▶ Réactiver le spot"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}
