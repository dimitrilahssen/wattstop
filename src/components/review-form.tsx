"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const HINTS = ["", "Très décevant", "Décevant", "Correct", "Bien", "Excellent"];

/** Noter l'autre partie après une recharge terminée (une seule fois, sous 14 jours). */
export function ReviewForm({ bookingId, targetLabel, deadline }: { bookingId: string; targetLabel: string; deadline: string }) {
  const router = useRouter();
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = hover || rating;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!rating) return setError("Choisissez une note de 1 à 5 étoiles.");
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("submit_review", { p_booking_id: bookingId, p_rating: rating, p_comment: comment || null });
    setBusy(false);
    if (error) return setError(error.message);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid gap-2 rounded-lg bg-soft p-3" data-testid="review-form">
      <p className="text-sm font-medium">⭐ Notez {targetLabel}</p>
      <div className="flex items-center gap-1" role="radiogroup" aria-label="Note" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} étoile${n > 1 ? "s" : ""}`}
            className={`text-3xl leading-none ${n <= shown ? "text-star" : "text-line"}`}
            onMouseEnter={() => setHover(n)}
            onClick={() => setRating(n)}
          >
            ★
          </button>
        ))}
        <span className="ml-2 text-sm text-muted">{HINTS[shown]}</span>
      </div>
      <textarea
        className="input"
        maxLength={500}
        rows={2}
        placeholder="Un mot sur la recharge (facultatif)"
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="btn-primary py-2" disabled={busy || !rating}>{busy ? "…" : "Publier mon avis"}</button>
      <p className="text-xs text-subtle">
        Votre avis reste caché tant que l&apos;autre partie n&apos;a pas noté, au plus tard jusqu&apos;au {deadline}.
      </p>
    </form>
  );
}
