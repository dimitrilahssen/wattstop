import { createClient } from "@/lib/supabase/client";

export type PaymentStatus = "requires_authorization" | "authorized" | "captured" | "waived" | "canceled" | "failed";

/** Paiements actifs côté interface dès que la clé publique Stripe est configurée. */
export const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
export const paymentsEnabled = STRIPE_PUBLISHABLE_KEY.startsWith("pk_");
/** Adresse (slug) de l'Edge Function de paiement dans Supabase : visible dans son URL …/functions/v1/<slug>. */
export const PAYMENTS_FUNCTION = process.env.NEXT_PUBLIC_PAYMENTS_FUNCTION || "payments";

type Action = "authorize" | "sync" | "capture" | "release";
export type PaymentResult = { status: PaymentStatus | "none"; client_secret?: string; amount_cents?: number | null };

/** Appelle l'Edge Function « payments » avec la session de l'utilisateur. */
export async function callPayments(action: Action, bookingId: string): Promise<PaymentResult> {
  const { data, error } = await createClient().functions.invoke(PAYMENTS_FUNCTION, { body: { action, booking_id: bookingId } });
  if (error) {
    // Le message utile est dans le corps de la réponse de la fonction
    const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(body?.error ?? error.message);
  }
  return data as PaymentResult;
}

export const centsToEur = (cents: number) => cents / 100;

// ---------- Reversement aux hôtes (Stripe Connect) ----------
export type PayoutStatus = "none" | "awaiting_host_account" | "transferred" | "failed";
export type ConnectStatus = {
  account: { details_submitted: boolean; payouts_enabled: boolean; transfers_active: boolean } | null;
  pending_cents: number;
  transferred_cents: number;
};

/** Actions de l'hôte sur son compte de reversement (formulaire Stripe, état, espace Stripe). */
export async function callConnect<T>(action: "connect_onboard" | "connect_status" | "connect_dashboard", extra: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await createClient().functions.invoke(PAYMENTS_FUNCTION, { body: { action, ...extra } });
  if (error) {
    const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(body?.error ?? error.message);
  }
  return data as T;
}
