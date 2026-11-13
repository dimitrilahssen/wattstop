"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CONNECTOR_LABELS } from "@/lib/format";

export function SpotForm({ hostId }: { hostId: string }) {
  const router = useRouter();
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [published, setPublished] = useState<string | null>(null);

  function locate() {
    navigator.geolocation.getCurrentPosition(
      (p) => setCoords({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => setError("Géolocalisation refusée"),
      { enableHighAccuracy: true }
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!coords) return setError("Positionnez d'abord le spot.");
    // À capturer avant l'await : React remet e.currentTarget à null ensuite
    const form = e.currentTarget;
    const f = new FormData(form);
    setLoading(true);
    setError(null);
    setPublished(null);
    // Pas de .select() : qr_key n'est pas lisible, on liste explicitement les colonnes ailleurs.
    const { error } = await createClient().from("spots").insert({
      host_id: hostId,
      title: f.get("title"),
      address: f.get("address"),
      description: f.get("description") || null,
      access_instructions: f.get("access_instructions") || null,
      connector_type: f.get("connector_type"),
      power_kw: Number(f.get("power_kw")),
      price_per_kwh: Number(f.get("price_per_kwh")),
      location: `SRID=4326;POINT(${coords.lng} ${coords.lat})`,
    });
    setLoading(false);
    if (error) return setError(error.message);
    form.reset();
    setCoords(null);
    setPublished(String(f.get("title")));
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="card grid gap-3">
      <input className="input" name="title" required minLength={3} maxLength={120} placeholder="Ex. Garage rue des Lilas" />
      <input className="input" name="address" required maxLength={300} placeholder="Adresse" />
      <div className="grid grid-cols-2 gap-3">
        <select className="input" name="connector_type" defaultValue="type2">
          {Object.entries(CONNECTOR_LABELS).map(([v, l]) => <option key={v} value={v} className="text-black">{l}</option>)}
        </select>
        <input className="input" name="power_kw" type="number" step="0.1" min="1" max="350" required placeholder="kW (ex. 7.4)" />
      </div>
      <input className="input" name="price_per_kwh" type="number" step="0.01" min="0" max="5" required placeholder="Prix €/kWh (ex. 0.30)" />
      <textarea className="input" name="description" maxLength={2000} placeholder="Description" />
      <textarea className="input" name="access_instructions" maxLength={2000} placeholder="Instructions d'accès (visibles après scan)" />
      <button type="button" className="btn-ghost" onClick={locate}>
        {coords ? `📍 ${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : "📍 Utiliser ma position actuelle"}
      </button>
      {error && <p className="text-sm text-danger">{error}</p>}
      {published && <p role="status" className="text-sm text-accent">✅ « {published} » est publié. Affichez son QR code ci-dessus pour l&apos;imprimer.</p>}
      <button className="btn-primary" disabled={loading}>{loading ? "Création…" : "Publier le spot"}</button>
    </form>
  );
}
