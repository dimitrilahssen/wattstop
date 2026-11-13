"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { QrScanner } from "./qr-scanner";
import { parseQrKey } from "@/lib/qr";

export function ScanPanel() {
  const router = useRouter();
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState(false);
  const lastRejected = useRef<string | null>(null);

  function go(key: string) {
    setFound(true);
    if ("vibrate" in navigator) navigator.vibrate?.(80);
    router.push(`/s/${key}`);
  }

  function onDecode(text: string) {
    const key = parseQrKey(text);
    if (key) {
      go(key);
      return true;
    }
    // QR lisible mais étranger à WattStop : on prévient une fois et on continue de scanner
    if (lastRejected.current !== text) {
      lastRejected.current = text;
      setError("Ce QR code n'est pas un code WattStop.");
    }
    return false;
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const key = parseQrKey(manual);
    if (!key) return setError("Code invalide : 32 caractères (0-9, a-f), ou l'URL complète du QR.");
    setError(null);
    go(key);
  }

  return (
    <div className="grid gap-4">
      {found ? (
        <div role="status" className="card grid aspect-square place-items-center text-center">
          <div>
            <p className="text-5xl">✅</p>
            <p className="mt-2 font-semibold">Code reconnu</p>
            <p className="text-sm text-muted">Ouverture du spot…</p>
          </div>
        </div>
      ) : (
        <QrScanner onDecode={onDecode} />
      )}

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      <form onSubmit={onSubmit} className="card grid gap-3">
        <label htmlFor="manual-code" className="text-sm font-medium">QR illisible ? Saisissez le code</label>
        <input
          id="manual-code"
          className="input font-mono text-sm"
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="ex. 3f9a…c21d ou https://…/s/…"
          value={manual}
          onChange={(e) => { setManual(e.target.value); setError(null); }}
        />
        <button className="btn-primary" disabled={!manual.trim() || found}>Valider le code</button>
      </form>
    </div>
  );
}
