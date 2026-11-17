import { createClient } from "@/lib/supabase/server";
import { AccountForm } from "@/components/account-form";
import { SignOutButton } from "@/components/sign-out-button";
import { DeleteAccount } from "@/components/delete-account";
import { SavedCard } from "@/components/saved-card";
import { PushToggle } from "@/components/push-toggle";
import { paymentsEnabled } from "@/lib/payments";

export const metadata = { title: "Mon compte" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ bienvenue?: string; next?: string }> }) {
  const { bienvenue, next } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ data: profile }, { data: settings }] = await Promise.all([
    supabase.from("profiles").select("full_name, vehicle_model, role").eq("id", user!.id).maybeSingle(),
    supabase.from("app_settings").select("payments_required").maybeSingle(),
  ]);
  // Retour après la saisie du prénom : uniquement vers une page de l'app
  const back = next && next.startsWith("/") && !next.startsWith("//") ? next : null;

  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-bold">Mon compte</h1>
      {bienvenue && (
        <p className="card bg-accent/10 text-sm" role="status" data-testid="welcome">
          👋 Bienvenue sur WattStop ! Indiquez votre prénom pour commencer : il est montré aux hôtes et conducteurs avec qui vous réservez.
        </p>
      )}

      <AccountForm
        email={user!.email ?? ""}
        fullName={profile?.full_name ?? ""}
        vehicle={profile?.vehicle_model ?? ""}
        next={back}
      />

      {paymentsEnabled && settings?.payments_required && (
        <section className="card grid gap-2" data-testid="account-card">
          <h2 className="font-semibold">💳 Ma carte</h2>
          <p className="text-sm text-muted">Garantit vos réservations ; au démarrage, elle sert au paiement sans ressaisie.</p>
          <SavedCard manage intro="Aucune carte enregistrée. Elle vous sera demandée à votre première réservation." />
        </section>
      )}

      <PushToggle />

      <section className="card grid gap-3">
        <h2 className="font-semibold">Session</h2>
        <SignOutButton />
      </section>

      <DeleteAccount />
    </section>
  );
}
