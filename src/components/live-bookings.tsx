"use client";
import { useEffect, useRef, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { eur, kwh } from "@/lib/format";
import { isSelfAction, liveStore } from "@/lib/live-store";
import type { Booking } from "@/types/db";

type Change = RealtimePostgresChangesPayload<Booking>;

/** Message à afficher selon le rôle de l'utilisateur dans la réservation (null = pas de notification). */
function describe(change: Change, role: "host" | "driver", spotTitle: string) {
  if (change.eventType === "DELETE") return null;
  const b = change.new;
  if (role === "host") {
    if (change.eventType === "INSERT") return { title: "🔔 Nouvelle demande de réservation", body: spotTitle };
    if (b.status === "cancelled") return { title: "Réservation annulée par le conducteur", body: spotTitle };
    if (b.status === "active") return { title: "⚡ Recharge démarrée", body: spotTitle };
    if (b.status === "completed")
      return { title: "✅ Recharge terminée", body: `${spotTitle} · ${kwh(b.energy_kwh ?? 0)} · ${eur(b.total_price ?? 0)}` };
    return null;
  }
  if (change.eventType !== "UPDATE") return null;
  if (b.status === "confirmed") return { title: "✅ Réservation acceptée", body: spotTitle };
  if (b.status === "rejected") return { title: "Réservation refusée par l'hôte", body: spotTitle };
  if (b.status === "cancelled") return { title: "Réservation annulée par l'hôte", body: spotTitle };
  return null;
}

/**
 * Écoute en temps réel les réservations de l'utilisateur connecté (comme hôte et comme conducteur).
 * Realtime applique la RLS : on ne reçoit que ses propres réservations.
 */
export function LiveBookings() {
  const router = useRouter();
  const pathname = usePathname();
  const { toasts } = useSyncExternalStore(liveStore.subscribe, liveStore.getSnapshot, liveStore.getServerSnapshot);
  const pathRef = useRef(pathname);
  pathRef.current = pathname;

  // La pastille de l'onglet Résas s'efface dès qu'on ouvre la page
  useEffect(() => {
    if (pathname.startsWith("/bookings")) liveStore.markSeen();
  }, [pathname]);

  useEffect(() => {
    const supabase = createClient();
    let channels: RealtimeChannel[] = [];
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const titles = new Map<string, string>();

    async function spotTitle(spotId: string) {
      if (!titles.has(spotId)) {
        const { data } = await supabase.from("spots").select("title").eq("id", spotId).maybeSingle();
        titles.set(spotId, data?.title ?? "Spot");
      }
      return titles.get(spotId)!;
    }

    async function onChange(change: Change, role: "host" | "driver") {
      const b = change.eventType === "DELETE" ? null : change.new;
      if (!b) return;
      // Les pages qui listent des réservations se mettent à jour d'elles-mêmes
      const path = pathRef.current;
      if (path.startsWith("/bookings") || path.startsWith("/host")) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => router.refresh(), 300);
      }
      if (isSelfAction(b.id, b.status)) return;
      const msg = describe(change, role, await spotTitle(b.spot_id));
      if (msg) liveStore.push({ ...msg, href: "/bookings" }, !pathRef.current.startsWith("/bookings"));
    }

    async function start(userId: string, accessToken: string) {
      await stop();
      await supabase.realtime.setAuth(accessToken);
      channels = (["host", "driver"] as const).map((role) =>
        supabase
          .channel(`bookings-${role}-${userId}`)
          .on<Booking>(
            "postgres_changes",
            { event: "*", schema: "public", table: "bookings", filter: `${role}_id=eq.${userId}` },
            (change) => void onChange(change, role)
          )
          .subscribe()
      );
    }

    async function stop() {
      await Promise.all(channels.map((c) => supabase.removeChannel(c)));
      channels = [];
    }

    let currentUser: string | null = null;
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      const uid = session?.user.id ?? null;
      if (event === "TOKEN_REFRESHED" && session) void supabase.realtime.setAuth(session.access_token);
      if (uid === currentUser) return;
      currentUser = uid;
      if (uid && session) void start(uid, session.access_token);
      else void stop();
    });

    return () => {
      clearTimeout(refreshTimer);
      sub.subscription.unsubscribe();
      void stop();
    };
  }, [router]);

  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-50 mx-auto grid max-w-lg gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))]">
      {toasts.map((t) => (
        <div key={t.id} role="status" className="card pointer-events-auto flex items-start gap-3 shadow-lg" data-testid="live-toast">
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{t.title}</p>
            {t.body && <p className="truncate text-sm text-muted">{t.body}</p>}
          </div>
          {t.href && (
            <Link href={t.href} onClick={() => liveStore.dismiss(t.id)} className="shrink-0 text-sm font-semibold text-accent">
              Voir
            </Link>
          )}
          <button aria-label="Fermer" onClick={() => liveStore.dismiss(t.id)} className="shrink-0 text-subtle hover:text-fg">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
