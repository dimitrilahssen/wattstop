import { Stars } from "@/components/stars";
import { ratingLabel, type SpotRating, type SpotReview } from "@/lib/ratings";

const monthYear = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "Europe/Paris" });

/** Fiche du spot : note moyenne, note de l'hôte et derniers avis des conducteurs. */
export function SpotReviews({ rating, hostLabel, reviews }: { rating: SpotRating | null; hostLabel: string | null; reviews: SpotReview[] }) {
  const label = ratingLabel(rating?.avg_rating, rating?.review_count);
  return (
    <section className="card grid gap-3" data-testid="spot-reviews">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">⭐ Avis</h2>
        <p className="text-sm text-star">{label ?? <span className="text-muted">Pas encore d&apos;avis</span>}</p>
      </div>
      {hostLabel && <p className="text-sm text-muted">L&apos;hôte : {hostLabel} (tous ses spots)</p>}
      {reviews.length > 0 && (
        <ul className="grid gap-3">
          {reviews.map((r) => (
            <li key={r.id} className="grid gap-0.5 border-t border-line pt-3 text-sm first:border-0 first:pt-0">
              <p>
                <Stars value={r.rating} /> <span className="text-subtle">· {r.author_first_name ?? "Un conducteur"}, {monthYear(r.created_at)}</span>
              </p>
              {r.comment && <p className="text-muted">{r.comment}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
