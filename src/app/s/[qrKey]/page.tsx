import { createClient } from "@/lib/supabase/server";
import type { ResolvedQr } from "@/types/db";
import { ChargeSession } from "@/components/charge-session";

export const metadata = { title: "Scan" };

/**
 * Point d'entrée du QR code collé sur la prise : https://<app>/s/<qr_key>
 * L'appareil photo natif du téléphone ouvre directement cette URL : aucun scanner intégré requis.
 */
export default async function ScanPage({ params }: { params: Promise<{ qrKey: string }> }) {
  const { qrKey } = await params;
  if (!/^[0-9a-f]{32}$/.test(qrKey)) return <Invalid />;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("resolve_qr", { p_qr_key: qrKey });
  if (error || !data) return <Invalid />;

  return <ChargeSession qrKey={qrKey} initial={data as ResolvedQr} />;
}

function Invalid() {
  return (
    <section className="pt-20 text-center">
      <p className="text-5xl">⚠️</p>
      <h1 className="mt-4 text-2xl font-bold">QR code invalide</h1>
      <p className="mt-2 text-white/60">Ce code n&apos;est associé à aucun spot actif. Contactez l&apos;hôte.</p>
    </section>
  );
}
