"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { callConnect, paymentsEnabled, type ConnectStatus } from "@/lib/payments";
import { eur } from "@/lib/format";

/**
 * Bloc « Recevoir vos gains » de l'hôte : activation du compte Stripe (formulaire hébergé par Stripe),
 * état de vérification, sommes reversées et en attente.
 */
export function HostPayouts() {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const backFromStripe = params.get("stripe") === "return";

  useEffect(() => {
    if (!paymentsEnabled) return;
    callConnect<ConnectStatus>("connect_status")
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
    // Retour du formulaire Stripe : on nettoie l'adresse après avoir relu l'état
    if (params.get("stripe")) router.replace("/host", { scroll: false });
  }, [params, router]);

  if (!paymentsEnabled) return null;

  async function go(action: "connect_onboard" | "connect_dashboard") {
    setBusy(true);
    setError(null);
    try {
      const { url } = await callConnect<{ url: string }>(action, { origin: window.location.origin });
      if (action === "connect_dashboard") window.open(url, "_blank", "noopener");
      else window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const acc = status?.account;
  const active = !!acc?.transfers_active;
  const euros = (cents: number) => eur(cents / 100);

  return (
    <section className="card grid gap-3" data-testid="host-payouts" aria-live="polite">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">💶 Recevoir vos gains</h2>
          <p className="text-sm text-muted">
            {!status
              ? "Chargement…"
              : active
                ? "Paiements activés : l'argent de chaque recharge est reversé sur votre compte Stripe, puis viré sur votre compte bancaire."
                : acc?.details_submitted
                  ? "Stripe vérifie vos informations. Les reversements commenceront dès la validation."
                  : acc
                    ? "Activation commencée : il reste des informations à fournir à Stripe."
                    : "Activez vos paiements pour recevoir l'argent de vos recharges. Identité et IBAN sont vérifiés par Stripe (environ 5 minutes)."}
          </p>
        </div>
        {status && (
          <span
            className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${active ? "bg-accent/10 text-accent" : "bg-soft text-muted"}`}
          >
            {active ? "Activé" : acc?.details_submitted ? "En vérification" : "À activer"}
          </span>
        )}
      </div>

      {status && (status.pending_cents > 0 || status.transferred_cents > 0) && (
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg bg-soft p-2">
            <dt className="text-xs text-subtle">Reversé</dt>
            <dd className="font-semibold" data-testid="payout-transferred">{euros(status.transferred_cents)}</dd>
          </div>
          <div className="rounded-lg bg-soft p-2">
            <dt className="text-xs text-subtle">En attente</dt>
            <dd className="font-semibold" data-testid="payout-pending">{euros(status.pending_cents)}</dd>
          </div>
        </dl>
      )}
      {status && !active && status.pending_cents > 0 && (
        <p className="text-sm text-muted">Ces gains vous sont reversés automatiquement dès que vos paiements sont activés.</p>
      )}
      {backFromStripe && status && !active && acc && (
        <p className="text-sm text-muted">Merci ! Si Stripe demande encore des informations, reprenez l&apos;activation ci-dessous.</p>
      )}

      {status &&
        (active ? (
          <button className="btn-ghost py-2" disabled={busy} onClick={() => go("connect_dashboard")}>
            Ouvrir mon espace Stripe
          </button>
        ) : (
          <button className="btn-primary py-2" disabled={busy} onClick={() => go("connect_onboard")}>
            {busy ? "Redirection vers Stripe…" : acc ? "Continuer l'activation" : "Activer mes paiements"}
          </button>
        ))}
      {error && <p className="text-sm text-danger">{error}</p>}
    </section>
  );
}
