"use client";
import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    // Aussi en développement : nécessaire aux notifications push (le cache est coupé en local dans sw.js)
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(console.error);
  }, []);
  return null;
}
