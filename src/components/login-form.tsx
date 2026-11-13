"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/format";

export function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    const next = safeNext(params.get("next"));
    const { error } = await createClient().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    setState(error ? "error" : "sent");
  }

  if (state === "sent") return <p className="card mt-6">📬 Lien envoyé à <strong>{email}</strong>. Ouvrez-le sur ce téléphone.</p>;

  return (
    <form onSubmit={onSubmit} className="mt-6 grid gap-3">
      <input className="input" type="email" required autoComplete="email" placeholder="vous@exemple.fr"
        value={email} onChange={(e) => setEmail(e.target.value)} />
      <button className="btn-primary" disabled={state === "sending"}>
        {state === "sending" ? "Envoi…" : "Recevoir le lien"}
      </button>
      {state === "error" && <p className="text-sm text-danger">Erreur d&apos;envoi, réessayez.</p>}
    </form>
  );
}
