# Suivi du projet WattStop

_Dernière mise à jour : 16/11/2026_

## Fait et testé (sur la vraie base Supabase)

- Carte MapLibre + liste, recherche par zone, icônes PWA, thème clair
- Scanner QR (`/scan`) + code de secours
- Parcours complet hôte → conducteur : publier un spot, réserver, accepter, check-in, check-out, prix au kWh, anti-fraude
- Désactiver / réactiver un spot (l'historique du conducteur garde le nom du spot)
- Notifications en temps réel (Supabase Realtime) + pastille sur l'onglet Résas
- Expiration automatique : `expired` (demande sans réponse) et `no_show` (jamais démarrée), tâche `pg_cron` toutes les 5 min
- Tests de bout en bout : `npm run test:e2e` (API 41/41, navigateur 38/38) et `npm run test:e2e:payments` (21/21)

Migrations déjà appliquées dans Supabase :
- `20261111000000_init_wattstop.sql`
- `20261113000000_spots_visible_to_past_drivers.sql`
- `20261113120000_booking_expiration.sql`

## Paiement Stripe (mode test)

Branché et testé sur la vraie base et le compte Stripe (sandbox) :
- Migration `20261114000000_payments.sql` appliquée, Edge Function déployée (adresse `clever-api`, réglée par `NEXT_PUBLIC_PAYMENTS_FUNCTION`), secret `STRIPE_SECRET_KEY` en place.
- `npm run test:e2e:payments` : 20/20 (blocage, carte de test, prélèvement réel, libération, fraudes refusées).
- Test navigateur : la vraie saisie de carte Stripe passe (38/38).

Paiement **obligatoire** au démarrage (`app_settings.payments_required = true`) : la base refuse le check-in sans carte validée.
Derniers résultats : paiement 21/21, API 41/41, navigateur 38/38.

## En cours : reversement aux hôtes (Stripe Connect)

Code écrit et poussé, à brancher :
1. Stripe (sandbox) : activer **Connect** (menu Connect → Commencer), plateforme « place de marché », comptes **Express**.
2. Supabase, SQL Editor : exécuter `supabase/migrations/20261116000000_connect_payouts.sql`.
3. Supabase, Edge Functions : ouvrir la fonction (adresse `clever-api`) → onglet Code → coller la nouvelle version de `supabase/functions/payments/index.ts` → Deploy.
4. Tester : `npm run test:e2e:payments`, puis activer les paiements du compte hôte de test (formulaire Stripe en mode test) et vérifier le transfert.

## Ensuite (idées)

- Commission WattStop (secret `PLATFORM_FEE_PERCENT` de la fonction)
- Passage en mode réel Stripe (clés live) quand le compte sera vérifié
- Libérer automatiquement les montants bloqués des réservations « non honorées »
- Clôturer les recharges oubliées (pas de check-out)
- Notifications push quand l'app est fermée (Web Push)

## Rappels

- Réactiver **Confirm email** dans Supabase (Authentication → Sign In / Providers → Email) si ce n'est pas déjà fait.
- Les comptes de test (`E2E_HOST_EMAIL`, `E2E_DRIVER_EMAIL`, `E2E_PASSWORD`) sont dans `.env.local`, jamais sur GitHub.
- Lancer l'app : `npm run dev`, puis http://localhost:3000
