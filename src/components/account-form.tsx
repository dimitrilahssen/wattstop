"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/** Prénom (obligatoire pour réserver ou publier un spot) et véhicule (facultatif). */
export function AccountForm({ email, fullName, vehicle, next }: { email: string; fullName: string; vehicle: string; next: string | null }) {
  const router = useRouter();
  const [name, setName] = useState(fullName);
  const [car, setCar] = useState(vehicle);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const full_name = name.trim().replace(/\s+/g, " ");
    if (!full_name) return setMessage({ ok: false, text: "Indiquez au moins votre prénom." });
    setBusy(true);
    setMessage(null);
    const supabase = createClient();
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase
      .from("profiles")
      .update({ full_name, vehicle_model: car.trim() || null })
      .eq("id", auth.user!.id);
    setBusy(false);
    if (error) return setMessage({ ok: false, text: error.message });
    if (next) return router.push(next);
    setMessage({ ok: true, text: "Profil enregistré." });
    router.refresh();
  }

  return (
    <form onSubmit={save} className="card grid gap-3" data-testid="account-form">
      <h2 className="font-semibold">Mon profil</h2>
      <label className="grid gap-1 text-sm">
        Prénom et nom
        <input className="input" name="full_name" autoComplete="name" maxLength={120} required value={name} onChange={(e) => setName(e.target.value)} placeholder="Camille Martin" />
        <span className="text-xs text-subtle">Vu par les personnes avec qui vous réservez ; seul le prénom apparaît dans les avis publics.</span>
      </label>
      <label className="grid gap-1 text-sm">
        Véhicule (facultatif)
        <input className="input" name="vehicle_model" maxLength={120} value={car} onChange={(e) => setCar(e.target.value)} placeholder="Renault Zoé" />
        <span className="text-xs text-subtle">Aide l&apos;hôte à préparer la place et le bon câble.</span>
      </label>
      <p className="text-sm text-muted">
        E-mail de connexion : <strong className="break-all">{email}</strong>
      </p>
      {message && <p className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}>{message.text}</p>}
      <button className="btn-primary" disabled={busy}>{busy ? "…" : next ? "Continuer" : "Enregistrer"}</button>
    </form>
  );
}
