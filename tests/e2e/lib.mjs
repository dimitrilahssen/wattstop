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
