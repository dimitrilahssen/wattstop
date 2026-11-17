// Page « Mon compte » : prénom demandé à la première connexion, véhicule visible par l'hôte,
// déconnexion, et suppression réelle d'un compte jetable (données effacées, connexion bloquée,
// historique conservé de façon anonyme).
// Le compte jetable est créé avec un alias de l'adresse du conducteur de test (vous+supprXXXX@…) :
// nécessite « Confirm email » désactivé le temps du test (sinon la partie suppression est sautée).
// Prérequis : migration 20261122000000_account.sql, fonction à jour, l'app tourne. Usage : npm run test:e2e:account
import { chromium } from "playwright";
import { BASE_URL, PASSWORD, USERS, TEST_PREFIX, login, client, reporter, crash, cancelOpenBookings, hideTestSpots, ensureTestCard, paymentsRequired, callPayments } from "./lib.mjs";
import { sessionCookies, wire } from "./browser.mjs";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_KEY } from "./lib.mjs";

const { ok, expectErr, done } = reporter();

/** Cookies de session pour un compte quelconque (email + mot de passe). */
async function cookiesFor(email) {
  const jar = [];
  const sb = createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: { getAll: () => jar, setAll: (cs) => cs.forEach((c) => { const i = jar.findIndex((j) => j.name === c.name); i >= 0 ? jar.splice(i, 1, c) : jar.push(c); }) },
  });
  const { error } = await sb.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw error;
  const { hostname } = new URL(BASE_URL);
  return jar.filter((c) => c.value).map((c) => ({ name: c.name, value: c.value, domain: hostname, path: "/", sameSite: "Lax" }));
}

