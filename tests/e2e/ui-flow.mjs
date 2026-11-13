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
  await driver.getByRole("button", { name: /Demander la réservation/ }).click();
  // Premier affichage d'une page en mode dev : Next la compile, ce qui peut prendre plusieurs secondes
  await driver.waitForURL(/\/bookings/, { timeout: 60000 }).catch(() => {});
  const myBk = driver.locator("article", { hasText: TITLE });
  await myBk.filter({ hasText: "En attente" }).waitFor({ timeout: 15000 }).catch(() => {});
  ok(await myBk.filter({ hasText: "En attente" }).isVisible(), "Conducteur : réservation « En attente »");
  await shot(driver, "conducteur-resas-attente");

  // 4. Hôte : voit la demande et accepte
  await host.goto(`${BASE_URL}/bookings`);
  const req = host.locator("article", { hasText: TITLE });
  await req.waitFor({ timeout: 10000 }).catch(() => {});
  ok(await req.isVisible(), "Hôte : voit la demande");
  ok(await req.getByText("j'arrive dans 5 min").isVisible().catch(() => false), "Hôte : voit le message du conducteur");
  ok(await req.getByText(`Conducteur : ${USERS.driver.name}`).isVisible().catch(() => false), "Hôte : voit le nom du conducteur");
  const shown = await req.locator("p", { hasText: "→" }).first().textContent();
  const expected = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" }).format(new Date(Math.floor(startAt.getTime() / 60000) * 60000));
  ok(shown.startsWith(expected), "Heures affichées à l'heure de Paris", `${shown} (attendu ${expected})`);
  await shot(host, "hote-demande");
  await req.getByRole("button", { name: "Accepter" }).click();
  await req.filter({ hasText: "Confirmée" }).waitFor({ timeout: 10000 }).catch(() => {});
  ok(await req.filter({ hasText: "Confirmée" }).isVisible(), "Hôte : réservation confirmée");

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
  await host.reload();
  ok(await host.locator("article", { hasText: TITLE }).filter({ hasText: "En charge" }).isVisible(), "Hôte : voit « En charge »");

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
  await driver.waitForURL(/\/bookings/);
  ok(await driver.locator("article", { hasText: TITLE }).filter({ hasText: "Terminée" }).isVisible(), "Conducteur : historique « Terminée »");
  await shot(driver, "conducteur-historique");
  await host.reload();
  ok(await host.locator("article", { hasText: TITLE }).filter({ hasText: "Terminée" }).isVisible(), "Hôte : voit la recharge terminée");
  await shot(host, "hote-historique");

  // 7. L'hôte vérifie son propre QR
  await host.goto(`${BASE_URL}/s/${key}`);
  ok(await host.getByText("Ce QR fonctionne").isVisible(), "Hôte : scanner son propre QR confirme qu'il fonctionne");

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
