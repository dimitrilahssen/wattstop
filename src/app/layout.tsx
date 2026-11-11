import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { ServiceWorkerRegister } from "@/components/sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "WattStop", template: "%s · WattStop" },
  description: "Recharge de véhicules électriques entre particuliers, sans borne connectée.",
  applicationName: "WattStop",
  appleWebApp: { capable: true, title: "WattStop", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0b1220",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-dvh">
        <div className="mx-auto flex min-h-dvh max-w-lg flex-col">
          <main className="flex-1 px-4 pt-6 pb-24">{children}</main>
          <nav className="fixed inset-x-0 bottom-0 border-t border-white/10 bg-ink-900/90 backdrop-blur pb-[env(safe-area-inset-bottom)]">
            <div className="mx-auto grid max-w-lg grid-cols-3 text-center text-sm">
              <Link href="/map" className="py-3 hover:text-brand-400">⚡ Carte</Link>
              <Link href="/bookings" className="py-3 hover:text-brand-400">📅 Réservations</Link>
              <Link href="/host" className="py-3 hover:text-brand-400">🏠 Mes spots</Link>
            </div>
          </nav>
        </div>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