let browser;
try {
  const H = await login("host"), D = await login("driver");
  await cancelOpenBookings(D.c);
  await hideTestSpots(H.c, H.id);
  browser = await chromium.launch();
  const errors = [];
  const pageWith = async (cookies) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR", timezoneId: "Europe/Paris" });
    await wire(ctx, errors);
    await ctx.addCookies(cookies);
    return ctx.newPage();
  };

  // 1. Déconnexion (conducteur de test)
  const driver = await pageWith(await sessionCookies("driver"));
  await driver.goto(`${BASE_URL}/account`);
  await driver.getByRole("heading", { name: "Mon compte" }).waitFor({ timeout: 15000 });
  ok((await driver.getByLabel(/Prénom et nom/).inputValue()) === USERS.driver.name, "Mon compte : prénom et nom pré-remplis");
  ok(await driver.getByRole("link", { name: /Compte/ }).getAttribute("aria-current") === "page", "Barre du bas : onglet « Compte » actif");
  await driver.getByRole("button", { name: "Se déconnecter" }).click();
  await driver.waitForURL((u) => new URL(u).pathname === "/", { timeout: 15000 }).catch(() => {});
  await driver.goto(`${BASE_URL}/bookings`);
  ok(/\/login/.test(driver.url()), "Se déconnecter : Réservations redemande la connexion", driver.url());

  // 2. Compte jetable : création sans prénom
  const email = USERS.driver.email.replace(/(\+[^@]*)?@/, `+suppr${Date.now().toString(36)}@`);
  const N = { c: client() };
  const { data: su, error: sue } = await N.c.auth.signUp({ email, password: PASSWORD });
  if (sue || !su.session) {
    ok(false, "Compte jetable : création impossible (« Confirm email » activé ?) — partie suppression sautée", sue?.message ?? "pas de session");
    done();
    process.exit(1);
  }
  N.id = su.user.id;
  const prof0 = (await N.c.from("profiles").select("full_name").eq("id", N.id).single()).data;
  ok(!prof0?.full_name, "Nouveau compte : pas encore de prénom");
  expectErr(await N.c.from("spots").insert({ host_id: N.id, title: `${TEST_PREFIX} sans prénom`, address: "1 rue", connector_type: "type2", power_kw: 7.4, price_per_kwh: 0.3, location: "SRID=4326;POINT(2.35 48.85)" }), "Sans prénom : publier un spot refusé par la base");

  // 3. Première connexion : prénom demandé, puis retour à la page visée
  const fresh = await pageWith(await cookiesFor(email));
  await fresh.goto(`${BASE_URL}/map`);
  await fresh.waitForURL(/\/account\?bienvenue=1/, { timeout: 15000 }).catch(() => {});
  ok(await fresh.getByTestId("welcome").isVisible().catch(() => false), "Première connexion : redirigé vers « Mon compte » avec un message de bienvenue");
  await fresh.getByLabel(/Prénom et nom/).fill("Alex Essai");
  await fresh.getByLabel(/Véhicule/).fill("Renault Zoé");
  await fresh.getByRole("button", { name: "Continuer" }).click();
  await fresh.waitForURL(/\/map/, { timeout: 15000 }).catch(() => {});
  ok(/\/map/.test(fresh.url()), "Après « Continuer » : retour à la carte", fresh.url());
  const prof1 = (await N.c.from("profiles").select("full_name, vehicle_model").eq("id", N.id).single()).data;
  ok(prof1?.full_name === "Alex Essai" && prof1?.vehicle_model === "Renault Zoé", "Prénom et véhicule enregistrés", JSON.stringify(prof1));

  // 4. Le véhicule est visible par l'hôte sur la demande
  const title = `${TEST_PREFIX} Borne compte ${Date.now().toString().slice(-5)}`;
  await H.c.from("spots").insert({ host_id: H.id, title, address: "9 rue du Test, Paris", connector_type: "type2", power_kw: 7.4, price_per_kwh: 0.3, location: "SRID=4326;POINT(2.3522 48.8566)" });
  const { data: spot } = await H.c.from("spots").select("id").eq("title", title).single();
  if (await paymentsRequired(N.c)) await ensureTestCard(N.c);
  const { data: bk, error: be } = await N.c.from("bookings").insert({ spot_id: spot.id, driver_id: N.id, start_at: new Date(Date.now() + 86_400_000).toISOString(), end_at: new Date(Date.now() + 90_000_000).toISOString() }).select("id").single();
  ok(!be, "Avec prénom (et carte) : réservation acceptée par la base", be?.message);
  const host = await pageWith(await sessionCookies("host"));
  await host.goto(`${BASE_URL}/bookings`);
  const req = host.locator(`#booking-${bk.id}`);
  await req.waitFor({ timeout: 15000 });
  ok((await req.textContent()).includes("Conducteur : Alex Essai") && (await req.textContent()).includes("Renault Zoé"), "Hôte : voit le prénom et le véhicule du conducteur");

  // 5. Suppression : refusée tant qu'une réservation est en cours
  await fresh.goto(`${BASE_URL}/account`);
  const del = fresh.getByTestId("delete-account");
  await del.getByRole("button", { name: "Supprimer mon compte" }).click();
  await del.getByRole("button", { name: "Garder mon compte" }).click();
  ok(!(await del.getByRole("button", { name: /définitivement/ }).isVisible()), "« Garder mon compte » : rien n'est supprimé");
  await del.getByRole("button", { name: "Supprimer mon compte" }).click();
  await del.getByRole("button", { name: /définitivement/ }).click();
  await del.getByRole("alert").waitFor({ timeout: 15000 }).catch(() => {});
  ok(/réservations en cours/.test(await del.getByRole("alert").textContent().catch(() => "")), "Suppression refusée tant qu'une réservation est en cours");
  await N.c.rpc("cancel_booking", { p_booking_id: bk.id });

  // 6. Suppression réelle
  await fresh.reload();
  await del.getByRole("button", { name: "Supprimer mon compte" }).click();
  await del.getByRole("button", { name: /définitivement/ }).click();
  await fresh.waitForURL(/compte=supprime/, { timeout: 30000 }).catch(() => {});
  ok(await fresh.getByTestId("account-deleted").isVisible().catch(() => false), "Compte supprimé : retour à l'accueil avec un message");
  const relog = await client().auth.signInWithPassword({ email, password: PASSWORD });
  ok(!!relog.error, "Compte supprimé : plus de connexion possible", relog.error?.message ?? "CONNEXION RÉUSSIE (faille)");
  const prof2 = (await H.c.from("profiles").select("full_name, vehicle_model, deleted_at").eq("id", N.id).single()).data;
  ok(prof2 && !prof2.full_name && !prof2.vehicle_model && !!prof2.deleted_at, "Profil anonymisé (nom et véhicule effacés)", JSON.stringify(prof2));
  await host.reload();
  ok((await host.locator(`#booking-${bk.id}`).textContent().catch(() => "")).includes("compte supprimé"), "Historique de l'hôte conservé : « Conducteur : compte supprimé »");
  // Même avec un ancien jeton encore valide quelques minutes : plus rien de possible sur ce compte
  expectErr(await N.c.from("spots").insert({ host_id: N.id, title: `${TEST_PREFIX} compte supprimé`, address: "1 rue", connector_type: "type2", power_kw: 7.4, price_per_kwh: 0.3, location: "SRID=4326;POINT(2.35 48.85)" }), "Ancienne session : plus de publication possible");
  void callPayments;

  const unexpected = [...new Set(errors)].filter((e) => !/stripe|ERR_FAILED|net::|status of 40[19]/i.test(e));
  ok(unexpected.length === 0, "Aucune erreur inattendue dans la console", unexpected.slice(0, 3).join(" | "));
  await H.c.from("spots").update({ is_active: false }).eq("id", spot.id);
  void D;
  done();
} catch (e) {
  crash(e);
} finally {
  await browser?.close();
}
