"use client";
import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { NearbySpot } from "@/types/db";
import { CONNECTOR_LABELS, eur } from "@/lib/format";
import { haversine, MAP_STYLE_URL, type LatLng } from "@/lib/geo";

type Props = {
  center: LatLng;
  spots: NearbySpot[];
  /** Appelé quand l'utilisateur demande une recherche sur la zone visible. */
  onSearchArea: (center: LatLng, radiusM: number) => void;
};

/** Construit le contenu d'une popup via le DOM (les titres sont saisis par les hôtes : jamais d'innerHTML). */
function popupContent(s: NearbySpot) {
  const root = document.createElement("div");
  root.className = "ws-popup";
  const title = document.createElement("p");
  title.className = "ws-popup-title";
  title.textContent = s.title;
  const meta = document.createElement("p");
  meta.className = "ws-popup-meta";
  meta.textContent = `${CONNECTOR_LABELS[s.connector_type]} · ${s.power_kw} kW · ${eur(s.price_per_kwh)}/kWh`;
  const link = document.createElement("a");
  link.className = "ws-popup-link";
  link.href = `/spots/${s.id}`;
  link.textContent = "Voir et réserver →";
  root.append(title, meta, link);
  return root;
}

function markerElement(s: NearbySpot) {
  // div + role=button/tabindex (ajoutés par MapLibre) : un <button> natif perd les clics souris sur la carte
  const el = document.createElement("div");
  el.className = "ws-marker";
  el.setAttribute("aria-label", `${s.title}, ${eur(s.price_per_kwh)} par kWh`);
  el.textContent = `⚡ ${eur(s.price_per_kwh)}`;
  return el;
}

export default function SpotsMap({ center, spots, onSearchArea }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const [moved, setMoved] = useState(false);

  // Initialisation (une seule fois)
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: MAP_STYLE_URL,
      center: [center.lng, center.lat],
      zoom: 12,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }),
      "top-right"
    );
    // Seuls les déplacements initiés par l'utilisateur proposent "Rechercher dans cette zone"
    // (détecté au movestart : avec l'inertie, le moveend final n'a plus d'originalEvent)
    let userGesture = false;
    map.on("movestart", (e) => {
      userGesture = Boolean((e as { originalEvent?: Event }).originalEvent);
    });
    map.on("moveend", () => {
      if (userGesture) setMoved(true);
      userGesture = false;
    });
    mapRef.current = map;
    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recentrage quand la position initiale arrive
  useEffect(() => {
    mapRef.current?.jumpTo({ center: [center.lng, center.lat] });
  }, [center.lat, center.lng]);

  // Synchronisation des marqueurs
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markersRef.current.forEach((m) => m.remove());
    // Une seule popup partagée, ouverte explicitement au clic (fiable avec des marqueurs <button>)
    // Décalages par ancrage : le marqueur (≈28 px de haut) est ancré par le bas sur le point
    const MARKER_H = 34;
    const popup = new maplibregl.Popup({
      closeButton: false,
      maxWidth: "240px",
      offset: {
        center: [0, -MARKER_H / 2], top: [0, 0], "top-left": [0, 0], "top-right": [0, 0],
        bottom: [0, -MARKER_H], "bottom-left": [0, -MARKER_H], "bottom-right": [0, -MARKER_H],
        // ±46 px : demi-largeur du marqueur prix
        left: [46, -MARKER_H / 2], right: [-46, -MARKER_H / 2],
      },
    });
    markersRef.current = spots.map((s) => {
      const el = markerElement(s);
      const open = (e: Event) => {
        e.stopPropagation();
        popup.setLngLat([s.lng, s.lat]).setDOMContent(popupContent(s)).addTo(map);
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(e);
        }
      });
      return new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([s.lng, s.lat]).addTo(map);
    });
    return () => {
      popup.remove();
    };
  }, [spots]);

  function searchHere() {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    const ne = map.getBounds().getNorthEast();
    const centerLL = { lat: c.lat, lng: c.lng };
    onSearchArea(centerLL, Math.round(haversine(centerLL, { lat: ne.lat, lng: ne.lng })));
    setMoved(false);
  }

  return (
    <div className="relative h-[62dvh] overflow-hidden rounded-2xl border border-line">
      {/* h-full/w-full et non absolute : MapLibre force position:relative sur son conteneur */}
      <div ref={containerRef} className="h-full w-full" data-testid="map" />
      {moved && (
        <button onClick={searchHere} className="btn-primary absolute top-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap px-3 py-2 text-sm shadow-lg">
          Rechercher dans cette zone
        </button>
      )}
    </div>
  );
}
