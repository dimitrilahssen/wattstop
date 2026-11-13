"use client";
import { useEffect, useRef, useState } from "react";

type Status = "starting" | "scanning" | "denied" | "no-camera" | "insecure" | "error";

type Props = {
  /** Reçoit chaque contenu décodé ; renvoie true pour arrêter le scan (code accepté). */
  onDecode: (text: string) => boolean;
};

type Detector = (source: HTMLVideoElement, canvas: HTMLCanvasElement) => Promise<string | null>;

const SCAN_INTERVAL_MS = 150;
const MAX_FRAME = 640; // réduction de l'image pour jsQR (perf mobile)

/** BarcodeDetector natif (Chrome/Edge/Android) si dispo, sinon jsQR (Firefox, Safari). */
async function createDetector(): Promise<Detector> {
  const BD = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (BD && (await BD.getSupportedFormats?.())?.includes("qr_code")) {
    const detector = new BD({ formats: ["qr_code"] });
    return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
  }
  const jsQR = (await import("jsqr")).default;
  return async (video, canvas) => {
    const scale = Math.min(1, MAX_FRAME / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    if (!w || !h) return null;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    return jsQR(img.data, w, h, { inversionAttempts: "attemptBoth" })?.data ?? null;
  };
}

type BarcodeDetectorCtor = {
  new (opts: { formats: string[] }): { detect: (s: CanvasImageSource) => Promise<{ rawValue: string }[]> };
  getSupportedFormats?: () => Promise<string[]>;
};

const MESSAGES: Partial<Record<Status, string>> = {
  starting: "Activation de la caméra…",
  denied: "Accès à la caméra refusé. Autorisez-le dans les réglages du navigateur, ou saisissez le code ci-dessous.",
  "no-camera": "Aucune caméra détectée. Saisissez le code imprimé sous le QR.",
  insecure: "La caméra nécessite HTTPS (ou localhost). Saisissez le code ci-dessous.",
  error: "Impossible de démarrer la caméra. Saisissez le code ci-dessous.",
};

export function QrScanner({ onDecode }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;
  const [status, setStatus] = useState<Status>("starting");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    async function start() {
      if (!window.isSecureContext) return setStatus("insecure");
      if (!navigator.mediaDevices?.getUserMedia) return setStatus("no-camera");
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e) {
        const name = (e as DOMException).name;
        return setStatus(
          name === "NotAllowedError" || name === "SecurityError" ? "denied"
          : name === "NotFoundError" || name === "OverconstrainedError" ? "no-camera"
          : "error"
        );
      }
      if (cancelled) return stream.getTracks().forEach((t) => t.stop());

      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => {});
      canvasRef.current ??= document.createElement("canvas");
      const detect = await createDetector();
      setStatus("scanning");

      const tick = async () => {
        if (cancelled) return;
        if (video.readyState >= video.HAVE_ENOUGH_DATA) {
          const text = await detect(video, canvasRef.current!).catch(() => null);
          if (text && onDecodeRef.current(text)) {
            stream?.getTracks().forEach((t) => t.stop());
            return;
          }
        }
        timer = setTimeout(tick, SCAN_INTERVAL_MS);
      };
      tick();
    }

    start();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-2xl border border-line bg-black">
      <video ref={videoRef} className="h-full w-full object-cover" playsInline muted aria-label="Aperçu de la caméra" />
      {status === "scanning" ? (
        // Viseur
        <div aria-hidden className="pointer-events-none absolute inset-[18%] rounded-2xl border-4 border-brand-500/90 shadow-[0_0_0_9999px_rgba(11,18,32,.55)]" />
      ) : (
        <p role="status" className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/90">
          {MESSAGES[status]}
        </p>
      )}
    </div>
  );
}
