// Parcours de paiement Stripe (mode test) : blocage au démarrage, prélèvement à la fin, libération à l'annulation.
// Prérequis : migration 20261114000000_payments.sql, Edge Function déployée (secret STRIPE_SECRET_KEY),
// NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (pk_test_…) et, si besoin, NEXT_PUBLIC_PAYMENTS_FUNCTION dans .env.local.
// Usage : npm run test:e2e:payments
import { login, client, reporter, sleep, crash, hideTestSpots, cancelOpenBookings, CHARGE_SECONDS, TEST_PREFIX, STRIPE_PK, callPayments, confirmWithTestCard, paymentsRequired } from "./lib.mjs";

const PK = STRIPE_PK;
const pay = callPayments;
const { ok, expectErr, done } = reporter();

if (!PK.startsWith("pk_test_")) {
  console.error("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY doit être une clé de test (pk_test_…) dans .env.local.");
  process.exit(2);
}

const paymentRow = async (c, id) => (await c.from("payments").select("*").eq("booking_id", id).maybeSingle()).data;

try {
  const H = await login("host"), D = await login("driver"), anon = client();
  await cancelOpenBookings(D.c);
  await hideTestSpots(H.c, H.id);

  // Spot puissant et cher pour dépasser le minimum Stripe (0,50 €) en une minute de recharge
  const title = `${TEST_PREFIX} Borne paiement ${Date.now().toString().slice(-5)}`;
  await H.c.from("spots").insert({ host_id: H.id, title, address: "1 rue du Test, Paris", connector_type: "type2", power_kw: 22, price_per_kwh: 2, location: "SRID=4326;POINT(2.35 48.85)" });
  const { data: spot } = await H.c.from("spots").select("id").eq("title", title).single();
  const { data: key } = await H.c.rpc("get_spot_qr_key", { p_spot_id: spot.id });

  const book = async (startMin, endMin) => {
    const { data, error } = await D.c.from("bookings").insert({ spot_id: spot.id, driver_id: D.id, start_at: new Date(Date.now() + startMin * 60_000).toISOString(), end_at: new Date(Date.now() + endMin * 60_000).toISOString() }).select("id").single();
    if (error) throw error;
    await H.c.rpc("respond_booking", { p_booking_id: data.id, p_accept: true });
    return data.id;
  };

  // 1. Autorisation
  const b1 = await book(1, 61);
  const noAuth = await pay(null, "authorize", b1);
  ok(noAuth.http === 401, "Sans connexion : paiement refusé", `HTTP ${noAuth.http}`);
  const asHost = await pay(H.c, "authorize", b1);
  ok(asHost.http === 403, "L'hôte ne peut pas payer à la place du conducteur", `HTTP ${asHost.http} ${asHost.error ?? ""}`);
  if (await paymentsRequired(D.c)) {
    const unpaid = await D.c.rpc("check_in", { p_qr_key: key });
    ok(/Paiement non autorisé/.test(unpaid.error?.message ?? ""), "Paiement obligatoire : démarrage refusé sans carte validée", unpaid.error?.message ?? "DÉMARRAGE ACCEPTÉ (faille)");
  } else {
    console.log("ℹ️  Paiement pas encore obligatoire (app_settings.payments_required = false)");
  }
  const a = await pay(D.c, "authorize", b1);
  ok(a.http === 200 && !!a.client_secret, "Conducteur : demande d'autorisation acceptée", a.error ?? `${(a.amount_cents / 100).toFixed(2)} € à bloquer`);
  const expected = Math.ceil(22 * 1 * 2 * 1.05 * 100); // 22 kW × ~1 h restante × 2 €/kWh × 1,05
  ok(Math.abs(a.amount_cents - expected) <= 100, "Montant bloqué = puissance × durée restante × tarif × 1,05", `${a.amount_cents} cts (attendu ≈ ${expected})`);
  const pending = await paymentRow(D.c, b1);
  ok(pending?.status === "requires_authorization", "Base : paiement en attente de la carte", pending?.status);
  expectErr(await D.c.from("payments").update({ status: "authorized" }).eq("booking_id", b1).select(), "Conducteur : impossible de se marquer « payé » directement");
  expectErr(await D.c.from("payments").insert({ booking_id: b1, stripe_payment_intent_id: "pi_fake", status: "authorized", amount_authorized_cents: 1 }), "Conducteur : impossible d'inventer un paiement");
  const s0 = await pay(D.c, "sync", b1);
  ok(s0.http === 200 && s0.status === "requires_authorization", "Sans carte validée, la synchro ne marque pas « autorisé »", JSON.stringify(s0));

  // 2. Carte de test (ce que fait le formulaire Stripe dans le navigateur)
  const conf = await confirmWithTestCard(a.client_secret);
  ok(conf.status === "requires_capture", "Stripe : carte de test validée, montant bloqué (non prélevé)", conf.status ?? conf.error?.message);
  const s1 = await pay(D.c, "sync", b1);
  ok(s1.http === 200 && s1.status === "authorized" && (await paymentRow(D.c, b1))?.status === "authorized", "Base : paiement « authorized » après vérification auprès de Stripe");
  const again = await pay(D.c, "authorize", b1);
  ok(again.http === 200 && again.status === "authorized" && !again.client_secret, "Ré-autoriser ne bloque pas une seconde fois");
  ok((await paymentRow(H.c, b1))?.status === "authorized", "Hôte : voit le paiement de sa réservation");

  // 3. Recharge puis prélèvement du montant réel
  const ci = await D.c.rpc("check_in", { p_qr_key: key });
  ok(ci.data?.status === "active", "Check-in après paiement", ci.error?.message);
  const early = await pay(D.c, "capture", b1);
  ok(early.http === 409, "Prélèvement refusé tant que la recharge n'est pas terminée", early.error);
  console.log(`… recharge simulée de ${CHARGE_SECONDS} s`);
  await sleep(CHARGE_SECONDS * 1000);
  const co = await D.c.rpc("check_out", { p_qr_key: key, p_energy_kwh: 0.4 });
  ok(co.data?.status === "completed" && Number(co.data.total_price) === 0.8, "Check-out : 0,4 kWh × 2 € = 0,80 €", co.error?.message);
  const cap = await pay(D.c, "capture", b1);
  ok(cap.http === 200 && cap.status === "captured" && cap.amount_cents === 80, "Prélèvement du montant réel (0,80 €), le reste est libéré", JSON.stringify(cap));
  const cap2 = await pay(H.c, "capture", b1);
  ok(cap2.http === 200 && cap2.status === "captured" && cap2.amount_cents === 80, "Prélever deux fois ne débite pas deux fois", JSON.stringify(cap2));
  ok((await paymentRow(D.c, b1))?.status === "captured", "Base : paiement « captured »");

  // 3 bis. Reversement à l'hôte (Stripe Connect)
  const hostAccount = (await H.c.from("host_payout_accounts").select("transfers_active").maybeSingle()).data;
  const row1 = await paymentRow(H.c, b1);
  if (hostAccount?.transfers_active) {
    ok(row1?.payout_status === "transferred" && !!row1?.stripe_transfer_id, "Reversement : 0,80 € transférés sur le compte Stripe de l'hôte", JSON.stringify({ payout: row1?.payout_status, transfer: row1?.stripe_transfer_id }));
  } else {
    ok(row1?.payout_status === "awaiting_host_account" && row1?.host_amount_cents === 80, "Reversement : sans compte activé, la part de l'hôte est mise de côté", JSON.stringify({ payout: row1?.payout_status, part: row1?.host_amount_cents }));
  }
  const st = await pay(H.c, "connect_status");
  ok(st.http === 200 && (hostAccount?.transfers_active ? st.transferred_cents >= 80 : st.pending_cents >= 80), "Hôte : voit ses gains reversés ou en attente", JSON.stringify(st));
  const noOrigin = await pay(H.c, "connect_onboard");
  ok(noOrigin.http === 400, "Activation : adresse de retour obligatoire", noOrigin.error);
  const badOrigin = await callPayments(H.c, "connect_onboard", undefined, { origin: "javascript:alert(1)" });
  ok(badOrigin.http === 400, "Activation : adresse de retour piégée refusée", badOrigin.error);
  const notHost = await callPayments(D.c, "connect_onboard", undefined, { origin: "http://localhost:3000" });
  ok(notHost.http === 403, "Activation : réservée aux hôtes", notHost.error);
  if (!hostAccount?.transfers_active) {
    const onb = await callPayments(H.c, "connect_onboard", undefined, { origin: "http://localhost:3000" });
    ok(onb.http === 200 && /^https:\/\/connect\.stripe\.com\//.test(onb.url ?? ""), "Activation : lien vers le formulaire Stripe créé", onb.url ? onb.url.slice(0, 48) + "…" : onb.error);
    const mine = (await H.c.from("host_payout_accounts").select("stripe_account_id").maybeSingle()).data;
    ok(/^acct_/.test(mine?.stripe_account_id ?? ""), "Activation : compte Stripe de l'hôte enregistré", mine?.stripe_account_id);
  }
  const others = (await D.c.from("host_payout_accounts").select("host_id")).data ?? [];
  ok(others.length === 0, "Conducteur : ne voit pas le compte de l'hôte");
  expectErr(await H.c.from("host_payout_accounts").update({ transfers_active: true }).eq("host_id", H.id).select(), "Hôte : impossible de se déclarer « activé » lui-même");

  // 4. Réservation annulée après blocage : le montant est libéré
  const b2 = await book(65, 125);
  const tooEarly = await pay(D.c, "authorize", b2);
  ok(tooEarly.http === 409, "Pas de blocage plus de 15 min avant le créneau", tooEarly.error);
  await D.c.rpc("cancel_booking", { p_booking_id: b2 });
  const b3 = await book(2, 32);
  const a3 = await pay(D.c, "authorize", b3);
  await confirmWithTestCard(a3.client_secret);
  await pay(D.c, "sync", b3);
  await D.c.rpc("cancel_booking", { p_booking_id: b3 });
  const rel = await pay(D.c, "release", b3);
  ok(rel.http === 200 && rel.status === "canceled" && (await paymentRow(D.c, b3))?.status === "canceled", "Annulation : montant bloqué libéré", JSON.stringify(rel));

  await hideTestSpots(H.c, H.id);
  done();
} catch (e) {
  crash(e);
}
