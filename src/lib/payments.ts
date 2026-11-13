import { createClient } from "@/lib/supabase/client";

export type PaymentStatus = "requires_authorization" | "authorized" | "captured" | "waived" | "canceled" | "failed";

/** Paiements actifs côté interface dès que la clé publique Stripe est configurée. */
export const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
export const paymentsEnabled = STRIPE_PUBLISHABLE_KEY.startsWith("pk_");

type Action = "authorize" | "sync" | "capture" | "release";
export type PaymentResult = { status: PaymentStatus | "none"; client_secret?: string; amount_cents?: number | null };

/** Appelle l'Edge Function « payments » avec la session de l'utilisateur. */
export async function callPayments(action: Action, bookingId: string): Promise<PaymentResult> {
  const { data, error } = await createClient().functions.invoke("payments", { body: { action, booking_id: bookingId } });
  if (error) {
    // Le message utile est dans le corps de la réponse de la fonction
    const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
    throw new Error(body?.error ?? error.message);
  }
  return data as PaymentResult;
}

export const centsToEur = (cents: number) => cents / 100;
