import { ScanPanel } from "@/components/scan-panel";

export const metadata = { title: "Scanner" };

/**
 * Scanner intégré : alternative à l'appareil photo natif, et seul moyen de tester
 * la boucle QR sur un PC (un QR encodant localhost n'est pas ouvrable depuis un téléphone).
 * Page publique : la destination /s/<clé> exige la connexion et y renvoie après login.
 */
export default function ScanPage() {
  return (
    <section className="grid gap-4">
      <div>
        <h1 className="text-2xl font-bold">Scanner un spot</h1>
        <p className="mt-1 text-sm text-white/60">Visez le QR code collé près de la prise pour démarrer ou terminer la recharge.</p>
      </div>
      <ScanPanel />
    </section>
  );
}
