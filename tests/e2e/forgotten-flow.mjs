// Recharge oubliée, de bout en bout sur la vraie base (LONG : environ 1 h 10).
// Le conducteur paie, démarre et ne termine pas. Sans aucune action, les tâches planifiées
// doivent clôturer la recharge 1 h après la fin du créneau ; l'hôte déclare alors les kWh,
// ce qui déclenche le prélèvement réel et le reversement.
// Usage : npm run test:e2e:forgotten
import { login, reporter, sleep, crash, cancelOpenBookings, callPayments, payWithTestCard, paymentsRequired, TEST_PREFIX } from "./lib.mjs";

const { ok, expectErr, done } = reporter();
const stamp = () => new Date().toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris" });

try {
  const H = await login("host"), D = await login("driver");
  await cancelOpenBookings(D.c);

  // Spot puissant et cher : quelques minutes branchées suffisent à dépasser le minimum Stripe (0,50 €)
  const title = `${TEST_PREFIX} Borne oubli ${Date.now().toString().slice(-5)}`;
  await H.c.from("spots").insert({ host_id: H.id, title, address: "4 rue du Test, Paris", connector_type: "type2", power_kw: 22, price_per_kwh: 2, location: "SRID=4326;POINT(2.353 48.853)" });
  const { data: spot } = await H.c.from("spots").select("id").eq("title", title).single();
  const { data: key } = await H.c.rpc("get_spot_qr_key", { p_spot_id: spot.id });

  // Créneau de 3 minutes qui commence tout de suite
  const { data: b } = await D.c.from("bookings").insert({ spot_id: spot.id, driver_id: D.id, start_at: new Date(Date.now() + 5_000).toISOString(), end_at: new Date(Date.now() + 3 * 60_000).toISOString() }).select("id, end_at").single();
  await H.c.rpc("respond_booking", { p_booking_id: b.id, p_accept: true });
  if (await paymentsRequired(D.c)) await payWithTestCard(D.c, b.id);
  const ci = await D.c.rpc("check_in", { p_qr_key: key });
  ok(ci.data?.status === "active", "Recharge démarrée (puis oubliée par le conducteur)", ci.error?.message);
  expectErr(await H.c.rpc("declare_meter", { p_booking_id: b.id, p_energy_kwh: 0.4 }), "Relevé de l'hôte refusé tant que la recharge n'est pas clôturée");

  // Attente de la clôture automatique : fin du créneau + 1 h, tâche toutes les 5 min
  const deadline = new Date(b.end_at).getTime() + 70 * 60_000;
  console.log(`${stamp()} attente de la clôture automatique (vers ${new Date(new Date(b.end_at).getTime() + 3_600_000).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris" })}, tâche toutes les 5 min)…`);
  let status = "active";
  while (Date.now() < deadline && status === "active") {
    await sleep(60_000);
    status = (await D.c.from("bookings").select("status").eq("id", b.id).single()).data?.status;
    console.log(`${stamp()} réservation : ${status}`);
  }
  const closed = (await H.c.from("bookings").select("status, checked_in_at, checked_out_at, auto_closed_at, end_at").eq("id", b.id).single()).data;
  ok(closed?.status === "awaiting_meter", "Clôture automatique : « Relevé à saisir »", closed?.status);
  ok(closed?.checked_out_at && new Date(closed.checked_out_at).getTime() === new Date(closed.end_at).getTime(), "Durée facturable arrêtée à la fin du créneau");
  const autoMin = closed?.auto_closed_at ? (new Date(closed.auto_closed_at).getTime() - new Date(closed.end_at).getTime()) / 60_000 : NaN;
  ok(autoMin >= 60 && autoMin <= 70, "Clôture entre 60 et 70 min après la fin du créneau", `${autoMin.toFixed(1)} min`);

  // Relevé de l'hôte
  expectErr(await D.c.rpc("declare_meter", { p_booking_id: b.id, p_energy_kwh: 0.4 }), "Le conducteur ne peut pas déclarer à la place de l'hôte");
  expectErr(await H.c.rpc("declare_meter", { p_booking_id: b.id, p_energy_kwh: 500 }), "Relevé impossible refusé (plafond anti-fraude)");
  const decl = await H.c.rpc("declare_meter", { p_booking_id: b.id, p_energy_kwh: 0.4 });
  ok(decl.data?.status === "completed" && Number(decl.data.total_price) === 0.8, "Relevé de l'hôte : 0,4 kWh × 2 € = 0,80 €", decl.error?.message);
  if (await paymentsRequired(D.c)) {
    const cap = await callPayments(H.c, "capture", b.id);
    ok(cap.http === 200 && cap.status === "captured" && cap.amount_cents === 80, "Prélèvement du montant déclaré", JSON.stringify(cap));
    const p = (await H.c.from("payments").select("payout_status").eq("booking_id", b.id).single()).data;
    ok(["transferred", "awaiting_host_account"].includes(p?.payout_status), "Reversement à l'hôte lancé", p?.payout_status);
  }

  await H.c.from("spots").update({ is_active: false }).eq("id", spot.id);
  done();
} catch (e) {
  crash(e);
}
