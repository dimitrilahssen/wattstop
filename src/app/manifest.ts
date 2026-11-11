import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "WattStop — Recharge VE entre particuliers",
    short_name: "WattStop",
    description: "Trouvez et partagez des points de recharge chez l'habitant. Zéro matériel : un QR code suffit.",
    start_url: "/map",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b1220",
    theme_color: "#0b1220",
    lang: "fr",
    categories: ["travel", "utilities", "navigation"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
    shortcuts: [
      { name: "Scanner un spot", url: "/scan" },
      { name: "Trouver une borne", url: "/map" },
      { name: "Mes réservations", url: "/bookings" },
    ],
  };
}
