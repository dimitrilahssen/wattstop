// Parcours complet via l'API Supabase, avec la clé publique uniquement : la RLS est réellement testée.
// Usage : npm run test:e2e:api
import { login, client, reporter, sleep, crash, hideTestSpots, cancelOpenBookings, CHARGE_SECONDS, TEST_PREFIX } from "./lib.mjs";

const SPOT_COLUMNS = "id, host_id, title, description, address, connector_type, power_kw, price_per_kwh, access_instructions, photos, is_active, created_at";
const { ok, expectErr, done } = reporter();

try {
  const H = await login("host"), D = await login("driver"), anon = client();
  await cancelOpenBookings(D.c);
  await hideTestSpots(H.c, H.id);

  // 1. L'hôte publie un spot
  const title = `${TEST_PREFIX} Garage API ${Date.now().toString().slice(-5)}`;
  const ins = await H.c.from("spots").insert({
    host_id: H.id, title, address: "10 rue de Test, Paris", connector_type: "type2", power_kw: 7.4, price_per_kwh: 0.3,
    access_instructions: "Portail gris, code 1234", location: "SRID=4326;POINT(2.3522 48.8566)",
  });
  ok(!ins.error, "Hôte : publie un spot", ins.error?.message);
  const mine = await H.c.from("spots").select(SPOT_COLUMNS).eq("host_id", H.id).eq("title", title).single();
  ok(!mine.error, "Hôte : relit son spot", mine.error?.message);
  const spot = mine.data;
  const prof = await H.c.from("profiles").select("role").eq("id", H.id).single();
  ok(["host", "both"].includes(prof.data?.role), "Hôte : promu hôte automatiquement", `role=${prof.data?.role}`);
  const qr = await H.c.rpc("get_spot_qr_key", { p_spot_id: spot.id });
  ok(/^[0-9a-f]{32}$/.test(qr.data ?? ""), "Hôte : récupère la clé QR", qr.error?.message);
  const key = qr.data;

  // 2. Secret du QR
  expectErr(await D.c.from("spots").select("qr_key").eq("id", spot.id), "Conducteur : lecture directe de qr_key refusée");
  expectErr(await D.c.rpc("get_spot_qr_key", { p_spot_id: spot.id }), "Conducteur : clé QR du spot d'un autre refusée");
  expectErr(await anon.rpc("get_spot_qr_key", { p_spot_id: spot.id }), "Anonyme : clé QR refusée");
  const upd = await D.c.from("spots").update({ price_per_kwh: 0 }).eq("id", spot.id).select("id");
  ok(!upd.error && upd.data.length === 0, "Conducteur : ne peut pas modifier le spot d'un autre");

  // 3. Recherche publique
  const near = await anon.rpc("nearby_spots", { p_lat: 48.8566, p_lng: 2.3522, p_radius_m: 2000, p_limit: 200 });
  ok(near.data?.some((s) => s.id === spot.id), "Anonyme : trouve le spot sur la carte", near.error?.message);
  ok(near.data?.every((s) => !("qr_key" in s)), "nearby_spots n'expose pas qr_key");

  // 4. Réservation
  const start = new Date(Date.now() + 60_000), end = new Date(Date.now() + 2 * 3600_000);
  const slot = { spot_id: spot.id, start_at: start.toISOString(), end_at: end.toISOString() };
  expectErr(await H.c.from("bookings").insert({ ...slot, driver_id: H.id }), "Hôte : réserver son propre spot refusé");
  expectErr(await D.c.from("bookings").insert({ ...slot, driver_id: H.id }), "Conducteur : réserver au nom d'un autre refusé");
  expectErr(await D.c.from("bookings").insert({ ...slot, driver_id: D.id, price_per_kwh: 0, status: "confirmed" }), "Conducteur : forcer prix 0 € / statut confirmé refusé");
  const bk = await D.c.from("bookings").insert({ ...slot, driver_id: D.id, driver_note: "test API" }).select("*").single();
  ok(!bk.error, "Conducteur : réserve un créneau", bk.error?.message);
  const b = bk.data;
  ok(b?.status === "pending" && Number(b?.price_per_kwh) === 0.3 && b?.host_id === H.id, "Trigger : statut, prix et hôte imposés", `status=${b?.status} prix=${b?.price_per_kwh}`);
  expectErr(await D.c.from("bookings").insert({ ...slot, driver_id: D.id }), "Créneau qui chevauche refusé");
  const an = await anon.from("bookings").select("id");
  ok(!!an.error || an.data.length === 0, "Anonyme : ne voit aucune réservation", an.error?.message);
  ok((await H.c.from("bookings").select("id").eq("id", b.id)).data?.length === 1, "Hôte : voit la demande reçue");

  // 5. Statuts uniquement via les fonctions dédiées
  const dupd = await D.c.from("bookings").update({ status: "confirmed" }).eq("id", b.id).select("id");
  ok(!!dupd.error || dupd.data.length === 0, "Conducteur : ne peut pas s'auto-confirmer");
  expectErr(await D.c.rpc("respond_booking", { p_booking_id: b.id, p_accept: true }), "Conducteur : ne peut pas accepter à la place de l'hôte");
  expectErr(await D.c.rpc("check_in", { p_qr_key: key }), "Check-in refusé tant que non confirmé");
  const acc = await H.c.rpc("respond_booking", { p_booking_id: b.id, p_accept: true });
  ok(acc.data?.status === "confirmed", "Hôte : accepte la demande", acc.error?.message);

  // 6. Sur place
  expectErr(await D.c.rpc("check_in", { p_qr_key: "0".repeat(32) }), "Check-in avec un faux QR refusé");
  const res = await D.c.rpc("resolve_qr", { p_qr_key: key });
  ok(res.data?.booking?.id === b.id && res.data?.is_host === false, "Conducteur : scan → spot et réservation reconnus", res.error?.message);
  const ci = await D.c.rpc("check_in", { p_qr_key: key });
  ok(ci.data?.status === "active", "Conducteur : check-in (début de recharge)", ci.error?.message);
  expectErr(await D.c.rpc("cancel_booking", { p_booking_id: b.id }), "Annulation impossible après check-in");
  // 6 bis. Expiration : un second spot, pour ne pas chevaucher la recharge en cours
  const titleB = `${TEST_PREFIX} Garage API expiration ${Date.now().toString().slice(-5)}`;
  await H.c.from("spots").insert({ host_id: H.id, title: titleB, address: "12 rue de Test, Paris", connector_type: "type2", power_kw: 7.4, price_per_kwh: 0.3, location: "SRID=4326;POINT(2.353 48.857)" });
  const { data: spotB } = await H.c.from("spots").select("id").eq("title", titleB).single();
  // a) Demande dont le créneau a déjà commencé (1 min) : l'hôte ne peut plus l'accepter
  const late = await D.c.from("bookings").insert({ spot_id: spotB.id, driver_id: D.id, start_at: new Date(Date.now() - 60_000).toISOString(), end_at: new Date(Date.now() + 10 * 60_000).toISOString() }).select("id").single();
  ok(!late.error, "Expiration : demande sur un créneau qui vient de commencer", late.error?.message);
  const lateAcc = await H.c.rpc("respond_booking", { p_booking_id: late.data?.id, p_accept: true });
  ok(/expirée/i.test(lateAcc.error?.message ?? ""), "Expiration : l'hôte ne peut plus accepter une demande au créneau commencé", lateAcc.error?.message ?? "ACCEPTÉE (faille)");
  expectErr(await anon.rpc("expire_bookings"), "Expiration : un visiteur anonyme ne peut pas lancer l'expiration");
  const ex = await D.c.rpc("expire_bookings");
  ok(!ex.error, "Expiration : un utilisateur connecté peut la lancer", ex.error?.message ?? "");
  const lateRow = await D.c.from("bookings").select("status").eq("id", late.data?.id).single();
  ok(lateRow.data?.status === "expired", "Expiration : demande sans réponse → « expired »", `status=${lateRow.data?.status}`);
  const free = await D.c.from("bookings").insert({ spot_id: spotB.id, driver_id: D.id, start_at: new Date(Date.now() + 60_000).toISOString(), end_at: new Date(Date.now() + 5 * 60_000).toISOString() }).select("id").single();
  ok(!free.error, "Expiration : le créneau d'une demande expirée est libéré", free.error?.message);
  await D.c.rpc("cancel_booking", { p_booking_id: free.data?.id });
  // b) Réservation confirmée sur un créneau très court, jamais démarrée → « no_show » après la recharge simulée
  const shortSlot = await D.c.from("bookings").insert({ spot_id: spotB.id, driver_id: D.id, start_at: new Date(Date.now() + 10_000).toISOString(), end_at: new Date(Date.now() + 40_000).toISOString() }).select("id").single();
  const shortAcc = await H.c.rpc("respond_booking", { p_booking_id: shortSlot.data?.id, p_accept: true });
  ok(shortAcc.data?.status === "confirmed", "Expiration : réservation courte acceptée (pour le test « non honorée »)", shortAcc.error?.message);

  console.log(`… recharge simulée de ${CHARGE_SECONDS} s`);
  await sleep(CHARGE_SECONDS * 1000);
  expectErr(await D.c.rpc("check_out", { p_qr_key: key, p_energy_kwh: 50 }), "Check-out avec 50 kWh refusé (anti-fraude)");
  const co = await D.c.rpc("check_out", { p_qr_key: key, p_energy_kwh: 0.12 });
  ok(co.data?.status === "completed" && Number(co.data?.total_price) === 0.04, "Conducteur : check-out, prix calculé", co.error?.message ?? `${co.data?.energy_kwh} kWh → ${co.data?.total_price} €`);
  await D.c.rpc("expire_bookings");
  const noShow = await H.c.from("bookings").select("status").eq("id", shortSlot.data?.id).single();
  ok(noShow.data?.status === "no_show", "Expiration : confirmée mais jamais démarrée → « no_show »", `status=${noShow.data?.status}`);
  const stillDone = await D.c.from("bookings").select("status").eq("id", b.id).single();
  ok(stillDone.data?.status === "completed", "Expiration : une recharge terminée n'est pas touchée");
  const hb = await H.c.from("bookings").select("status,total_price").eq("id", b.id).single();
  ok(hb.data?.status === "completed", "Hôte : voit la recharge terminée", JSON.stringify(hb.data));

  // 7. Annulation d'une réservation à venir
  const b2 = await D.c.from("bookings").insert({ spot_id: spot.id, driver_id: D.id, start_at: new Date(Date.now() + 86400_000).toISOString(), end_at: new Date(Date.now() + 90000_000).toISOString() }).select("id").single();
  const cc = await D.c.rpc("cancel_booking", { p_booking_id: b2.data?.id });
  ok(cc.data?.status === "cancelled", "Conducteur : annule une réservation à venir", cc.error?.message);

  // 8. Spot retiré par l'hôte : il quitte la carte, mais reste dans l'historique du conducteur
  await hideTestSpots(H.c, H.id);
  const gone = await anon.rpc("nearby_spots", { p_lat: 48.8566, p_lng: 2.3522, p_radius_m: 2000, p_limit: 200 });
  ok(!gone.data?.some((s) => s.id === spot.id), "Spot désactivé : n'apparaît plus sur la carte");
  const hist = await D.c.from("bookings").select("spot:spots(title)").eq("id", b.id).single();
  ok(hist.data?.spot?.title === title, "Spot désactivé : le conducteur garde son nom dans l'historique",
    hist.data?.spot ? "" : "migration 20261113000000_spots_visible_to_past_drivers.sql non appliquée ?");
  done();
} catch (e) {
  crash(e);
}
