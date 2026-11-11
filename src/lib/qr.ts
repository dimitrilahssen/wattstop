/** Une clé QR WattStop : 32 caractères hexadécimaux (128 bits, cf. spots.qr_key). */
const KEY_RE = /^[0-9a-f]{32}$/;
const URL_KEY_RE = /\/s\/([0-9a-f]{32})(?:[/?#]|$)/i;

/**
 * Extrait la clé d'un contenu de QR ou d'une saisie manuelle.
 * Accepte l'URL complète (https://…/s/<clé>) ou la clé seule, avec espaces/tirets tolérés.
 * Seule la clé est conservée : on ne suit jamais l'URL scannée (pas de redirection vers un domaine tiers).
 */
export function parseQrKey(raw: string): string | null {
  const text = raw.trim();
  const fromUrl = text.match(URL_KEY_RE);
  if (fromUrl) return fromUrl[1].toLowerCase();
  const compact = text.replace(/[\s-]/g, "").toLowerCase();
  return KEY_RE.test(compact) ? compact : null;
}
