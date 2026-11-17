import { stars } from "@/lib/ratings";

/** Note affichée en étoiles, lisible par les lecteurs d'écran. */
export function Stars({ value, className = "" }: { value: number; className?: string }) {
  return (
    <span className={`tracking-tight text-star ${className}`} role="img" aria-label={`${value} sur 5`}>
      {stars(value)}
    </span>
  );
}
