"use client";
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { NearbySpot } from "@/types/db";
import { CONNECTOR_LABELS, distance, eur } from "@/lib/format";
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

  const search = useCallback(async (c: LatLng, radiusM: number) => {
    setLoading(true);
    setError(null);
    const { data, error } = await createClient().rpc("nearby_spots", {
      p_lat: c.lat,
      p_lng: c.lng,
      p_radius_m: radiusM,
      p_limit: 200,
    });
    setLoading(false);
    if (error) setError(error.message);
    else setSpots((data ?? []) as NearbySpot[]);
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
          {loading ? "Recherche…" : `${spots.length} spot${spots.length > 1 ? "s" : ""}`}
        </p>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      {!center ? (
        <div className="h-[62dvh] animate-pulse rounded-2xl bg-soft" aria-label="Localisation…" />
      ) : view === "map" ? (
        <SpotsMap center={center} spots={spots} onSearchArea={search} />
      ) : (
        <SpotList spots={spots} loading={loading} />
      )}
    </div>
  );
}

function SpotList({ spots, loading }: { spots: NearbySpot[]; loading: boolean }) {
  if (!loading && spots.length === 0) return <p className="text-muted">Aucun spot dans cette zone.</p>;
  return (
    <ul className="grid gap-3">
      {spots.map((s) => (
        <li key={s.id}>
          <Link href={`/spots/${s.id}`} className="card flex items-center justify-between gap-3 hover:border-accent/50">
            <div>
              <p className="font-semibold">{s.title}</p>
              <p className="text-sm text-muted">{CONNECTOR_LABELS[s.connector_type]} · {s.power_kw} kW</p>
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
