# ⚡ WattStop

Une PWA pour recharger son véhicule électrique chez des particuliers, sans matériel à installer (« Zero Hardware »).
L'hôte imprime un **QR code** et le colle sur sa prise. Le conducteur réserve un créneau, puis **scanne le QR avec l'appareil photo de son téléphone** pour démarrer la recharge (check-in) et pour la terminer (check-out).

## Stack
- Next.js 15 (App Router, React 19, TypeScript)
- Tailwind CSS v4
- Supabase : Postgres + PostGIS, Auth par lien magique, RLS, Storage, Realtime
- PWA : `app/manifest.ts`, service worker `public/sw.js` avec page hors ligne

## Démarrage
```bash
npm install
cp .env.example .env.local   # renseigner les clés Supabase
npm run dev
```

Base de données : exécuter les fichiers de `supabase/migrations/` dans l'ordre de leur nom, soit dans le SQL Editor de Supabase, soit avec `supabase db push`.

Dans Supabase > Auth > URL Configuration, ajouter `http://localhost:3000/auth/callback` (puis l'URL de prod) dans les Redirect URLs.

## Parcours
| Étape | Route | Mécanisme |
|---|---|---|
| Trouver un spot | `/map` | Carte MapLibre + vue liste, RPC `nearby_spots` (PostGIS `ST_DWithin`, tri KNN), « Rechercher dans cette zone » |
| Réserver | `/spots/[id]` | `insert` dans `bookings` (le trigger impose hôte, prix et statut) |
| Accepter / refuser | `/bookings` | RPC `respond_booking` / `cancel_booking` |
| Imprimer le QR | `/host` | RPC `get_spot_qr_key` / `regenerate_spot_qr_key`, rendu avec `qrcode.react` |
| Scan sur place | `/s/[qrKey]` | RPC `resolve_qr` → `check_in` → `check_out` |
| Notifications en direct | toutes les pages | Supabase Realtime sur `bookings` (RLS appliquée) : notification en haut d'écran, pastille sur l'onglet Résas, mise à jour de Réservations et Mes spots sans recharger (`src/components/live-bookings.tsx`) |

## Carte
Les tuiles viennent d'[OpenFreeMap](https://openfreemap.org) (style `dark`), service gratuit et sans clé API. Pour en changer, définissez `NEXT_PUBLIC_MAP_STYLE_URL` (MapTiler, Stadia, style auto-hébergé…).

## Icônes PWA
Les sources sont `public/icons/icon.svg` (coins arrondis) et `public/icons/maskable.svg` (fond plein, zone de sécurité Android). Après une modification :
```bash
npm run icons
```
Le script génère `icon-192/512.png`, `maskable-192/512.png`, `apple-touch-icon.png` et `favicon-32.png`.

## Modèle de sécurité
- **La clé QR n'est jamais exposée par l'API REST** : des privilèges par colonne excluent `spots.qr_key`. On ne peut donc la lire qu'en étant l'hôte (RPC) ou en scannant physiquement le QR, ce qui sert de preuve de présence.
  ⚠️ Conséquence : ne jamais faire `select('*')` sur `spots`. Utiliser `SPOT_COLUMNS` (`src/types/db.ts`).
- **Les réservations ne peuvent pas être modifiées directement** : il n'y a aucune policy UPDATE ni DELETE. Toutes les transitions passent par des fonctions `SECURITY DEFINER` qui vérifient l'auteur, le statut et la fenêtre horaire.
- **Pas de double réservation** : une contrainte d'exclusion GiST interdit tout chevauchement de créneaux sur un même spot.
- **Expiration automatique** (tâche `pg_cron` toutes les 5 min, `expire_bookings()`) : une demande sans réponse au début du créneau passe en `expired`, une réservation confirmée jamais démarrée en `no_show` à la fin du créneau. Les deux libèrent le créneau. L'hôte ne peut plus accepter une demande dont le créneau a commencé.
- **Anti-fraude sur les kWh déclarés** : la valeur est plafonnée à `puissance × durée réelle × 1,05`.
- Le prix est figé au moment de la réservation (`price_per_kwh`, posé par trigger).

## Paiement (Stripe)
Pré-autorisation au démarrage, prélèvement du montant réel à la fin. Les paiements arrivent sur le compte Stripe de la plateforme (commission 0 %).

1. **Au démarrage** (`/s/[qrKey]`), le conducteur valide sa carte : la fonction `payments` bloque `puissance × durée restante du créneau × tarif × 1,05` (minimum 0,50 €), sans le prélever.
2. **Check-in** : la base refuse le démarrage tant que le paiement n'est pas `authorized` (si `app_settings.payments_required` est vrai).
3. **Check-out** : la fonction prélève `total_price` calculé par la base (au plus le montant bloqué) et libère le reste. Sous 0,50 € (minimum Stripe), rien n'est prélevé.
4. **Annulation** avant démarrage : le blocage est libéré.

Sécurité : la clé secrète Stripe n'existe que dans les secrets de l'Edge Function `supabase/functions/payments`. La table `payments` n'est modifiable que par cette fonction (aucun droit d'écriture côté navigateur), et les montants sont toujours calculés à partir de la base, jamais envoyés par le client.

