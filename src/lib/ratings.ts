// Avis et notes : types et mise en forme partagés (pages serveur et composants client).

export type ProfileRating = { user_id: string; host_avg: number | null; host_count: number; driver_avg: number | null; driver_count: number };
export type SpotRating = { spot_id: string; avg_rating: number; review_count: number };
export type SpotReview = { id: string; rating: number; comment: string | null; created_at: string; author_first_name: string | null };
export type Review = { id: string; booking_id: string; author_id: string; target_id: string; author_role: "driver" | "host"; rating: number; comment: string | null; created_at: string };

/** Délai pour noter après la fin de la recharge (identique à la base). */
export const REVIEW_DAYS = 14;

export const stars = (n: number) => "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n));

/** « ★ 4,8 · 12 avis », ou null s'il n'y a pas encore d'avis. */
export function ratingLabel(avg: number | null | undefined, count: number | null | undefined): string | null {
  if (!count || avg == null) return null;
  return `★ ${Number(avg).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} · ${count} avis`;
}
