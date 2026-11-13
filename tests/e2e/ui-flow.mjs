// Parcours complet dans un vrai navigateur, avec deux sessions : l'hôte et le conducteur.
// Prérequis : l'app tourne (npm run dev). Usage : npm run test:e2e:ui
// Captures d'écran : tests/e2e/screenshots/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServerClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_KEY, BASE_URL, PASSWORD, USERS, CHARGE_SECONDS, TEST_PREFIX, login, reporter, sleep, crash, hideTestSpots, cancelOpenBookings } from "./lib.mjs";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "screenshots");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const { ok, done } = reporter();
let shotN = 0;
const shot = async (p, name) => {
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, `${String(++shotN).padStart(2, "0")}-${name}.png`), fullPage: true });
};

/** Ouvre une session Supabase et renvoie les cookies que l'app (@supabase/ssr) attend. */
async function sessionCookies(role) {
  const jar = [];
  const sb = createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll: () => jar,
      setAll: (cs) => cs.forEach((c) => { const i = jar.findIndex((j) => j.name === c.name); i >= 0 ? jar.splice(i, 1, c) : jar.push(c); }),
    },
  });
  const { error } = await sb.auth.signInWithPassword({ email: USERS[role].email, password: PASSWORD });
  if (error) throw error;
  const { hostname } = new URL(BASE_URL);
  return jar.filter((c) => c.value).map((c) => ({ name: c.name, value: c.value, domain: hostname, path: "/", sameSite: "Lax" }));
}

async function wire(ctx, errors) {
  // Derrière un proxy d'entreprise (HTTPS_PROXY), le navigateur de test passe ses appels Supabase par Node.
  if (process.env.HTTPS_PROXY) {
    await ctx.route(`${SUPABASE_URL}/**`, async (route) => {
      const r = route.request();
      const headers = { ...r.headers() };
      delete headers.host; delete headers["content-length"];
      const res = await fetch(r.url(), { method: r.method(), headers, body: ["GET", "HEAD"].includes(r.method()) ? undefined : r.postDataBuffer() });
      const out = Object.fromEntries(res.headers);
      delete out["content-encoding"]; delete out["content-length"];
      await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) });
    });
  }
  // Idem pour le WebSocket Realtime (notifications en direct) : relayé par Node derrière un proxy
  if (process.env.HTTPS_PROXY) {
    await ctx.routeWebSocket(/\/realtime\/v1\//, (ws) => {
      const up = new WebSocket(ws.url());
      up.binaryType = "arraybuffer";
      const queue = [];
      up.addEventListener("open", () => queue.splice(0).forEach((m) => up.send(m)));
      up.addEventListener("message", (e) => ws.send(typeof e.data === "string" ? e.data : Buffer.from(e.data)));
      up.addEventListener("close", () => ws.close());
      ws.onMessage((m) => (up.readyState === WebSocket.OPEN ? up.send(m) : queue.push(m)));
      ws.onClose(() => up.close());
    });
  }
  // Fond de carte uni : le test ne dépend pas d'un service de tuiles externe.
  await ctx.route("**/tiles.openfreemap.org/**", (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#e8ecef" } }] }) })
  );
  ctx.on("page", (p) => {
    p.on("pageerror", (e) => errors.push(`[${p.url()}] ${e.message}`));
    p.on("console", (m) => m.type() === "error" && errors.push(`[${p.url()}] ${m.text()}`));
  });
}

