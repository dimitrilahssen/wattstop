import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";

export const metadata = { title: "Connexion" };

export default function LoginPage() {
  return (
    <section className="pt-10">
      <h1 className="text-3xl font-bold">Connexion</h1>
      <p className="mt-2 text-white/60">Recevez un lien magique par e-mail. Pas de mot de passe.</p>
      <Suspense>
        <LoginForm />
      </Suspense>
    </section>
  );
}
