# Suivi du projet WattStop

_Dernière mise à jour : 17/11/2026_

## Fait et testé (sur la vraie base Supabase)

- Carte MapLibre + liste, recherche par zone, icônes PWA, thème clair
- Scanner QR (`/scan`) + code de secours
- Parcours complet hôte → conducteur : publier un spot, réserver, accepter, check-in, check-out, prix au kWh, anti-fraude
- Désactiver / réactiver un spot (l'historique du conducteur garde le nom du spot)
- Notifications en temps réel (Supabase Realtime) + pastille sur l'onglet Résas
- Expiration automatique : `expired` (demande sans réponse) et `no_show` (jamais démarrée), tâche `pg_cron` toutes les 5 min
- Tests de bout en bout : `npm run test:e2e` (API 41/41, navigateur 38/38) et `npm run test:e2e:payments` (33/33)

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
Paiement obligatoire au démarrage depuis le 16/11/2026.

## Reversement aux hôtes (Stripe Connect)

Branché et testé (sandbox Stripe « wattstop », Connect activé, comptes Express) :
- Migration `20261116000000_connect_payouts.sql` appliquée, fonction mise à jour.
- L'hôte active ses paiements depuis « Mes spots » (formulaire Stripe), sa part est transférée après chaque prélèvement ; avant activation, elle est mise de côté puis transférée automatiquement.
- Compte hôte de test activé : 4,80 € reversés au total.
- Derniers résultats : paiement 28/28, API 41/41, navigateur 38/38.

## Libération automatique des montants bloqués

En place et vérifiée sans intervention : une réservation payée mais non honorée passe « no_show » (tâche toutes les 5 min), puis son montant bloqué est libéré chez Stripe (tâche toutes les 10 min, `pg_cron` + `pg_net` → action `release_stale`). Observé : libéré 10,9 min après la fin du créneau.
Réglages : migration `20261116120000_release_stale_holds.sql`, `app_settings.payments_function_url`, « Verify JWT » désactivé sur la fonction.
Derniers résultats : paiement 33/33, API 41/41, navigateur 38/38.

## Recharges oubliées

En place et vérifiée en réel (`npm run test:e2e:forgotten`, 10/10) : recharge démarrée puis oubliée, clôturée automatiquement 62 min après la fin du créneau (« Relevé à saisir », durée facturable arrêtée à la fin du créneau), relevé de l'hôte plafonné par l'anti-fraude, 0,80 € prélevés puis reversés à l'hôte. Sans relevé sous 24 h : « Non facturée » et blocage libéré.
Derniers résultats : paiement 33/33, API 41/41, navigateur 38/38, recharge oubliée 10/10.

## Notifications push (Web Push)

Branchées et testées côté serveur (`npm run test:e2e:push`, 14/14) : clés VAPID générées et protégées, chaque changement de statut notifié une seule fois par la base (pg_net → fonction), abonnements expirés nettoyés, rappel de fin de créneau.
Reste à vérifier à la main la réception réelle : app en local sur PC (Chrome, Edge ou Firefox), Réservations → « Activer les notifications » → une notification de test doit apparaître. Sur téléphone : nécessite l'app en ligne (https) ; sur iPhone, l'ajouter d'abord à l'écran d'accueil.
Derniers résultats : push 14/14, paiement 33/33, API 41/41, navigateur 38/38.

## Horaires de disponibilité

En place et testés sur la vraie base (`npm run test:e2e:availability`, 37/37) : l'hôte règle ses plages hebdomadaires (plages de nuit possibles, modèles en un clic) et ses fermetures ponctuelles ; la base refuse les réservations hors horaires ; la fiche du spot affiche horaires, fermetures et créneaux pris, et propose le prochain créneau libre ; filtre « Disponible maintenant » sur la carte.
Migration `20261118000000_spot_availability.sql` appliquée.
Derniers résultats : horaires 37/37, API 41/41, navigateur 38/38, paiement 33/33, push 14/14.

## Avis et notes

En place et testés sur la vraie base (`npm run test:e2e:reviews`, 28/28) : notes croisées conducteur ↔ hôte après chaque recharge terminée (1 à 5 étoiles + commentaire, sous 14 jours), publication en double aveugle, moyenne et avis sur la fiche du spot, note dans la liste des spots, note du conducteur sur les demandes reçues par l'hôte.
Migration `20261119000000_reviews.sql` appliquée.
Derniers résultats : avis 28/28, horaires 37/37, API 41/41, navigateur 38/38, paiement 33/33, push 14/14.

## Règle d'annulation

En place et testée sur la vraie base et Stripe (`npm run test:e2e:cancellation`, 26/26) : carte enregistrée exigée pour réserver (rien n'est prélevé), blocage au scan sans ressaisie, annulation gratuite (demande en attente, plus de 2 h avant, ou 10 min de grâce), 2 € prélevés en cas d'annulation tardive ou d'absence et reversés à l'hôte, confirmation avant une annulation payante.
Migration `20261120000000_cancellation_policy.sql` appliquée, fonction mise à jour.
Réservations : les réservations en cours s'affichent en premier, puis l'historique par activité récente.
Derniers résultats : annulation 26/26, API 41/41, navigateur 40/40, paiement 30/30, horaires 37/37, avis 28/28, push 14/14.

## Ensuite (idées)


- Commission WattStop (secret `PLATFORM_FEE_PERCENT` de la fonction)
- Passage en mode réel Stripe (clés live) quand le compte sera vérifié

## Rappels

- Réactiver **Confirm email** dans Supabase (Authentication → Sign In / Providers → Email) si ce n'est pas déjà fait.
- Les comptes de test (`E2E_HOST_EMAIL`, `E2E_DRIVER_EMAIL`, `E2E_PASSWORD`) sont dans `.env.local`, jamais sur GitHub.
- Lancer l'app : `npm run dev`, puis http://localhost:3000