let browser;
try {
  const ping = await fetch(BASE_URL).catch(() => null);
  if (!ping) throw new Error(`L'app ne répond pas sur ${BASE_URL} : lancez d'abord « npm run dev ».`);

  // Remise à zéro des essais précédents
  const H = await login("host"), D = await login("driver");
  await cancelOpenBookings(D.c);
  await hideTestSpots(H.c, H.id);

  browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const errors = [];
  const pageFor = async (role) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, locale: "fr-FR", timezoneId: "Europe/Paris",
      geolocation: { latitude: 48.853, longitude: 2.3499 }, permissions: ["geolocation"],
    });
    await wire(ctx, errors);
    await ctx.addCookies(await sessionCookies(role));
    return ctx.newPage();
  };
  const host = await pageFor("host"), driver = await pageFor("driver");
  const TITLE = `${TEST_PREFIX} Prise Notre-Dame ${Date.now().toString().slice(-5)}`;

  // 1. Hôte : publie un spot
  await host.goto(`${BASE_URL}/host`);
  ok(await host.getByRole("heading", { name: "Mes spots" }).isVisible(), "Hôte : accès à « Mes spots » (session reconnue)");
  const form = host.locator("form");
  await form.locator("[name=title]").fill(TITLE);
  await form.locator("[name=address]").fill("6 parvis Notre-Dame, Paris");
  await form.locator("[name=connector_type]").selectOption("type2");
  await form.locator("[name=power_kw]").fill("7.4");
  await form.locator("[name=price_per_kwh]").fill("0.25");
  await form.locator("[name=access_instructions]").fill("Sonnez au 2e. Câble dans le coffret vert.");
  await form.getByRole("button", { name: /position actuelle/ }).click();
  await host.waitForTimeout(500);
  await shot(host, "hote-formulaire");
  await form.getByRole("button", { name: "Publier le spot" }).click();
  const card = host.locator("article", { hasText: TITLE });
  await card.waitFor({ timeout: 15000 }).catch(() => {});
  ok(await card.isVisible(), "Hôte : spot publié et listé");
  ok((await form.locator("[name=title]").inputValue()) === "", "Hôte : formulaire vidé après publication");
  await card.getByRole("button", { name: "Afficher le QR code" }).click();
  const codeEl = card.getByLabel("Code de secours");
  await codeEl.waitFor();
  const key = (await codeEl.textContent()).replace(/\s/g, "");
  ok(/^[0-9a-f]{32}$/.test(key), "Hôte : QR code et code de secours affichés");
  await shot(host, "hote-qr");

  // 2. Conducteur : trouve le spot
  await driver.goto(`${BASE_URL}/map`);
  await driver.waitForSelector(".ws-marker", { timeout: 20000 }).catch(() => {});
  await driver.getByRole("tab", { name: "Liste" }).click();
  const item = driver.getByRole("link", { name: new RegExp(TITLE.replace(/[[\]]/g, "\\$&")) });
  await item.waitFor({ timeout: 10000 }).catch(() => {});
  ok(await item.isVisible(), "Conducteur : spot visible dans la liste autour de lui");
  await shot(driver, "conducteur-liste");
  await item.click();
  await driver.waitForURL(/\/spots\//, { timeout: 60000 });

  // 3. Réserve un créneau qui commence dans 2 min (check-in possible 15 min avant)
  const tz = await driver.evaluate(() => new Date().getTimezoneOffset());
  const local = (d) => new Date(d.getTime() - tz * 60000).toISOString().slice(0, 16);
  const startAt = new Date(Date.now() + 2 * 60000);
  await driver.getByLabel("Début").fill(local(startAt));
  await driver.getByLabel("Fin").fill(local(new Date(Date.now() + 62 * 60000)));
  await driver.getByPlaceholder(/Message/).fill("Bonjour, j'arrive dans 5 min !");
  await shot(driver, "conducteur-reservation");
  // L'hôte reste sur « Mes spots » : la demande doit lui arriver en direct, sans recharger
  await host.goto(`${BASE_URL}/host`);
  await host.waitForTimeout(3000); // le temps que l'abonnement Realtime soit actif
  await driver.getByRole("button", { name: /Demander la réservation/ }).click();
  const liveToast = (p, text) => p.getByTestId("live-toast").filter({ hasText: text });
  await liveToast(host, "Nouvelle demande").waitFor({ timeout: 15000 }).catch(() => {});
  ok(await liveToast(host, "Nouvelle demande").isVisible(), "Temps réel : l'hôte est notifié de la demande sans recharger");
  ok((await host.getByTestId("bookings-badge").textContent().catch(() => "")) === "1", "Temps réel : pastille « 1 » sur l'onglet Résas de l'hôte");
  await shot(host, "hote-notification");
  // Premier affichage d'une page en mode dev : Next la compile, ce qui peut prendre plusieurs secondes
  await driver.waitForURL(/\/bookings/, { timeout: 60000 }).catch(() => {});
  const myBk = driver.locator("article", { hasText: TITLE });
  await myBk.filter({ hasText: "En attente" }).waitFor({ timeout: 15000 }).catch(() => {});
  ok(await myBk.filter({ hasText: "En attente" }).isVisible(), "Conducteur : réservation « En attente »");
  await shot(driver, "conducteur-resas-attente");

  // 4. Hôte : voit la demande et accepte
  await host.getByRole("link", { name: /Résas/ }).click();
  await host.waitForURL(/\/bookings/, { timeout: 60000 });
  const req = host.locator("article", { hasText: TITLE });
  await req.waitFor({ timeout: 10000 }).catch(() => {});
  ok(await req.isVisible(), "Hôte : voit la demande");
  ok(!(await host.getByTestId("bookings-badge").isVisible()), "Temps réel : la pastille disparaît en ouvrant Réservations");
  ok(await req.getByText("j'arrive dans 5 min").isVisible().catch(() => false), "Hôte : voit le message du conducteur");
  ok(await req.getByText(`Conducteur : ${USERS.driver.name}`).isVisible().catch(() => false), "Hôte : voit le nom du conducteur");
  const shown = await req.locator("p", { hasText: "→" }).first().textContent();
  const expected = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(Math.floor(startAt.getTime() / 60000) * 60000));
  ok(shown.startsWith(expected), "Heures affichées à l'heure de Paris", `${shown} (attendu ${expected})`);
  await shot(host, "hote-demande");
  await req.getByRole("button", { name: "Accepter" }).click();
  await req.filter({ hasText: "Confirmée" }).waitFor({ timeout: 10000 }).catch(() => {});
  ok(await req.filter({ hasText: "Confirmée" }).isVisible(), "Hôte : réservation confirmée");
  ok(!(await liveToast(host, "acceptée").isVisible()), "Temps réel : pas de notification pour sa propre action");
  // Le conducteur, resté sur Réservations, voit l'acceptation arriver
  await liveToast(driver, "Réservation acceptée").waitFor({ timeout: 15000 }).catch(() => {});
  ok(await liveToast(driver, "Réservation acceptée").isVisible(), "Temps réel : le conducteur est notifié de l'acceptation");
  await myBk.filter({ hasText: "Confirmée" }).waitFor({ timeout: 10000 }).catch(() => {});
  ok(await myBk.filter({ hasText: "Confirmée" }).isVisible(), "Temps réel : le statut passe à « Confirmée » sans recharger");
  await shot(driver, "conducteur-notification");

  // 5. Conducteur : scanne (code de secours saisi dans /scan) et démarre
  await driver.goto(`${BASE_URL}/scan`);
  await driver.locator("#manual-code").fill(key.match(/.{4}/g).join(" "));
  await driver.locator("#manual-code").press("Enter");
  await driver.waitForURL(/\/s\//, { timeout: 60000 });
  await driver.getByText("Spot scanné").waitFor();
  ok(await driver.getByText("Sonnez au 2e").isVisible(), "Conducteur : instructions d'accès visibles après scan");
  await shot(driver, "conducteur-scan");
  await driver.getByRole("button", { name: /Démarrer la recharge/ }).click();
  const kwhInput = driver.getByLabel(/Énergie rechargée/);
  await kwhInput.waitFor({ timeout: 10000 }).catch(() => {});
  ok(await kwhInput.isVisible(), "Conducteur : recharge démarrée");
  await shot(driver, "conducteur-en-charge");
  await liveToast(host, "Recharge démarrée").waitFor({ timeout: 15000 }).catch(() => {});
  ok(await liveToast(host, "Recharge démarrée").isVisible(), "Temps réel : l'hôte est notifié du démarrage");
  await host.locator("article", { hasText: TITLE }).filter({ hasText: "En charge" }).waitFor({ timeout: 30000 }).catch(() => {});
  ok(await host.locator("article", { hasText: TITLE }).filter({ hasText: "En charge" }).isVisible(), "Hôte : voit « En charge » sans recharger");

  // 6. Tentative de triche, puis fin de recharge
  await kwhInput.fill("40");
  await driver.getByRole("button", { name: /Terminer/ }).click();
  await driver.getByText(/incohérente/).waitFor({ timeout: 10000 }).catch(() => {});
  ok(await driver.getByText(/incohérente/).isVisible(), "Conducteur : 40 kWh en 1 min refusés (anti-fraude)");
  await shot(driver, "conducteur-triche");
  console.log(`… recharge simulée de ${CHARGE_SECONDS} s`);
  await sleep(CHARGE_SECONDS * 1000);
  await kwhInput.fill("0.1");
  await driver.getByRole("button", { name: /Terminer/ }).click();
  await driver.getByText("Recharge terminée").waitFor({ timeout: 10000 }).catch(() => {});
  ok(await driver.getByText("Recharge terminée").isVisible(), "Conducteur : recharge terminée et prix affiché");
  await shot(driver, "conducteur-termine");
  await driver.getByRole("link", { name: "Voir mes réservations" }).click();
  await driver.waitForURL(/\/bookings/, { timeout: 60000 });
  ok(await driver.locator("article", { hasText: TITLE }).filter({ hasText: "Terminée" }).isVisible(), "Conducteur : historique « Terminée »");
  await shot(driver, "conducteur-historique");
  await liveToast(host, "Recharge terminée").waitFor({ timeout: 15000 }).catch(() => {});
  ok(await liveToast(host, "Recharge terminée").filter({ hasText: "0,03 €" }).isVisible(), "Temps réel : l'hôte est notifié de la fin, avec le montant");
  await host.locator("article", { hasText: TITLE }).filter({ hasText: "Terminée" }).waitFor({ timeout: 30000 }).catch(() => {});
  ok(await host.locator("article", { hasText: TITLE }).filter({ hasText: "Terminée" }).isVisible(), "Hôte : voit la recharge terminée sans recharger");
  await shot(host, "hote-historique");

  // 7. L'hôte vérifie son propre QR
  await host.goto(`${BASE_URL}/s/${key}`);
  ok(await host.getByText("Ce QR fonctionne").isVisible(), "Hôte : scanner son propre QR confirme qu'il fonctionne");

  // 8. Désactiver / réactiver le spot
  const tomorrow = Date.now() + 86400_000;
  const { data: spotRow } = await H.c.from("spots").select("id").eq("title", TITLE).single();
  const { data: future } = await D.c.from("bookings")
    .insert({ spot_id: spotRow.id, driver_id: D.id, start_at: new Date(tomorrow).toISOString(), end_at: new Date(tomorrow + 3600_000).toISOString() })
    .select("id").single();
  await host.goto(`${BASE_URL}/host`);
  const hostCard = host.locator("article", { hasText: TITLE });
  let dialogText = "";
  host.once("dialog", (d) => { dialogText = d.message(); d.dismiss(); });
  await hostCard.getByRole("button", { name: /Désactiver le spot/ }).click();
  await host.waitForTimeout(800);
  ok(/1 réservation à venir/.test(dialogText), "Hôte : avertissement des réservations à venir avant désactivation", dialogText.split("\n")[0]);
  ok(await hostCard.getByText("Actif", { exact: true }).isVisible(), "Hôte : annuler l'avertissement laisse le spot actif");
  await D.c.rpc("cancel_booking", { p_booking_id: future.id });
  host.once("dialog", (d) => d.accept());
  await hostCard.getByRole("button", { name: /Désactiver le spot/ }).click();
  await hostCard.getByText("Désactivé", { exact: true }).waitFor({ timeout: 10000 }).catch(() => {});
  ok(await hostCard.getByText("Désactivé", { exact: true }).isVisible(), "Hôte : spot désactivé");
  await shot(host, "hote-spot-desactive");
  const listed = async () => {
    // On attend la vraie réponse de la recherche, sinon « absent de la liste » serait vrai trop tôt
    const searched = driver.waitForResponse((r) => r.url().includes("/rpc/nearby_spots"), { timeout: 30000 });
    await driver.goto(`${BASE_URL}/map`);
    await searched;
    await driver.getByRole("tab", { name: "Liste" }).click();
    await driver.waitForTimeout(500);
    return driver.getByRole("link", { name: new RegExp(TITLE.replace(/[[\]]/g, "\\$&")) }).isVisible();
  };
  ok(!(await listed()), "Conducteur : le spot désactivé n'est plus sur la carte");
  await driver.goto(`${BASE_URL}/bookings`);
  const keptName = await driver.locator("article", { hasText: TITLE }).first().isVisible();
  ok(keptName, "Conducteur : l'historique garde le nom du spot désactivé", keptName ? "" : "migration 20261113000000_spots_visible_to_past_drivers.sql non appliquée ?");
  await hostCard.getByRole("button", { name: /Réactiver le spot/ }).click();
  await hostCard.getByText("Actif", { exact: true }).waitFor({ timeout: 10000 }).catch(() => {});
  ok(await hostCard.getByText("Actif", { exact: true }).isVisible(), "Hôte : spot réactivé, sans confirmation");
  ok(await listed(), "Conducteur : le spot réactivé réapparaît sur la carte");

  // Seule erreur attendue : le refus HTTP 400 de la tentative de triche
  const unexpected = [...new Set(errors)].filter((e) => !/status of 400/.test(e));
  ok(unexpected.length === 0, "Aucune erreur inattendue dans la console", unexpected.join(" | "));

  await hideTestSpots(H.c, H.id);
  await browser.close();
  console.log(`Captures : ${OUT}`);
  done();
} catch (e) {
  await browser?.close();
  crash(e);
}
