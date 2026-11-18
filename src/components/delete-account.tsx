"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callFunction } from "@/lib/payments";

/** Suppression du compte (RGPD) : données personnelles effacées, historique conservé de façon anonyme. */
export function DeleteAccount() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await callFunction("account_delete");
      // Déconnexion locale seulement : côté serveur, la session est déjà révoquée
      await createClient().auth.signOut({ scope: "local" }).catch(() => {});
      router.push("/?compte=supprime");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <section className="card grid gap-3" data-testid="delete-account">
      <h2 className="font-semibold">Supprimer mon compte</h2>
      <p className="text-sm text-muted">
        Vos informations personnelles (nom, e-mail, véhicule, carte, appareils) sont effacées et vos spots retirés de la carte.
        L&apos;historique de vos réservations et paiements est conservé sans votre nom, comme l&apos;exige la comptabilité.
      </p>
      {!confirming ? (
        <button type="button" className="btn-ghost py-2 text-danger" onClick={() => setConfirming(true)}>
          Supprimer mon compte
        </button>
      ) : (
        <div role="alertdialog" aria-label="Confirmer la suppression" className="grid gap-2 rounded-lg bg-soft p-3 text-sm">
          <p>
            <strong>C&apos;est définitif.</strong> Vous ne pourrez plus vous connecter avec ce compte.
          </p>
          <div className="flex gap-2">
            <button type="button" className="btn-primary flex-1 bg-danger py-2 hover:bg-danger" disabled={busy} onClick={remove}>
              {busy ? "Suppression…" : "Oui, supprimer définitivement"}
            </button>
            <button type="button" className="btn-ghost flex-1 py-2" disabled={busy} onClick={() => setConfirming(false)}>
              Garder mon compte
            </button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </section>
  );
}
