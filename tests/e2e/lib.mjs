// Utilitaires communs aux tests de bout en bout (comptes de test, connexion, assertions).
// Les adresses et le mot de passe des comptes viennent de .env.local : rien de personnel dans le dépôt.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnv() {
  const file = path.join(ROOT, ".env.local");
  const env = { ...process.env };
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

export const env = loadEnv();
const missing = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "E2E_HOST_EMAIL", "E2E_DRIVER_EMAIL", "E2E_PASSWORD"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Variables manquantes dans .env.local : ${missing.join(", ")}\nVoir la section « Tests de bout en bout » du README.`);
  process.exit(2);
}

export const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_KEY = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const BASE_URL = env.E2E_BASE_URL ?? "http://localhost:3000";
export const PASSWORD = env.E2E_PASSWORD;
export const USERS = {
  host: { email: env.E2E_HOST_EMAIL, name: "Hôte Test" },
  driver: { email: env.E2E_DRIVER_EMAIL, name: "Conducteur Test" },
};
/** Durée de recharge simulée avant le check-out (le plafond anti-fraude dépend du temps écoulé). */
export const CHARGE_SECONDS = Number(env.E2E_CHARGE_SECONDS ?? 70);
/** Préfixe des données créées par les tests : sert au nettoyage. */
export const TEST_PREFIX = "[TEST]";

export const client = () =>
  createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/** Connecte un compte de test ; le crée s'il n'existe pas (nécessite « Confirm email » désactivé). */
export async function login(role) {
  const c = client();
  const u = USERS[role];
  let { data, error } = await c.auth.signInWithPassword({ email: u.email, password: PASSWORD });
  if (error) {
    ({ data, error } = await c.auth.signUp({ email: u.email, password: PASSWORD, options: { data: { full_name: u.name } } }));
    if (error) throw new Error(`Création du compte ${role} impossible : ${error.message}`);
    if (!data.session)
      throw new Error(`Compte ${role} créé mais non confirmé : désactivez « Confirm email » le temps du premier lancement, ou créez-le dans Authentication > Users > Add user (Auto Confirm).`);
  }
  // Le conducteur de test a toujours une carte enregistrée (exigée pour réserver quand le paiement est obligatoire)
  if (role === "driver" && STRIPE_PK && (await paymentsRequired(c))) await ensureTestCard(c);
  return { c, id: data.user.id };
}

/** Désactive les spots de test de l'hôte : ils disparaissent de la carte publique (l'historique reste). */
export async function hideTestSpots(hostClient, hostId) {
  await hostClient.from("spots").update({ is_active: false }).eq("host_id", hostId).like("title", `${TEST_PREFIX}%`).eq("is_active", true);
}

/** Annule les réservations encore ouvertes laissées par un essai interrompu. */
export async function cancelOpenBookings(c) {
  const { data } = await c.from("bookings").select("id").in("status", ["pending", "confirmed"]);
  for (const b of data ?? []) await c.rpc("cancel_booking", { p_booking_id: b.id });
}

export function reporter() {
  let pass = 0, fail = 0;
  const ok = (cond, label, extra = "") => {
    cond ? pass++ : fail++;
    console.log(`${cond ? "✅" : "❌"} ${label}${extra ? " — " + extra : ""}`);
  };
  const expectErr = (res, label) => ok(!!res.error, label, res.error ? res.error.message : "AUCUNE ERREUR (faille)");
  const done = () => {
    console.log(`\n${pass} réussis, ${fail} échoués`);
    process.exit(fail ? 1 : 0);
  };
  return { ok, expectErr, done };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function crash(e) {
  if (String(e?.cause?.code ?? e?.message).includes("ENOTFOUND"))
    console.error("Supabase injoignable. Derrière un proxy, lancez avec NODE_USE_ENV_PROXY=1.");
  console.error("ERREUR", e);
  process.exit(2);
}

// ---------- Paiement Stripe (mode test) ----------
export const STRIPE_PK = env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
export const PAYMENTS_FUNCTION = env.NEXT_PUBLIC_PAYMENTS_FUNCTION || "payments";

/** Appelle l'Edge Function de paiement avec la session d'un client Supabase (ou sans session). */
export async function callPayments(c, action, bookingId, extra = {}) {
  const token = c ? (await c.auth.getSession()).data.session?.access_token : null;
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${PAYMENTS_FUNCTION}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, booking_id: bookingId, ...extra }),
  });
  const body = await res.json().catch(() => ({}));
  return { http: res.status, ...body };
}

/** Ce que fait Stripe.js dans le navigateur : confirmer avec la clé PUBLIQUE, le client_secret et la carte de test Visa. */
export async function confirmWithTestCard(clientSecret) {
  const piId = clientSecret.split("_secret_")[0];
  const res = await fetch(`https://api.stripe.com/v1/payment_intents/${piId}/confirm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_PK}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_secret: clientSecret, payment_method: "pm_card_visa" }),
  });
  return res.json();
}

/** Le paiement est-il obligatoire avant le check-in (app_settings.payments_required) ? */
export async function paymentsRequired(c) {
  const { data, error } = await c.from("app_settings").select("payments_required").maybeSingle();
  return !error && !!data?.payments_required;
}

/** Paie une réservation confirmée avec la carte de test (autorisation + validation + synchro). */
export async function payWithTestCard(c, bookingId) {
  const a = await callPayments(c, "authorize", bookingId);
  if (a.http !== 200) throw new Error(`Autorisation refusée : ${a.error}`);
  if (a.client_secret) await confirmWithTestCard(a.client_secret);
  const s = await callPayments(c, "sync", bookingId);
  if (s.status !== "authorized") throw new Error(`Paiement non autorisé : ${JSON.stringify(s)}`);
  return a;
}

/** Ce que fait Stripe.js pour enregistrer une carte : confirmer le SetupIntent avec la clé PUBLIQUE. */
export async function confirmSetupWithTestCard(clientSecret, paymentMethod = "pm_card_visa") {
  const id = clientSecret.split("_secret_")[0];
  const res = await fetch(`https://api.stripe.com/v1/setup_intents/${id}/confirm`, {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_PK}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_secret: clientSecret, payment_method: paymentMethod }),
  });
  return res.json();
}

/** Enregistre la carte de test Visa du conducteur si besoin (SetupIntent : rien n'est prélevé). */
export async function ensureTestCard(c, { force = false, paymentMethod = "pm_card_visa" } = {}) {
  if (!force) {
    const { data } = await c.from("driver_cards").select("stripe_payment_method_id").maybeSingle();
    if (data?.stripe_payment_method_id) return null;
  }
  const s = await callPayments(c, "card_setup");
  if (!s.client_secret) throw new Error(`Enregistrement de carte impossible : ${s.error}`);
  const conf = await confirmSetupWithTestCard(s.client_secret, paymentMethod);
  if (conf.status !== "succeeded") throw new Error(`Carte de test refusée : ${conf.error?.message ?? conf.status}`);
  const r = await callPayments(c, "card_sync", undefined, { setup_intent_id: s.setup_intent_id });
  if (r.http !== 200) throw new Error(`Carte non enregistrée : ${r.error}`);
  return r.card;
}
