// Horaires de disponibilité : plages hebdomadaires (dont plages de nuit), fermetures, contrôle par la base,
// créneaux déjà pris, filtre « Disponible maintenant », puis l'écran de l'hôte et la fiche du conducteur.
// Prérequis : migration 20261118000000_spot_availability.sql ; l'app tourne (npm run dev) pour la partie navigateur.
// Usage : npm run test:e2e:availability
process.env.TZ = "Europe/Paris"; // les horaires sont exprimés à l'heure de Paris
import { chromium } from "playwright";
import { BASE_URL, TEST_PREFIX, login, client, reporter, crash, cancelOpenBookings, hideTestSpots } from "./lib.mjs";
import { sessionCookies, wire } from "./browser.mjs";

const { ok, expectErr, done } = reporter();
const pad = (n) => String(n).padStart(2, "0");
/** Lundi prochain (au moins 2 jours plus tard) à 00:00, heure de Paris. */
const monday = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((8 - (d.getDay() || 7)) % 7 || 7));
  if (d.getTime() - Date.now() < 2 * 86_400_000) d.setDate(d.getDate() + 7);
  return d;
})();
/** Jour j après lundi prochain (0 = lundi), à HH:MM, heure de Paris. */
const at = (day, time) => {
  const d = new Date(monday);
  d.setDate(d.getDate() + day);
  const [h, m] = time.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d;
};
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localInput = (d) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const WEEK_NIGHTS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "18:00", closes: "08:00" })).concat({ weekday: 6, opens: "00:00", closes: "00:00" });

