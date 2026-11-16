"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { PAYMENTS_FUNCTION } from "@/lib/payments";

type State = "loading" | "unsupported" | "ios-install" | "denied" | "off" | "on";

/** Clé publique VAPID (base64url) → format attendu par pushManager.subscribe. */
function toKey(base64url: string) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function invoke<T>(action: string): Promise<T> {
  const { data, error } = await createClient().functions.invoke(PAYMENTS_FUNCTION, { body: { action } });
  if (error) throw new Error(error.message);
  return data as T;
}

/**
 * Active / désactive les notifications push sur CET appareil.
 * L'abonnement est enregistré dans push_subscriptions (chaque utilisateur ne gère que les siens).
 */
export function PushToggle() {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        return setState(ios && !standalone ? "ios-install" : "unsupported");
      }
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub && Notification.permission === "granted" ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  async function enable() {
    setBusy(true);
    setMessage(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") return setState("denied");
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
      await navigator.serviceWorker.ready;
      const { public_key } = await invoke<{ public_key: string }>("push_public_key");
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(public_key) });

      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const json = sub.toJSON();
      const row = { user_id: auth.user!.id, endpoint: sub.endpoint, p256dh: json.keys!.p256dh, auth: json.keys!.auth, user_agent: navigator.userAgent.slice(0, 200) };
      let { error } = await supabase.from("push_subscriptions").insert(row);
      if (error?.code === "23505") {
        // Appareil déjà inscrit (par vous, ou par un autre compte sur ce navigateur) : nouvel abonnement propre
        await sub.unsubscribe();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(public_key) });
        const j2 = sub.toJSON();
        ({ error } = await supabase.from("push_subscriptions").insert({ ...row, endpoint: sub.endpoint, p256dh: j2.keys!.p256dh, auth: j2.keys!.auth }));
      }
      if (error) throw new Error(error.message);
      setState("on");
      const { sent } = await invoke<{ sent: number }>("push_test");
      setMessage(sent ? "Notification de test envoyée sur cet appareil." : "Activées, mais la notification de test n'a pas pu partir.");
    } catch (e) {
      setMessage(`Activation impossible : ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription();
      if (sub) {
        await createClient().from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
      setState("off");
      setMessage(null);
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading" || state === "unsupported") return null;

  return (
    <section className="card grid gap-2" data-testid="push-toggle">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">🔔 Notifications</h2>
          <p className="text-sm text-muted">
            {state === "on"
              ? "Activées sur cet appareil : vous êtes prévenu de vos réservations, même app fermée."
              : state === "denied"
                ? "Bloquées par le navigateur. Autorisez les notifications pour ce site dans les réglages du navigateur."
                : state === "ios-install"
                  ? "Sur iPhone : ajoutez WattStop à l'écran d'accueil (Partager → Sur l'écran d'accueil), puis ouvrez-la depuis l'icône pour activer les notifications."
                  : "Soyez prévenu d'une demande, d'une acceptation ou de la fin de votre créneau, même app fermée."}
          </p>
        </div>
        {state === "on" && <span className="shrink-0 whitespace-nowrap rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">Activées</span>}
      </div>
      {state === "off" && (
        <button className="btn-primary py-2" disabled={busy} onClick={enable}>
          {busy ? "…" : "Activer les notifications"}
        </button>
      )}
      {state === "on" && (
        <button className="btn-ghost py-2" disabled={busy} onClick={disable}>
          Désactiver sur cet appareil
        </button>
      )}
      {message && <p className="text-sm text-muted">{message}</p>}
    </section>
  );
}
