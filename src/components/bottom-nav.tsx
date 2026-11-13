"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { liveStore } from "@/lib/live-store";

type Tab = { href: string; label: string; icon: string; match: string[] };

// `match` : préfixes de routes qui rendent l'onglet actif (pages filles incluses)
const TABS: Tab[] = [
  { href: "/map", label: "Carte", icon: "⚡", match: ["/map", "/spots/"] },
  { href: "/scan", label: "Scanner", icon: "📷", match: ["/scan", "/s/"] },
  { href: "/bookings", label: "Résas", icon: "📅", match: ["/bookings"] },
  { href: "/host", label: "Mes spots", icon: "🏠", match: ["/host"] },
];

function isActive(pathname: string, prefixes: string[]) {
  return prefixes.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)
  );
}

export function BottomNav() {
  const pathname = usePathname() ?? "/";
  const { unseen } = useSyncExternalStore(liveStore.subscribe, liveStore.getSnapshot, liveStore.getServerSnapshot);
  return (
    <nav
      aria-label="Navigation principale"
      className="fixed inset-x-0 bottom-0 border-t border-line bg-surface/90 backdrop-blur pb-[env(safe-area-inset-bottom)]"
    >
      <div className="mx-auto grid max-w-lg grid-cols-4 text-center text-xs sm:text-sm">
        {TABS.map((t) => {
          const active = isActive(pathname, t.match);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "border-t-2 border-accent py-3 font-semibold text-accent"
                  : "border-t-2 border-transparent py-3 text-muted hover:text-accent"
              }
            >
              {t.icon} {t.label}
              {t.href === "/bookings" && unseen > 0 && (
                <span
                  aria-label={`${unseen} nouveauté${unseen > 1 ? "s" : ""}`}
                  data-testid="bookings-badge"
                  className="ml-1 inline-grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 align-top text-[10px] font-bold leading-none text-white"
                >
                  {unseen > 9 ? "9+" : unseen}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
