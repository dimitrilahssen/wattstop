"use client";
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { NearbySpot } from "@/types/db";
import { CONNECTOR_LABELS, distance, eur } from "@/lib/format";
import { ratingLabel, type SpotRating } from "@/lib/ratings";
import { FALLBACK_CENTER, type LatLng } from "@/lib/geo";

// MapLibre manipule window/WebGL : chargé uniquement côté client, et seulement en vue carte.
const SpotsMap = dynamic(() => import("./spots-map"), {
  ssr: false,
  loading: () => <div className="h-[62dvh] animate-pulse rounded-2xl bg-soft" />,
});

const DEFAULT_RADIUS_M = 15_000;
type View = "map" | "list";

export function SpotsExplorer() {
  const [view, setView] = useState<View>("map");
  const [center, setCenter] = useState<LatLng | null>(null);
  const [spots, setSpots] = useState<NearbySpot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Spots où l'on peut démarrer une recharge d'au moins 1 h maintenant (null : inconnu)
  const [openNow, setOpenNow] = useState<Set<string> | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [ratings, setRatings] = useState<Map<string, SpotRating>>(new Map());

  const search = useCallback(async (c: LatLng, radiusM: number) => {
    setLoading(true);
    setError(null);
    const { data, error } = await createClient().rpc("nearby_spots", {
      p_lat: c.lat,
      p_lng: c.lng,
      p_radius_m: radiusM,
      p_limit: 200,
    });
    if (error) {
      setLoading(false);
      return setError(error.message);
    }
    const found = (data ?? []) as NearbySpot[];
    const ids = found.map((s) => s.id);
    const [open, rated] = found.length
      ? await Promise.all([
          createClient().rpc("spots_open_now", { p_ids: ids }),
          createClient().rpc("spot_ratings", { p_ids: ids }),
        ])
      : [{ data: [], error: null }, { data: [], error: null }];
    setRatings(new Map(((rated.data ?? []) as SpotRating[]).map((r) => [r.spot_id, r])));
    setOpenNow(open.error ? null : new Set((open.data ?? []) as string[]));
    setSpots(found);
    setLoading(false);
  }, []);

  // Position initiale
  useEffect(() => {
    const start = (c: LatLng) => {
      setCenter(c);
      search(c, DEFAULT_RADIUS_M);
    };
    if (!("geolocation" in navigator)) return start(FALLBACK_CENTER);
    navigator.geolocation.getCurrentPosition(
      (p) => start({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => start(FALLBACK_CENTER),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
    );
  }, [search]);

  const shown = onlyOpen && openNow ? spots.filter((s) => openNow.has(s.id)) : spots;

  return (
    <div className="mt-4 grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <div role="tablist" aria-label="Affichage" className="inline-flex rounded-xl border border-line p-1 text-sm">
          {(["map", "list"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`rounded-lg px-3 py-1.5 font-medium ${view === v ? "bg-accent text-white" : "text-muted"}`}
            >
              {v === "map" ? "Carte" : "Liste"}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted" aria-live="polite">
          {loading ? "Recherche…" : `${shown.length} spot${shown.length > 1 ? "s" : ""}`}
        </p>
      </div>
      {openNow && (
        <button
          type="button"
          aria-pressed={onlyOpen}
          onClick={() => setOnlyOpen((v) => !v)}
          className={`justify-self-start rounded-full border px-3 py-1 text-sm ${onlyOpen ? "border-accent bg-accent/10 font-medium text-accent" : "border-line text-muted"}`}
        >
          {onlyOpen ? "✓ " : ""}Disponible maintenant
        </button>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      {!center ? (
        <div className="h-[62dvh] animate-pulse rounded-2xl bg-soft" aria-label="Localisation…" />
      ) : view === "map" ? (
        <SpotsMap center={center} spots={shown} onSearchArea={search} />
      ) : (
        <SpotList spots={shown} loading={loading} openNow={openNow} ratings={ratings} />
      )}
    </div>
  );
}

function SpotList({ spots, loading, openNow, ratings }: { spots: NearbySpot[]; loading: boolean; openNow: Set<string> | null; ratings: Map<string, SpotRating> }) {
  if (!loading && spots.length === 0) return <p className="text-muted">Aucun spot disponible dans cette zone.</p>;
  return (
    <ul className="grid gap-3">
      {spots.map((s) => (
        <li key={s.id}>
          <Link href={`/spots/${s.id}`} className="card flex items-center justify-between gap-3 hover:border-accent/50">
            <div>
              <p className="font-semibold">{s.title}</p>
              <p className="text-sm text-muted">{CONNECTOR_LABELS[s.connector_type]} · {s.power_kw} kW</p>
              {ratings.get(s.id) && (
                <p className="text-xs text-star">{ratingLabel(ratings.get(s.id)!.avg_rating, ratings.get(s.id)!.review_count)}</p>
              )}
              {openNow && (
                <p className={`text-xs ${openNow.has(s.id) ? "text-accent" : "text-subtle"}`}>
                  {openNow.has(s.id) ? "● Libre maintenant" : "Pas disponible maintenant"}
                </p>
              )}
            </div>
            <div className="text-right">
              <p className="font-semibold text-accent">{eur(s.price_per_kwh)}<span className="text-xs text-subtle">/kWh</span></p>
              <p className="text-xs text-subtle">{distance(s.distance_m)}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
