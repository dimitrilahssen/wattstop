# Suivi du projet WattStop

_Dernière mise à jour : 13/11/2026_

## Fait et testé (sur la vraie base Supabase)

- Carte MapLibre + liste, recherche par zone, icônes PWA, thème clair
- Scanner QR (`/scan`) + code de secours
- Parcours complet hôte → conducteur : publier un spot, réserver, accepter, check-in, check-out, prix au kWh, anti-fraude
- Désactiver / réactiver un spot (l'historique du conducteur garde le nom du spot)
- Notifications en temps réel (Supabase Realtime) + pastille sur l'onglet Résas
- Expiration automatique : `expired` (demande sans réponse) et `no_show` (jamais démarrée), tâche `pg_cron` toutes les 5 min
- Tests de bout en bout : `npm run test:e2e` (API 41/41, navigateur 35/35)

Migrations déjà appliquées dans Supabase :
- `20261111000000_init_wattstop.sql`
- `20261113000000_spots_visible_to_past_drivers.sql`
- `20261113120000_booking_expiration.sql`

## En cours : paiement Stripe

Le code est écrit et poussé, mais **pas encore branché ni testé**. Tant que `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` est vide, l'app fonctionne sans paiement.

Étapes restantes, dans l'ordre :

1. **Stripe** : créer le compte en mode test et récupérer `pk_test_…` (publique) et `sk_test_…` (secrète, à ne jamais partager).
2. **Supabase, SQL Editor** : exécuter `supabase/migrations/20261114000000_payments.sql`.
3. **Supabase, Edge Functions** : *Deploy a new function* → *Via Editor* → nom `payments` → coller `supabase/functions/payments/index.ts` → *Deploy*.
4. **Supabase, Edge Functions, Secrets** : ajouter `STRIPE_SECRET_KEY` = `sk_test_…`.
5. Mettre `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…` dans `.env.local`.
6. Tester le parcours avec la carte de test `4242 4242 4242 4242` (date future, CVC quelconque).
7. Ajouter le paiement aux tests de bout en bout.
8. Rendre le paiement obligatoire : `update public.app_settings set payments_required = true;`

## Ensuite (idées)

- Reversement automatique aux hôtes (Stripe Connect) et commission éventuelle
- Libérer automatiquement les montants bloqués des réservations « non honorées »
- Clôturer les recharges oubliées (pas de check-out)
- Notifications push quand l'app est fermée (Web Push)

## Rappels

- Réactiver **Confirm email** dans Supabase (Authentication → Sign In / Providers → Email) si ce n'est pas déjà fait.
- Les comptes de test (`E2E_HOST_EMAIL`, `E2E_DRIVER_EMAIL`, `E2E_PASSWORD`) sont dans `.env.local`, jamais sur GitHub.
- Lancer l'app : `npm run dev`, puis http://localhost:3000