Mise en place : migration `20261114000000_payments.sql`, déploiement de la fonction `payments`, secret `STRIPE_SECRET_KEY`, puis `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` dans `.env.local`, et enfin `update public.app_settings set payments_required = true;`.

## Tests de bout en bout
Deux scripts rejouent le parcours complet sur la vraie base Supabase, avec la seule clé publique : les règles de sécurité (RLS) sont donc réellement mises à l'épreuve.

| Commande | Ce qui est testé | Durée |
|---|---|---|
| `npm run test:e2e:api` | Le parcours hôte → conducteur via l'API, plus ~15 tentatives de triche qui doivent échouer (lire la clé QR d'un autre, forcer un prix, s'auto-confirmer, déclarer trop de kWh…) | ~1 min 30 |
| `npm run test:e2e:ui` | Le même parcours dans un vrai navigateur, écran par écran, avec deux sessions (hôte et conducteur), y compris la désactivation puis la réactivation d'un spot. Captures dans `tests/e2e/screenshots/` | ~2 min 30 |
| `npm run test:e2e` | Les deux à la suite | ~4 min |

**Mise en place (une seule fois)**
1. Créer deux comptes dédiés dans Supabase > Authentication > Users > *Add user*, en cochant *Auto Confirm User*. Astuce Gmail : `vous+hote@gmail.com` et `vous+conducteur@gmail.com` arrivent dans votre boîte.
2. Les renseigner dans `.env.local` (jamais commité) : `E2E_HOST_EMAIL`, `E2E_DRIVER_EMAIL`, `E2E_PASSWORD` (voir `.env.example`).
3. Installer le navigateur de test : `npx playwright install chromium`.
4. Pour le test navigateur, l'app doit tourner : `npm run dev` dans un autre terminal.

Les données créées portent le préfixe `[TEST]`. En fin de test, les spots de test sont désactivés : ils disparaissent de la carte publique mais l'historique reste. Les recharges attendent 70 s avant le check-out, car le plafond anti-fraude dépend du temps écoulé (réglable avec `E2E_CHARGE_SECONDS`).

## Pistes suivantes
- Reversement automatique aux hôtes (Stripe Connect) et commission éventuelle
- Libération automatique des montants bloqués pour les réservations « non honorées » (aujourd'hui : expiration Stripe au bout de 7 jours)
- Splash screens iOS
- Clustering des marqueurs au-delà de ~100 spots visibles
- Clôture des recharges oubliées (`active` sans check-out bien après la fin du créneau)
- Notifications push (Web Push) pour prévenir aussi quand l'app est fermée (le temps réel ne marche qu'app ouverte)
- Photo du compteur du véhicule au check-out, en cas de litige
