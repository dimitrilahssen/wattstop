"use client";
import { useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { callPayments, centsToEur, STRIPE_PUBLISHABLE_KEY } from "@/lib/payments";
import { eur } from "@/lib/format";

let stripePromise: ReturnType<typeof loadStripe> | null = null;
const getStripe = () => (stripePromise ??= loadStripe(STRIPE_PUBLISHABLE_KEY));

/**
 * Étape de paiement avant le démarrage : bloque le montant maximal sur la carte (sans le prélever).
 * Le montant est calculé par le serveur ; ce composant ne fait qu'afficher et confirmer.
 */
export function PaymentStep({ bookingId, onAuthorized }: { bookingId: string; onAuthorized: () => void }) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await callPayments("authorize", bookingId);
      setAmount(r.amount_cents ?? null);
      if (r.status === "authorized") return onAuthorized();
      if (!r.client_secret) throw new Error("Paiement indisponible");
      setClientSecret(r.client_secret);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const options = useMemo(
    () =>
      clientSecret
        ? {
            clientSecret,
            locale: "fr" as const,
            appearance: { theme: "stripe" as const, variables: { colorPrimary: "#15803d", borderRadius: "12px" } },
          }
        : undefined,
    [clientSecret]
  );

  return (
    <div className="card grid gap-3" data-testid="payment-step">
      <div>
        <p className="font-semibold">💳 Paiement</p>
        <p className="text-sm text-muted">
          {amount != null
            ? `${eur(centsToEur(amount))} maximum seront bloqués sur votre carte. Seule l'énergie réellement consommée sera prélevée à la fin, le reste est libéré.`
            : "Un montant maximal est bloqué sur votre carte au démarrage. Seule l'énergie réellement consommée est prélevée à la fin."}
        </p>
      </div>
      {!clientSecret ? (
        <button className="btn-primary" disabled={busy} onClick={start}>
          {busy ? "…" : "Continuer vers le paiement"}
        </button>
      ) : (
        <Elements stripe={getStripe()} options={options}>
          <CardForm bookingId={bookingId} onAuthorized={onAuthorized} onError={setError} />
        </Elements>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

function CardForm({ bookingId, onAuthorized, onError }: { bookingId: string; onAuthorized: () => void; onError: (m: string | null) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    onError(null);
    const { error } = await stripe.confirmPayment({ elements, redirect: "if_required" });
    if (error) {
      setBusy(false);
      return onError(error.message ?? "Paiement refusé");
    }
    // Le serveur relit Stripe : c'est lui seul qui enregistre l'autorisation
    try {
      const r = await callPayments("sync", bookingId);
      if (r.status !== "authorized") throw new Error("Autorisation non confirmée par Stripe, réessayez.");
      onAuthorized();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <PaymentElement options={{ layout: "tabs" }} />
      <button className="btn-primary" disabled={!stripe || busy}>
        {busy ? "Validation…" : "Valider la carte"}
      </button>
    </form>
  );
}
