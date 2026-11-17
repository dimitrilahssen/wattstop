// Règle d'annulation : même calcul que la base (public.cancellation_is_free), pour prévenir avant d'agir.

export type CancellationPolicy = {
  payments_required: boolean;
  cancellation_fee_cents: number;
  free_cancellation_minutes: number;
  cancellation_grace_minutes: number;
};

export const DEFAULT_POLICY: CancellationPolicy = {
  payments_required: false,
  cancellation_fee_cents: 0,
  free_cancellation_minutes: 120,
  cancellation_grace_minutes: 10,
};

/** Colonnes à lire dans app_settings. */
export const POLICY_COLUMNS = "payments_required, cancellation_fee_cents, free_cancellation_minutes, cancellation_grace_minutes";

/** Les frais s'appliquent-ils ? (règle active et montant non nul) */
export const feesActive = (p: CancellationPolicy) => p.payments_required && p.cancellation_fee_cents > 0;

/** Fin de l'annulation gratuite d'une réservation acceptée. */
export function freeCancellationUntil(b: { start_at: string; created_at: string }, p: CancellationPolicy): Date {
  const beforeStart = new Date(b.start_at).getTime() - p.free_cancellation_minutes * 60_000;
  const grace = new Date(b.created_at).getTime() + p.cancellation_grace_minutes * 60_000;
  return new Date(Math.max(beforeStart, grace));
}

/** Annuler maintenant, en tant que conducteur, coûterait-il des frais ? */
export function lateCancellation(b: { status: string; start_at: string; created_at: string }, p: CancellationPolicy, now = Date.now()) {
  return feesActive(p) && b.status === "confirmed" && now > freeCancellationUntil(b, p).getTime();
}

/** Texte de la règle, ex. « Annulation gratuite jusqu'à 2 h avant le début. Ensuite, ou en cas d'absence : 2,00 € de frais, reversés à l'hôte. » */
export function policySentence(p: CancellationPolicy) {
  const h = p.free_cancellation_minutes / 60;
  const delay = Number.isInteger(h) ? `${h} h` : `${p.free_cancellation_minutes} min`;
  const fee = (p.cancellation_fee_cents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
  return `Annulation gratuite jusqu'à ${delay} avant le début. Ensuite, ou en cas d'absence : ${fee} de frais, reversés à l'hôte.`;
}
