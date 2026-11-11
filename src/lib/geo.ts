export type LatLng = { lat: number; lng: number };

/** Repli si la géolocalisation est refusée : Paris. */
export const FALLBACK_CENTER: LatLng = { lat: 48.8566, lng: 2.3522 };

/** Distance en mètres (haversine). */
export function haversine(a: LatLng, b: LatLng) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Style de carte MapLibre. Par défaut : OpenFreeMap (gratuit, sans clé API). */
export const MAP_STYLE_URL =
  process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/dark";
