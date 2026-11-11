import Link from "next/link";

export default function Home() {
  return (
    <section className="flex flex-col gap-8 pt-10">
      <div>
        <p className="text-brand-400 font-semibold">⚡ WattStop</p>
        <h1 className="mt-2 text-4xl font-bold leading-tight">
          La recharge VE chez l&apos;habitant. <span className="text-brand-400">Zéro matériel.</span>
        </h1>
        <p className="mt-4 text-white/70">
          Les hôtes collent un QR code sur leur prise. Les conducteurs réservent, scannent pour démarrer,
          scannent pour terminer. C&apos;est tout.
        </p>
      </div>
      <ol className="grid gap-3">
        {[
          ["1", "Trouvez une prise près de vous", "Carte des spots disponibles en temps réel."],
          ["2", "Réservez un créneau", "L'hôte accepte en un clic."],
          ["3", "Scannez le QR sur place", "Check-in, recharge, check-out : paiement au kWh."],
        ].map(([n, t, d]) => (
          <li key={n} className="card flex gap-4">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-500 font-bold text-ink-900">{n}</span>
            <div>
              <p className="font-semibold">{t}</p>
              <p className="text-sm text-white/60">{d}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="grid gap-3">
        <Link href="/map" className="btn-primary">Trouver une borne</Link>
        <Link href="/host" className="btn-ghost">Partager ma prise</Link>
      </div>
    </section>
  );
}
