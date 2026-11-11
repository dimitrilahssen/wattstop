"use client";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { createClient } from "@/lib/supabase/client";
import { qrUrl } from "@/lib/format";

/** Affiche le QR à imprimer et coller sur la prise. La clé n'est obtenue qu'à la demande, via RPC réservée à l'hôte. */
export function SpotQr({ spotId, title }: { spotId: string; title: string }) {
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(regenerate = false) {
    if (regenerate && !confirm("L'ancien QR collé ne fonctionnera plus. Continuer ?")) return;
    const { data, error } = await createClient().rpc(regenerate ? "regenerate_spot_qr_key" : "get_spot_qr_key", { p_spot_id: spotId });
    if (error) setError(error.message);
    else setKey(data as string);
  }

  if (!key) return <button className="btn-ghost py-2" onClick={() => load()}>Afficher le QR code</button>;

  return (
    <div className="grid justify-items-center gap-3">
      <div className="rounded-xl bg-white p-4 print:p-0">
        <QRCodeSVG value={qrUrl(key)} size={220} level="M" marginSize={1} title={`WattStop – ${title}`} />
      </div>
      {/* Code de secours, saisissable dans /scan (espaces tolérés) */}
      <p className="text-center font-mono text-sm tracking-wider" aria-label="Code de secours">
        {key.match(/.{1,4}/g)?.join(" ")}
      </p>
      <p className="text-center text-xs text-white/50">
        Scannez avec l&apos;appareil photo ou l&apos;onglet Scanner de WattStop pour démarrer/terminer la recharge.
      </p>
      <div className="flex w-full gap-2">
        <button className="btn-ghost flex-1 py-2" onClick={() => window.print()}>Imprimer</button>
        <button className="btn-ghost flex-1 py-2" onClick={() => load(true)}>Régénérer</button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
