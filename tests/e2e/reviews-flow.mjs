// Avis et notes : une vraie recharge (payée si le paiement est obligatoire), puis le conducteur note
// par l'API, l'hôte note dans le navigateur ; publication en double aveugle, moyennes, fiche du spot.
// Prérequis : migration 20261119000000_reviews.sql ; l'app tourne (npm run dev). Usage : npm run test:e2e:reviews
import { chromium } from "playwright";
import { BASE_URL, CHARGE_SECONDS, TEST_PREFIX, login, client, reporter, sleep, crash, cancelOpenBookings, hideTestSpots, payWithTestCard, paymentsRequired, callPayments } from "./lib.mjs";
import { sessionCookies, wire } from "./browser.mjs";

const { ok, expectErr, done } = reporter();
const escape = (s) => s.replace(/[[\]]/g, "\\$&");

let browser;
try {
  const H = await login("host"), D = await login("driver"), anon = client();
  await cancelOpenBookings(D.c);
  await hideTestSpots(H.c, H.id);

  // 1. Une recharge complète
  const title = `${TEST_PREFIX} Borne avis ${Date.now().toString().slice(-5)}`;
  await H.c.from("spots").insert({ host_id: H.id, title, address: "3 rue du Test, Paris", connector_type: "type2", power_kw: 7.4, price_per_kwh: 0.3, location: "SRID=4326;POINT(2.3522 48.8566)" });
  const { data: spot } = await H.c.from("spots").select("id").eq("title", title).single();
  const { data: key } = await H.c.rpc("get_spot_qr_key", { p_spot_id: spot.id });
  const { data: b, error: be } = await D.c.from("bookings").insert({ spot_id: spot.id, driver_id: D.id, start_at: new Date(Date.now() + 60_000).toISOString(), end_at: new Date(Date.now() + 40 * 60_000).toISOString() }).select("id").single();
  if (be) throw be;
  await H.c.rpc("respond_booking", { p_booking_id: b.id, p_accept: true });

  expectErr(await D.c.rpc("submit_review", { p_booking_id: b.id, p_rating: 5 }), "Impossible de noter avant la fin de la recharge");

  if (await paymentsRequired(D.c)) await payWithTestCard(D.c, b.id);
  const ci = await D.c.rpc("check_in", { p_qr_key: key });
  ok(!ci.error, "Recharge démarrée", ci.error?.message);
  console.log(`… recharge simulée de ${CHARGE_SECONDS} s`);
  await sleep(CHARGE_SECONDS * 1000);
  const co = await D.c.rpc("check_out", { p_qr_key: key, p_energy_kwh: 0.1 });
  ok(!co.error, "Recharge terminée", co.error?.message);
  await callPayments(D.c, "capture", b.id);

  // 2. Le conducteur note l'hôte
  expectErr(await anon.rpc("submit_review", { p_booking_id: b.id, p_rating: 5 }), "Visiteur non connecté : ne peut pas noter");
  expectErr(await D.c.rpc("submit_review", { p_booking_id: b.id, p_rating: 0 }), "Note 0 refusée");
  expectErr(await D.c.rpc("submit_review", { p_booking_id: b.id, p_rating: 6 }), "Note 6 refusée");
  expectErr(await D.c.from("reviews").insert({ booking_id: b.id, spot_id: spot.id, author_id: D.id, target_id: H.id, author_role: "driver", rating: 5 }), "Pas d'écriture directe dans les avis");
  const dr = await D.c.rpc("submit_review", { p_booking_id: b.id, p_rating: 5, p_comment: "  Accueil parfait, câble prêt  " });
  ok(!dr.error && dr.data?.author_role === "driver" && dr.data?.target_id === H.id, "Conducteur : note l'hôte (5 étoiles)", dr.error?.message);
  ok(dr.data?.comment === "Accueil parfait, câble prêt", "Commentaire nettoyé des espaces");
  expectErr(await D.c.rpc("submit_review", { p_booking_id: b.id, p_rating: 1 }), "Un seul avis par recharge");

  // 3. Double aveugle : caché tant que l'hôte n'a pas noté
  ok(((await D.c.from("reviews").select("id").eq("booking_id", b.id)).data ?? []).length === 1, "Conducteur : voit son propre avis");
  ok(((await H.c.from("reviews").select("id").eq("booking_id", b.id)).data ?? []).length === 0, "Hôte : ne voit pas encore l'avis reçu");
  ok(((await anon.rpc("spot_ratings", { p_ids: [spot.id] })).data ?? []).length === 0, "Note du spot pas encore publiée");

  // 4. Navigateur : l'hôte note le conducteur, les deux avis sont publiés
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

  await host.goto(`${BASE_URL}/bookings`);
  const card = host.locator("article", { hasText: title });
  await card.waitFor({ timeout: 15000 });
  const form = card.getByTestId("review-form");
  ok(await form.isVisible(), "Hôte : formulaire « Notez le conducteur » sur la recharge terminée");
  ok(!(await card.getByTestId("received-review").isVisible()), "Hôte : l'avis du conducteur reste caché");
  await form.getByRole("radio", { name: "4 étoiles" }).click();
  await form.getByPlaceholder(/Un mot/).fill("Ponctuel et soigneux");
  await form.getByRole("button", { name: "Publier mon avis" }).click();
  await card.getByTestId("received-review").waitFor({ timeout: 15000 }).catch(() => {});
  ok((await card.getByTestId("received-review").textContent().catch(() => "")).includes("Accueil parfait"), "Hôte : après avoir noté, voit l'avis du conducteur");
  ok((await card.getByTestId("my-review").textContent().catch(() => "")).includes("Ponctuel"), "Hôte : sa note est affichée");
  ok(!(await form.isVisible()), "Hôte : formulaire retiré après publication");

  await driver.goto(`${BASE_URL}/bookings`);
  const dcard = driver.locator("article", { hasText: title });
  await dcard.waitFor({ timeout: 15000 });
  ok((await dcard.getByTestId("received-review").textContent().catch(() => "")).includes("Ponctuel et soigneux"), "Conducteur : voit l'avis de l'hôte");
  ok(await dcard.getByRole("img", { name: "5 sur 5" }).isVisible(), "Conducteur : sa note en étoiles (5 sur 5)");

  // 5. Moyennes publiques
  const sr = (await anon.rpc("spot_ratings", { p_ids: [spot.id] })).data ?? [];
  ok(sr.length === 1 && Number(sr[0].avg_rating) === 5 && sr[0].review_count === 1, "Note du spot publiée : 5,0 (1 avis)", JSON.stringify(sr));
  const pr = (await anon.rpc("profile_ratings", { p_ids: [D.id] })).data ?? [];
  ok(pr.length === 1 && pr[0].driver_count >= 1, "Note du conducteur publiée", JSON.stringify(pr));
  const list = (await anon.rpc("spot_reviews", { p_spot_id: spot.id })).data ?? [];
  ok(list.length === 1 && list[0].comment === "Accueil parfait, câble prêt", "Avis listé sur le spot");
  ok(list.every((r) => !("author_id" in r) && !("booking_id" in r)), "Avis publics : ni identifiant ni réservation exposés");

  // 6. Fiche du spot et liste
  await driver.goto(`${BASE_URL}/spots/${spot.id}`);
  const box = driver.getByTestId("spot-reviews");
  await box.waitFor({ timeout: 15000 });
  const text = await box.textContent();
  ok(text.includes("★ 5,0 · 1 avis") && text.includes("Accueil parfait"), "Fiche du spot : moyenne et avis affichés", text.slice(0, 120));
  await driver.goto(`${BASE_URL}/map`);
  await driver.getByRole("tab", { name: "Liste" }).click();
  const item = driver.getByRole("link", { name: new RegExp(escape(title)) });
  await item.waitFor({ timeout: 15000 }).catch(() => {});
  ok((await item.textContent().catch(() => "")).includes("★ 5,0 · 1 avis"), "Liste des spots : note affichée");

  // 7. L'hôte voit la note du conducteur sur une nouvelle demande
  const { data: b2 } = await D.c.from("bookings").insert({ spot_id: spot.id, driver_id: D.id, start_at: new Date(Date.now() + 86_400_000).toISOString(), end_at: new Date(Date.now() + 90_000_000).toISOString() }).select("id").single();
  await host.goto(`${BASE_URL}/bookings`);
  const req = host.locator("article", { hasText: "En attente" }).filter({ hasText: title }).first();
  await req.waitFor({ timeout: 15000 }).catch(() => {});
  ok(/★ \d,\d · \d+ avis/.test(await req.textContent().catch(() => "")), "Hôte : note du conducteur visible sur sa demande");
  await D.c.rpc("cancel_booking", { p_booking_id: b2.id });

  // Requêtes coupées par une navigation (ERR_FAILED) : sans conséquence, ignorées comme dans ui-flow
  const unexpected = [...new Set(errors)].filter((e) => !/stripe|ERR_FAILED|net::/i.test(e));
  ok(unexpected.length === 0, "Aucune erreur inattendue dans la console", unexpected.slice(0, 3).join(" | "));
  await H.c.from("spots").update({ is_active: false }).eq("id", spot.id);
  done();
} catch (e) {
  crash(e);
} finally {
  await browser?.close();
}
