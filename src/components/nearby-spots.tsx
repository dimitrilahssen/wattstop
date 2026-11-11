"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { NearbySpot } from "@/types/db";
import { CONNECTOR_LABELS, distance, eur } from "@/lib/format";

const FALLBACK = { lat: 48.8566, lng: 2.3522 }; // Paris si géoloc refusée

export function NearbySpots() {
  const [spots, setSpots] = useState<NearbySpot[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async ({ lat, lng }: { lat: number; lng: number }) => {
      const { data, error } = await createClient().rpc("nearby_spots", { p_lat: lat, p_lng: lng, p_radius_m: 15000 });
      if (error) setError(error.message);
      else setSpots(data as NearbySpot[]);
    };
    if (!("geolocation" in navigator)) return void load(FALLBACK);
    navigator.geolocation.getCurrentPosition(
      (pos) => load({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => load(FALLBACK),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 }
    );
  }, []);

  if (error) return <p className="mt-6 text-red-400">{error}</p>;
  if (!spots) return <p className="mt-6 text-white/60">Localisation…</p>;
  if (spots.length === 0) return <p className="mt-6 text-white/60">Aucun spot dans un rayon de 15 km.</p>;

  return (
    <ul className="mt-6 grid gap-3">
      {spots.map((s) => (
        <li key={s.id}>
          <Link href={`/spots/${s.id}`} className="card flex items-center justify-between gap-3 hover:border-brand-500/50">
            <div>
              <p className="font-semibold">{s.title}</p>
              <p className="text-sm text-white/60">{CONNECTOR_LABELS[s.connector_type]} · {s.power_kw} kW</p>
            </div>
            <div className="text-right">
              <p className="font-semibold text-brand-400">{eur(s.price_per_kwh)}<span className="text-xs text-white/50">/kWh</span></p>
              <p className="text-xs text-white/50">{distance(s.distance_m)}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
