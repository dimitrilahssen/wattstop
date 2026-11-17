"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { createClient } from "@/lib/supabase/client";
import { callCard, STRIPE_PUBLISHABLE_KEY, type SavedCard as Card } from "@/lib/payments";

let stripePromise: ReturnType<typeof loadStripe> | null = null;
const getStripe = () => (stripePromise ??= loadStripe(STRIPE_PUBLISHABLE_KEY));

const BRAND: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", cartes_bancaires: "CB" };
export const cardLabel = (c: Card) => `${BRAND[c.brand ?? ""] ?? c.brand ?? "Carte"} •••• ${c.last4 ?? "????"}`;

/**
 * Carte bancaire enregistrée du conducteur (garantie de ses réservations, rien n'est prélevé ici).
 * Saisie dans le formulaire sécurisé de Stripe (SetupIntent) ; la base ne garde que la marque et les 4 chiffres.
 * `onChange(true)` dès qu'une carte est disponible. `manage` : boutons Remplacer / Retirer.
 */
export function SavedCard({ onChange, manage = false, intro }: { onChange?: (has: boolean) => void; manage?: boolean; intro?: string }) {
  const [card, setCard] = useState<Card | null | undefined>(undefined);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await createClient()
      .from("driver_cards")
      .select("stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year")
      .maybeSingle();
    const c = data?.stripe_payment_method_id
      ? { brand: data.card_brand, last4: data.card_last4, exp_month: data.card_exp_month, exp_year: data.card_exp_year }
      : null;
    setCard(c);
    onChange?.(!!c);
  }, [onChange]);

  useEffect(() => {
    load();
  }, [load]);

  async function startSetup() {
    setBusy(true);
    setError(null);
    try {
      const r = await callCard<{ client_secret: string; setup_intent_id: string }>("card_setup");
      setClientSecret(r.client_secret);
      setSetupId(r.setup_intent_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await callCard("card_remove");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const options = useMemo(
    () =>
      clientSecret
        ? { clientSecret, locale: "fr" as const, appearance: { theme: "stripe" as const, variables: { colorPrimary: "#15803d", borderRadius: "12px" } } }
        : undefined,
    [clientSecret]
  );

  if (card === undefined) return <div className="h-12 animate-pulse rounded-lg bg-soft" />;

  return (
    <div className="grid min-w-0 gap-2" data-testid="saved-card">
      {card && !clientSecret ? (
        <div className="flex items-center justify-between gap-2 rounded-lg bg-soft p-3 text-sm">
          <span>
            💳 <strong>{cardLabel(card)}</strong>
            {card.exp_month && card.exp_year ? <span className="text-muted"> · exp. {String(card.exp_month).padStart(2, "0")}/{String(card.exp_year).slice(-2)}</span> : null}
          </span>
          <span className="flex shrink-0 gap-3">
            <button type="button" className="text-accent" disabled={busy} onClick={startSetup}>
              {manage ? "Remplacer" : "Changer"}
            </button>
            {manage && (
              <button type="button" className="text-muted hover:text-danger" disabled={busy} onClick={remove}>
                Retirer
              </button>
            )}
          </span>
        </div>
      ) : !clientSecret ? (
        <div className="grid gap-2">
          {intro && <p className="text-sm text-muted">{intro}</p>}
          <button type="button" className="btn-ghost py-2" disabled={busy} onClick={startSetup}>
            {busy ? "…" : "💳 Enregistrer une carte"}
          </button>
        </div>
      ) : (
        <Elements stripe={getStripe()} options={options}>
          <SetupForm
            setupIntentId={setupId!}
            onDone={async () => {
              setClientSecret(null);
              await load();
            }}
            onCancel={() => setClientSecret(null)}
            onError={setError}
          />
        </Elements>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

function SetupForm({ setupIntentId, onDone, onCancel, onError }: { setupIntentId: string; onDone: () => void; onCancel: () => void; onError: (m: string | null) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!stripe || !elements) return;
    setBusy(true);
    onError(null);
    const { error } = await stripe.confirmSetup({ elements, redirect: "if_required" });
    if (error) {
      setBusy(false);
      return onError(error.message ?? "Carte refusée");
    }
    try {
      // Le serveur relit Stripe : c'est lui seul qui enregistre la carte
      await callCard("card_sync", { setup_intent_id: setupIntentId });
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Pas de <form> : ce bloc peut se trouver dans le formulaire de réservation
  return (
    <div className="grid w-full min-w-0 gap-3">
      <div className="block w-full min-w-0">
        <PaymentElement options={{ layout: "tabs", defaultValues: { billingDetails: { address: { country: "FR" } } } }} />
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn-primary flex-1 py-2" disabled={!stripe || busy} onClick={save}>
          {busy ? "Enregistrement…" : "Enregistrer la carte"}
        </button>
        <button type="button" className="btn-ghost py-2" disabled={busy} onClick={onCancel}>
          Annuler
        </button>
      </div>
      <p className="text-xs text-subtle">
        Rien n&apos;est prélevé maintenant.{STRIPE_PUBLISHABLE_KEY.startsWith("pk_test_") ? " Mode test Stripe : carte 4242 4242 4242 4242." : ""}
      </p>
    </div>
  );
}
