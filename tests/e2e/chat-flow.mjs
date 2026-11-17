// Messagerie conducteur ↔ hôte : envoi par la base, sécurité, non lus, notification push,
// puis conversation en direct dans deux navigateurs (hôte et conducteur) et notification dans l'app.
// Prérequis : migration 20261121000000_booking_messages.sql, fonction à jour, l'app tourne (npm run dev).
// Usage : npm run test:e2e:chat
import { chromium } from "playwright";
import { BASE_URL, TEST_PREFIX, login, client, reporter, sleep, crash, cancelOpenBookings, hideTestSpots, callPayments } from "./lib.mjs";
import { sessionCookies, wire } from "./browser.mjs";

const { ok, expectErr, done } = reporter();

let browser;
try {
  const H = await login("host"), D = await login("driver"), anon = client();
  await cancelOpenBookings(D.c);
  await hideTestSpots(H.c, H.id);

  const title = `${TEST_PREFIX} Borne messages ${Date.now().toString().slice(-5)}`;
  await H.c.from("spots").insert({ host_id: H.id, title, address: "6 rue du Test, Paris", connector_type: "type2", power_kw: 7.4, price_per_kwh: 0.3, location: "SRID=4326;POINT(2.3522 48.8566)" });
  const { data: spot } = await H.c.from("spots").select("id").eq("title", title).single();
  const { data: b, error: be } = await D.c.from("bookings").insert({ spot_id: spot.id, driver_id: D.id, start_at: new Date(Date.now() + 86_400_000).toISOString(), end_at: new Date(Date.now() + 90_000_000).toISOString() }).select("id").single();
  if (be) throw be;
  const send = (c, body) => c.rpc("send_booking_message", { p_booking_id: b.id, p_body: body });

  // 1. Envoi et sécurité
  const m1 = await send(D.c, "  Bonjour, le câble est fourni ?  ");
  ok(!m1.error && m1.data?.sender_id === D.id && m1.data?.body === "Bonjour, le câble est fourni ?", "Conducteur : message envoyé (espaces retirés)", m1.error?.message);
  expectErr(await send(D.c, "   "), "Message vide refusé");
  expectErr(await send(D.c, "x".repeat(1001)), "Message de plus de 1000 caractères refusé");
  expectErr(await anon.rpc("send_booking_message", { p_booking_id: b.id, p_body: "spam" }), "Visiteur non connecté : ne peut pas écrire");
  expectErr(await D.c.from("booking_messages").insert({ booking_id: b.id, sender_id: H.id, body: "faux message de l'hôte" }), "Impossible d'écrire au nom de quelqu'un d'autre");
  ok(((await anon.from("booking_messages").select("id")).data ?? []).length === 0, "Visiteur non connecté : ne lit aucun message");
  const hostSees = (await H.c.from("booking_messages").select("id, read_at").eq("booking_id", b.id)).data ?? [];
  ok(hostSees.length === 1 && hostSees[0].read_at === null, "Hôte : voit le message, non lu");

  // 2. Notification push : envoyée une seule fois par la base (pg_net → fonction)
  await sleep(8000);
  const again = await callPayments(null, "notify_message", undefined, { message_id: m1.data.id });
  ok(again.http === 200 && again.claimed === false, "Notification push : déjà envoyée par la base, pas de doublon", JSON.stringify(again));
  const bad = await callPayments(null, "notify_message", undefined, { message_id: "pas-un-id" });
  ok(bad.http === 400, "Notification push : identifiant invalide refusé", `HTTP ${bad.http}`);

  // 3. Navigateur : conversation en direct
  browser = await chromium.launch();
  const errors = [];
  const pageFor = async (role) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR", timezoneId: "Europe/Paris" });
    await wire(ctx, errors);
    await ctx.addCookies(await sessionCookies(role));
    return ctx.newPage();
  };
  const host = await pageFor("host"), driver = await pageFor("driver");
  const chatOf = (p) => p.locator(`#booking-${b.id}`).getByTestId("booking-chat");

  await host.goto(`${BASE_URL}/bookings`);
  const hChat = chatOf(host);
  await hChat.waitFor({ timeout: 15000 });
  ok((await hChat.getByTestId("chat-unread").textContent().catch(() => "")).includes("1 non lu"), "Hôte : « 1 non lu » sur la réservation");
  await hChat.getByRole("button", { name: /Messages avec/ }).click();
  await hChat.getByText("Bonjour, le câble est fourni ?").waitFor({ timeout: 10000 }).catch(() => {});
  ok(await hChat.getByText("Bonjour, le câble est fourni ?").isVisible(), "Hôte : ouvre la conversation et lit le message");
  let read;
  for (let i = 0; i < 10 && !(read = (await D.c.from("booking_messages").select("read_at").eq("id", m1.data.id).single()).data?.read_at); i++) await sleep(500);
  ok(!!read && !(await hChat.getByTestId("chat-unread").isVisible()), "Message marqué comme lu à l'ouverture");

  await driver.goto(`${BASE_URL}/bookings`);
  const dChat = chatOf(driver);
  await dChat.waitFor({ timeout: 15000 });
  await dChat.getByRole("button", { name: /Messages avec l'hôte/ }).click();
  await dChat.getByText("Bonjour, le câble est fourni ?").waitFor({ timeout: 10000 }).catch(() => {});
  ok(await dChat.getByText("Lu", { exact: true }).isVisible().catch(() => false), "Conducteur : son message est marqué « Lu »");
  await host.waitForTimeout(2000); // abonnements Realtime actifs des deux côtés

  await hChat.getByLabel("Votre message").fill("Oui, il est dans le coffret vert");
  await hChat.getByLabel("Votre message").press("Enter");
  await dChat.getByText("Oui, il est dans le coffret vert").waitFor({ timeout: 15000 }).catch(() => {});
  ok(await dChat.getByText("Oui, il est dans le coffret vert").isVisible(), "Temps réel : le conducteur reçoit la réponse sans recharger");
  ok((await hChat.getByLabel("Votre message").inputValue()) === "", "Hôte : champ vidé après envoi (Entrée)");

  await dChat.getByRole("button", { name: "Je suis devant" }).click();
  await hChat.getByText("Je suis devant").waitFor({ timeout: 15000 }).catch(() => {});
  ok(await hChat.getByText("Je suis devant").isVisible(), "Message rapide « Je suis devant » reçu en direct par l'hôte");
  ok(!(await host.getByTestId("live-toast").filter({ hasText: "Nouveau message" }).isVisible()), "Pas de notification pour une conversation déjà ouverte");

  // 4. Notification dans l'app quand la conversation est fermée
  await driver.goto(`${BASE_URL}/map`);
  await driver.waitForTimeout(3000);
  await send(H.c, "Je vous attends, portail ouvert");
  const toast = driver.getByTestId("live-toast").filter({ hasText: "Nouveau message" });
  await toast.waitFor({ timeout: 15000 }).catch(() => {});
  ok((await toast.textContent().catch(() => "")).includes("portail ouvert"), "Conducteur ailleurs dans l'app : notification « 💬 Nouveau message »");
  await toast.getByRole("link", { name: "Voir" }).click();
  await driver.waitForURL(/\/bookings/, { timeout: 15000 }).catch(() => {});
  await chatOf(driver).getByText("Je vous attends, portail ouvert").waitFor({ timeout: 15000 }).catch(() => {});
  ok(await chatOf(driver).getByText("Je vous attends, portail ouvert").isVisible(), "« Voir » ouvre directement la bonne conversation");

  // 5. Limite anti-abus : 10 messages par minute
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await send(H.c, `Test ${i}`);
    if (r.error) limited = r.error.message;
  }
  ok(/patientez/.test(limited ?? ""), "Plus de 10 messages par minute : refusé", limited ?? "jamais limité");

  const unexpected = [...new Set(errors)].filter((e) => !/stripe|ERR_FAILED|net::/i.test(e));
  ok(unexpected.length === 0, "Aucune erreur inattendue dans la console", unexpected.slice(0, 3).join(" | "));

  await D.c.rpc("cancel_booking", { p_booking_id: b.id });
  await H.c.from("spots").update({ is_active: false }).eq("id", spot.id);
  done();
} catch (e) {
  crash(e);
} finally {
  await browser?.close();
}
