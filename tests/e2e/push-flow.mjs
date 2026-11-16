// Notifications push : abonnements, clés, déclencheur base → fonction, anti-doublon, sécurité.
// La livraison réelle sur un appareil se vérifie à la main : bouton « Activer les notifications »
// dans Réservations (une notification de test arrive). Usage : npm run test:e2e:push
import { webcrypto } from "node:crypto";
import { login, client, reporter, sleep, crash, cancelOpenBookings, callPayments, TEST_PREFIX } from "./lib.mjs";

const { ok, expectErr, done } = reporter();
const b64u = (buf) => Buffer.from(buf).toString("base64url");

/** Abonnement Web Push factice mais cryptographiquement valide, vers un point d'envoi inexistant. */
async function fakeSubscription(userId) {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = new Uint8Array(await webcrypto.subtle.exportKey("raw", kp.publicKey));
  return {
    user_id: userId,
    endpoint: `https://fcm.googleapis.com/fcm/send/wattstop-test-${Date.now()}`,
    p256dh: b64u(raw),
    auth: b64u(webcrypto.getRandomValues(new Uint8Array(16))),
    user_agent: "test e2e",
  };
}

try {
  const H = await login("host"), D = await login("driver"), anon = client();
  await cancelOpenBookings(D.c);

  // 1. Clé publique VAPID (générée une fois, stable)
  const k1 = await callPayments(null, "push_public_key");
  const k2 = await callPayments(null, "push_public_key");
  ok(k1.http === 200 && /^[A-Za-z0-9_-]{80,}$/.test(k1.public_key ?? ""), "Clé publique VAPID disponible", (k1.public_key ?? k1.error ?? "").slice(0, 16) + "…");
  ok(k1.public_key === k2.public_key, "Clé VAPID stable d'un appel à l'autre");

  // 2. Sécurité des tables
  expectErr(await anon.from("push_config").select("*"), "Anonyme : clés VAPID illisibles");
  expectErr(await H.c.from("push_config").select("*"), "Utilisateur : clés VAPID illisibles");
  expectErr(await H.c.from("push_log").select("*"), "Utilisateur : journal d'envoi illisible");
  const forOther = await fakeSubscription(D.id);
  expectErr(await H.c.from("push_subscriptions").insert(forOther), "Impossible d'abonner l'appareil de quelqu'un d'autre");

  // 3. Abonnement de l'hôte (appareil factice)
  const sub = await fakeSubscription(H.id);
  const ins = await H.c.from("push_subscriptions").insert(sub);
  ok(!ins.error, "Hôte : abonne son appareil", ins.error?.message);
  ok(((await D.c.from("push_subscriptions").select("id")).data ?? []).every((r) => r.id !== sub.id), "Conducteur : ne voit pas les appareils de l'hôte");

  // 4. Déclencheur base → fonction : une réservation crée la notification « nouvelle demande »
  const title = `${TEST_PREFIX} Borne push ${Date.now().toString().slice(-5)}`;
  await H.c.from("spots").insert({ host_id: H.id, title, address: "5 rue du Test, Paris", connector_type: "type2", power_kw: 7.4, price_per_kwh: 0.3, location: "SRID=4326;POINT(2.354 48.854)" });
  const { data: spot } = await H.c.from("spots").select("id").eq("title", title).single();
  const { data: b } = await D.c.from("bookings").insert({ spot_id: spot.id, driver_id: D.id, start_at: new Date(Date.now() + 86_400_000).toISOString(), end_at: new Date(Date.now() + 90_000_000).toISOString() }).select("id").single();
  await sleep(8000); // pg_net est asynchrone
  const again = await callPayments(null, "notify_booking", b.id);
  ok(again.http === 200 && again.status === "pending" && again.claimed === false, "Déclencheur : la base a déjà notifié la nouvelle demande (pas de doublon)", JSON.stringify(again));
  const r1 = await H.c.rpc("respond_booking", { p_booking_id: b.id, p_accept: true });
  await sleep(8000);
  const again2 = await callPayments(null, "notify_booking", b.id);
  ok(r1.data && again2.claimed === false && again2.status === "confirmed", "Déclencheur : acceptation notifiée une seule fois", JSON.stringify(again2));

  // 5. Abonnement expiré : le service de push le rejette, la fonction le supprime
  const t = await callPayments(H.c, "push_test");
  ok(t.http === 200, "Notification de test : appel accepté", JSON.stringify(t));
  const still = (await H.c.from("push_subscriptions").select("id").eq("endpoint", sub.endpoint)).data ?? [];
  ok(still.length === 0, "Appareil factice rejeté par le service de push : abonnement nettoyé", still.length ? "toujours présent" : "");
  const anonTest = await callPayments(null, "push_test");
  ok(anonTest.http === 401, "Notification de test : connexion obligatoire", `HTTP ${anonTest.http}`);

  // 6. Rappels : appel sans connexion accepté, sans effet nuisible
  const rem = await callPayments(null, "push_reminders");
  ok(rem.http === 200, "Rappels de fin de créneau : appel accepté", JSON.stringify(rem));

  await D.c.rpc("cancel_booking", { p_booking_id: b.id });
  await H.c.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  await H.c.from("spots").update({ is_active: false }).eq("id", spot.id);
  done();
} catch (e) {
  crash(e);
}