let browser;
try {
  const H = await login("host"), D = await login("driver"), anon = client();
  await cancelOpenBookings(D.c);
  await hideTestSpots(H.c, H.id);

  const title = `${TEST_PREFIX} Borne horaires ${Date.now().toString().slice(-5)}`;
  const ins = await H.c.from("spots").insert({ host_id: H.id, title, address: "8 rue du Test, Paris", connector_type: "type2", power_kw: 7.4, price_per_kwh: 0.25, location: "SRID=4326;POINT(2.3522 48.8566)" });
  ok(!ins.error, "Hôte : spot publié", ins.error?.message);
  const { data: spot } = await H.c.from("spots").select("id").eq("title", title).single();
  const book = (from, to) => D.c.from("bookings").insert({ spot_id: spot.id, driver_id: D.id, start_at: from.toISOString(), end_at: to.toISOString() }).select("id").single();
  const cancel = (b) => b?.data && D.c.rpc("cancel_booking", { p_booking_id: b.data.id });

  // 1. Sans horaires : réservable à toute heure (comportement d'avant)
  const any = await book(at(1, "12:00"), at(1, "14:00"));
  ok(!any.error, "Sans horaires : réservable à toute heure", any.error?.message);
  await cancel(any);

  // 2. Seul l'hôte règle les horaires
  expectErr(await D.c.rpc("set_spot_hours", { p_spot_id: spot.id, p_hours: [] }), "Un autre utilisateur ne peut pas régler les horaires");
  expectErr(await H.c.from("spot_hours").insert({ spot_id: spot.id, weekday: 1, opens: "08:00", closes: "09:00" }), "Pas d'écriture directe dans les horaires");
  const set = await H.c.rpc("set_spot_hours", { p_spot_id: spot.id, p_hours: WEEK_NIGHTS });
  ok(!set.error, "Hôte : lun–ven 18:00 → 08:00, samedi toute la journée", set.error?.message);
  expectErr(await H.c.rpc("set_spot_hours", { p_spot_id: spot.id, p_hours: [{ weekday: 9, opens: "18:00", closes: "20:00" }] }), "Jour invalide refusé");
  const seen = (await D.c.from("spot_hours").select("weekday").eq("spot_id", spot.id)).data ?? [];
  ok(seen.length === 6, "Conducteur : voit les 6 plages (une plage invalide n'a rien effacé)", `${seen.length}`);
  ok(((await anon.from("spot_hours").select("weekday").eq("spot_id", spot.id)).data ?? []).length === 6, "Visiteur non connecté : voit les horaires");

  // 3. La base applique les horaires
  const evening = await book(at(0, "19:00"), at(0, "22:00"));
  ok(!evening.error, "Lundi 19:00 → 22:00 : accepté", evening.error?.message);
  const night = await book(at(0, "23:00"), at(1, "06:00"));
  ok(!night.error, "Nuit de lundi 23:00 → mardi 06:00 : acceptée", night.error?.message);
  const noon = await book(at(1, "12:00"), at(1, "14:00"));
  ok(/horaires/.test(noon.error?.message ?? ""), "Mardi 12:00 → 14:00 : refusé (hors horaires)", noon.error?.message ?? "accepté !");
  const morning = await book(at(1, "07:00"), at(1, "09:00"));
  ok(/horaires/.test(morning.error?.message ?? ""), "Mardi 07:00 → 09:00 : refusé (déborde après 08:00)", morning.error?.message ?? "accepté !");
  const weekend = await book(at(4, "22:00"), at(5, "09:00"));
  ok(!weekend.error, "Vendredi 22:00 → samedi 09:00 : accepté (nuit + samedi enchaînés)", weekend.error?.message);
  const sunday = await book(at(5, "20:00"), at(6, "02:00"));
  ok(/horaires/.test(sunday.error?.message ?? ""), "Samedi 20:00 → dimanche 02:00 : refusé (dimanche fermé)", sunday.error?.message ?? "accepté !");

  // 4. Fermetures ponctuelles
  expectErr(await D.c.from("spot_closures").insert({ spot_id: spot.id, starts_on: ymd(at(2, "00:00")), ends_on: ymd(at(2, "00:00")) }), "Un autre utilisateur ne peut pas fermer le spot");
  const cl = await H.c.from("spot_closures").insert({ spot_id: spot.id, starts_on: ymd(at(2, "00:00")), ends_on: ymd(at(2, "00:00")), reason: "Travaux" }).select("id").single();
  ok(!cl.error, "Hôte : ferme le spot le mercredi", cl.error?.message);
  const closed = await book(at(2, "19:00"), at(2, "21:00"));
  ok(/fermé/.test(closed.error?.message ?? ""), "Mercredi 19:00 → 21:00 : refusé (fermeture)", closed.error?.message ?? "accepté !");
  const thu = await book(at(3, "19:00"), at(3, "21:00"));
  ok(!thu.error, "Jeudi 19:00 → 21:00 : accepté (lendemain de la fermeture)", thu.error?.message);
  expectErr(await H.c.from("spot_closures").insert({ spot_id: spot.id, starts_on: ymd(at(3, "00:00")), ends_on: ymd(at(2, "00:00")) }), "Fermeture à l'envers refusée");

  // 5. Créneaux déjà pris : visibles, sans dire par qui
  const busy = await anon.rpc("spot_busy_slots", { p_spot_id: spot.id });
  ok(!busy.error && busy.data.length === 4, "Créneaux déjà pris visibles (4)", busy.error?.message ?? `${busy.data.length}`);
  ok(busy.data.every((r) => Object.keys(r).sort().join() === "end_at,start_at"), "Créneaux déjà pris : ni conducteur ni statut révélés");

  // 6. « Disponible maintenant »
  const today = new Date().getDay() || 7;
  await H.c.rpc("set_spot_hours", { p_spot_id: spot.id, p_hours: [{ weekday: (today % 7) + 1, opens: "00:00", closes: "00:00" }] });
  const closedNow = await anon.rpc("spots_open_now", { p_ids: [spot.id] });
  ok(!closedNow.error && closedNow.data.length === 0, "Fermé aujourd'hui : pas « disponible maintenant »", closedNow.error?.message);
  await H.c.rpc("set_spot_hours", { p_spot_id: spot.id, p_hours: [] });
  const openNow = await anon.rpc("spots_open_now", { p_ids: [spot.id] });
  ok(openNow.data?.length === 1, "Sans horaires ni réservation en cours : « disponible maintenant »", openNow.error?.message);
  const noonAgain = await book(at(1, "12:00"), at(1, "14:00"));
  ok(!noonAgain.error, "Horaires retirés : mardi midi redevient réservable", noonAgain.error?.message);

  for (const b of [evening, night, weekend, thu, noonAgain]) await cancel(b);
  await H.c.from("spot_closures").delete().eq("id", cl.data.id);

  // 7. Navigateur : l'hôte règle ses horaires, le conducteur est guidé
  const ping = await fetch(BASE_URL).catch(() => null);
  if (!ping) {
    ok(false, `Partie navigateur : l'app ne répond pas sur ${BASE_URL} (lancez « npm run dev »)`);
  } else {
    browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
    const errors = [];
    const pageFor = async (role) => {
      const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 }, locale: "fr-FR", timezoneId: "Europe/Paris",
        geolocation: { latitude: 48.8566, longitude: 2.3522 }, permissions: ["geolocation"],
      });
      await wire(ctx, errors);
      await ctx.addCookies(await sessionCookies(role));
      return ctx.newPage();
    };
    const host = await pageFor("host"), driver = await pageFor("driver");

    await host.goto(`${BASE_URL}/host`);
    const card = host.locator("article", { hasText: title });
    const box = card.getByTestId("spot-hours");
    await box.waitFor({ timeout: 15000 });
    ok((await box.locator("summary").textContent()).includes("Disponible à toute heure"), "Hôte : « Disponible à toute heure » par défaut");
    await box.locator("summary").click();
    await box.getByLabel("Selon des horaires").check();
    await box.getByRole("button", { name: /Soirs et nuits/ }).click();
    ok(await box.getByLabel("Lundi : début de la plage 1").inputValue() === "18:00", "Hôte : modèle « soirs et nuits » appliqué");
    await box.getByRole("button", { name: "Enregistrer les horaires" }).click();
    await box.getByText("Horaires enregistrés.").waitFor({ timeout: 10000 }).catch(() => {});
    await host.waitForFunction((t) => [...document.querySelectorAll("article")].some((a) => a.textContent.includes(t) && a.textContent.includes("Lun – Jeu : 18:00 → 08:00 le lendemain")), title, { timeout: 10000 }).catch(() => {});
    ok((await box.locator("summary").textContent()).includes("Lun – Jeu : 18:00 → 08:00 le lendemain"), "Hôte : horaires enregistrés et résumés", (await box.locator("summary").textContent()).trim());
    await box.getByLabel("Du", { exact: true }).fill(ymd(at(2, "00:00")));
    await box.getByPlaceholder(/Motif/).fill("Vacances");
    await box.getByRole("button", { name: "Ajouter une fermeture" }).click();
    await box.getByText("Vacances").waitFor({ timeout: 10000 }).catch(() => {});
    ok(await box.getByText("Vacances").isVisible(), "Hôte : fermeture ajoutée et listée");

    await driver.goto(`${BASE_URL}/spots/${spot.id}`);
    const avail = driver.getByTestId("spot-availability");
    await avail.waitFor({ timeout: 15000 });
    const availText = await avail.textContent();
    ok(availText.includes("18:00 → 08:00 le lendemain") && availText.includes("Vacances"), "Conducteur : horaires et fermeture affichés sur la fiche");
    const submit = driver.getByRole("button", { name: /Demander la réservation/ });
    await driver.waitForFunction(() => document.querySelector('input[type="datetime-local"]')?.value !== "", null, { timeout: 10000 });
    ok(!(await driver.getByTestId("slot-problem").isVisible()) && (await submit.isEnabled()), "Conducteur : un créneau libre est proposé d'office");
    await driver.getByLabel("Début").fill(localInput(at(1, "12:00")));
    await driver.getByLabel("Fin").fill(localInput(at(1, "14:00")));
    const problem = driver.getByTestId("slot-problem");
    await problem.waitFor({ timeout: 5000 }).catch(() => {});
    ok((await problem.textContent().catch(() => "")).includes("horaires") && !(await submit.isEnabled()), "Conducteur : créneau hors horaires signalé, envoi bloqué");
    await driver.getByLabel("Début").fill(localInput(at(2, "19:00")));
    await driver.getByLabel("Fin").fill(localInput(at(2, "21:00")));
    ok((await problem.textContent().catch(() => "")).includes("fermé"), "Conducteur : jour de fermeture signalé");
    await problem.getByRole("button", { name: /Prochain créneau libre/ }).click();
    ok(!(await problem.isVisible()) && (await submit.isEnabled()), "Conducteur : « Prochain créneau libre » choisit un créneau valide");
    const chosen = await driver.getByLabel("Début").inputValue();
    ok(chosen === localInput(at(3, "00:00")), "Prochain créneau libre : jeudi 00:00, juste après la fermeture (fin de la nuit de mercredi)", chosen);
    await submit.click();
    await driver.waitForURL(/\/bookings/, { timeout: 15000 }).catch(() => {});
    ok(driver.url().includes("/bookings"), "Conducteur : demande envoyée sur ce créneau");

    await driver.goto(`${BASE_URL}/map`);
    const chip = driver.getByRole("button", { name: /Disponible maintenant/ });
    await chip.waitFor({ timeout: 20000 }).catch(() => {});
    ok(await chip.isVisible(), "Carte : filtre « Disponible maintenant » proposé");
    ok(errors.length === 0, "Aucune erreur dans la console", errors.slice(0, 3).join(" | "));
  }

  await cancelOpenBookings(D.c);
  await H.c.from("spots").update({ is_active: false }).eq("id", spot.id);
  done();
} catch (e) {
  crash(e);
} finally {
  await browser?.close();
}
