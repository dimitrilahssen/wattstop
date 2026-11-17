// Règle d'annulation : carte enregistrée exigée pour réserver, annulations gratuites, annulation tardive
// et absence facturées 2 € (prélevés sur la carte, reversés à l'hôte), confirmation dans le navigateur.
// Dure ~12 min : l'annulation tardive suppose que les 10 min de grâce après la demande soient passées.
// Prérequis : migration 20261120000000_cancellation_policy.sql, fonction à jour, paiement obligatoire,
// l'app tourne (npm run dev). Usage : npm run test:e2e:cancellation
import { chromium } from "playwright";
import { BASE_URL, TEST_PREFIX, login, reporter, sleep, crash, cancelOpenBookings, hideTestSpots, callPayments, ensureTestCard, paymentsRequired } from "./lib.mjs";
import { sessionCookies, wire } from "./browser.mjs";

const { ok, expectErr, done } = reporter();
const min = (n) => new Date(Date.now() + n * 60_000).toISOString();

let browser;
try {
  const H = await login("host"), D = await login("driver");
  if (!(await paymentsRequired(D.c))) throw new Error("Le paiement doit être obligatoire (app_settings.payments_required = true)");
  await cancelOpenBookings(D.c);
  await hideTestSpots(H.c, H.id);

  const title = `${TEST_PREFIX} Borne annulation ${Date.now().toString().slice(-5)}`;
  await H.c.from("spots").insert({ host_id: H.id, title, address: "4 rue du Test, Paris", connector_type: "type2", power_kw: 7.4, price_per_kwh: 0.3, location: "SRID=4326;POINT(2.3522 48.8566)" });
  const { data: spot } = await H.c.from("spots").select("id").eq("title", title).single();
  const book = async (from, to) => {
    const r = await D.c.from("bookings").insert({ spot_id: spot.id, driver_id: D.id, start_at: min(from), end_at: min(to) }).select("id").single();
    if (r.error) throw r.error;
    return r.data.id;
  };
  const accept = (id) => H.c.rpc("respond_booking", { p_booking_id: id, p_accept: true });
  const feeOf = async (id) => (await D.c.from("booking_fees").select("*").eq("booking_id", id).maybeSingle()).data;

  // 1. Carte enregistrée obligatoire pour réserver
  const { data: policy } = await D.c.from("app_settings").select("cancellation_fee_cents, free_cancellation_minutes, cancellation_grace_minutes").single();
  ok(policy?.cancellation_fee_cents === 200 && policy?.free_cancellation_minutes === 120, "Règle : 2 € de frais, gratuit jusqu'à 2 h avant", JSON.stringify(policy));
  const rm = await callPayments(D.c, "card_remove");
  ok(rm.http === 200, "Conducteur : retire sa carte (aucune réservation en cours)", rm.error);
  const noCard = await D.c.from("bookings").insert({ spot_id: spot.id, driver_id: D.id, start_at: min(1440), end_at: min(1500) });
  ok(/carte bancaire/.test(noCard.error?.message ?? ""), "Sans carte enregistrée : demande refusée par la base", noCard.error?.message ?? "acceptée !");
  const card = await ensureTestCard(D.c);
  ok(card?.brand === "visa" && card?.last4 === "4242", "Carte de test enregistrée (rien n'est prélevé)", JSON.stringify(card));
  expectErr(await D.c.from("driver_cards").select("stripe_customer_id"), "Identifiant client Stripe illisible côté navigateur");
  expectErr(await D.c.from("driver_cards").update({ card_last4: "0000" }).eq("driver_id", D.id).select(), "Carte non modifiable côté navigateur");
  const unauth = await callPayments(null, "card_setup");
  ok(unauth.http === 401, "Enregistrer une carte : connexion obligatoire", `HTTP ${unauth.http}`);

  // 2. Annulations gratuites
  const tomorrow = await book(1440, 1500);
  await accept(tomorrow);
  await D.c.rpc("cancel_booking", { p_booking_id: tomorrow });
  ok(!(await feeOf(tomorrow)), "Annulée la veille : gratuite");
  const pendingSoon = await book(30, 60);
  await D.c.rpc("cancel_booking", { p_booking_id: pendingSoon });
  ok(!(await feeOf(pendingSoon)), "Demande pas encore acceptée, annulée 30 min avant : gratuite");
  const graceSoon = await book(30, 60);
  await accept(graceSoon);
  await D.c.rpc("cancel_booking", { p_booking_id: graceSoon });
  ok(!(await feeOf(graceSoon)), "Annulée dans les 10 min qui suivent la demande : gratuite");

  // 3. Réservations qui deviendront tardives / non honorée
  const late = await book(70, 100);
  const hostLate = await book(101, 130);
  const absent = await book(1, 4);
  const later = await book(2880, 2940); // dans 2 jours : annulation gratuite affichée
  for (const id of [late, hostLate, absent, later]) await accept(id);
  expectErr(await D.c.from("booking_fees").insert({ booking_id: late, kind: "late_cancellation", amount_cents: 1 }), "Impossible d'inventer des frais côté navigateur");

  console.log("… attente de la fin des 10 min de grâce (et du créneau de la réservation non honorée)");
  await sleep(5 * 60_000);
  await D.c.rpc("expire_bookings");
  const ns = (await D.c.from("bookings").select("status").eq("id", absent).single()).data;
  ok(ns?.status === "no_show", "Créneau terminé sans venir : « Non honorée »", ns?.status);
  let nsFee;
  for (let i = 0; i < 20 && (nsFee = await feeOf(absent))?.status !== "charged"; i++) await sleep(3000);
  ok(nsFee?.kind === "no_show" && nsFee?.amount_cents === 200 && nsFee?.status === "charged", "Absence : 2 € prélevés sur la carte enregistrée", JSON.stringify(nsFee && { kind: nsFee.kind, status: nsFee.status, err: nsFee.failure_message }));
  await sleep(6 * 60_000);

  // 4. L'hôte annule tard : jamais de frais pour le conducteur
  await H.c.rpc("cancel_booking", { p_booking_id: hostLate });
  ok(!(await feeOf(hostLate)), "Annulation par l'hôte, même tardive : aucun frais pour le conducteur");

  // 5. Navigateur : annulation tardive confirmée par le conducteur
  browser = await chromium.launch();
  const errors = [];
  const pageFor = async (role) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "fr-FR", timezoneId: "Europe/Paris" });
    await wire(ctx, errors);
    await ctx.addCookies(await sessionCookies(role));
    return ctx.newPage();
  };
  const driver = await pageFor("driver"), host = await pageFor("host");
  await driver.goto(`${BASE_URL}/bookings`);
  ok((await driver.getByTestId("my-card").textContent().catch(() => "")).includes("Visa •••• 4242"), "Réservations : « Ma carte » affiche Visa •••• 4242");
  const lateCard = driver.locator("article", { hasText: title }).filter({ hasText: "Confirmée" }).filter({ hasText: "de frais" }).first();
  await lateCard.waitFor({ timeout: 15000 });
  const freeCard = driver.locator("article", { hasText: title }).filter({ hasText: "Annulation gratuite jusqu'au" }).first();
  ok(await freeCard.isVisible(), "Réservation dans 2 jours : « Annulation gratuite jusqu'au … »");
  ok((await lateCard.getByTestId("cancel-hint").textContent()).includes("2,00 € de frais"), "Réservation dans 1 h : « Annulation : 2,00 € de frais »");
  await lateCard.getByRole("button", { name: "Annuler" }).click();
  const dialog = lateCard.getByTestId("late-cancel");
  ok(await dialog.isVisible() && (await dialog.textContent()).includes("2,00 €"), "Annuler : confirmation avec le montant des frais");
  await dialog.getByRole("button", { name: "Garder ma réservation" }).click();
  ok(!(await dialog.isVisible()) && !(await feeOf(late)), "« Garder ma réservation » : rien n'est annulé ni prélevé");
  await lateCard.getByRole("button", { name: "Annuler" }).click();
  await lateCard.getByTestId("late-cancel").getByRole("button", { name: "Annuler quand même" }).click();
  let lateFee;
  for (let i = 0; i < 20 && (lateFee = await feeOf(late))?.status !== "charged"; i++) await sleep(3000);
  ok(lateFee?.kind === "late_cancellation" && lateFee?.status === "charged", "Annulation tardive : 2 € prélevés sur la carte", JSON.stringify(lateFee && { status: lateFee.status, err: lateFee.failure_message }));
  ok(lateFee?.payout_status === "transferred" || lateFee?.payout_status === "awaiting_host_account", "Frais reversés à l'hôte (ou mis de côté jusqu'à l'activation de ses paiements)", lateFee?.payout_status);
  const again = await callPayments(null, "charge_fees");
  ok(again.http === 200 && again.charged === 0, "Nouveau passage : rien n'est prélevé deux fois", JSON.stringify(again));

  await driver.reload();
  const feeLine = driver.locator("article", { hasText: title }).getByTestId("fee-line").filter({ hasText: "annulation tardive" }).first();
  await feeLine.waitFor({ timeout: 15000 }).catch(() => {});
  ok((await feeLine.textContent().catch(() => "")).includes("2,00 € prélevés"), "Conducteur : « Frais d'annulation tardive : 2,00 € prélevés »");
  await host.goto(`${BASE_URL}/bookings`);
  const hostLine = host.locator("article", { hasText: title }).getByTestId("fee-line").filter({ hasText: "absence" }).first();
  await hostLine.waitFor({ timeout: 15000 }).catch(() => {});
  ok(/Dédommagement d'absence/.test(await hostLine.textContent().catch(() => "")), "Hôte : dédommagement d'absence affiché");
  ok(errors.length === 0, "Aucune erreur dans la console", errors.slice(0, 3).join(" | "));

  await D.c.rpc("cancel_booking", { p_booking_id: later });
  ok(!(await feeOf(later)), "Annulée 2 jours avant : gratuite");
  await H.c.from("spots").update({ is_active: false }).eq("id", spot.id);
  done();
} catch (e) {
  crash(e);
} finally {
  await browser?.close();
}
