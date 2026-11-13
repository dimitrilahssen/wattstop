export const eur = (n: number) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n);

/** Fuseau explicite : le rendu serveur (UTC en ligne) et le navigateur affichent la même heure. */
export const APP_TIME_ZONE = "Europe/Paris";
export const dateTime = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: APP_TIME_ZONE }).format(new Date(iso));

export const kwh = (v: number | string) =>
  `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(Number(v))} kWh`;

export const distance = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

export const CONNECTOR_LABELS: Record<string, string> = {
  type2: "Type 2",
  type2_cable: "Type 2 (câble attaché)",
  domestic_socket: "Prise domestique",
  ccs: "CCS (DC)",
  chademo: "CHAdeMO",
};

/** Seule source de vérité de l'URL encodée dans les QR imprimés. */
export const qrUrl = (qrKey: string) =>
  `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/s/${qrKey}`;

/** Garde-fou pour les redirections post-login (évite les open redirects). */
export const safeNext = (next: string | null | undefined) =>
  next && next.startsWith("/") && !next.startsWith("//") ? next : "/map";
