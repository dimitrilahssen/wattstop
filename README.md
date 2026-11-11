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

Base de données : exécuter `supabase/migrations/20261111000000_init_wattstop.sql`, soit dans le SQL Editor de Supabase, soit avec `supabase db push`.

Dans Supabase > Auth > URL Configuration, ajouter `http://localhost:3000/auth/callback` (puis l'URL de prod) dans les Redirect URLs.

## Parcours
| Étape | Route | Mécanisme |
|---|---|---|
| Trouver un spot | `/map` | RPC `nearby_spots` (PostGIS `ST_DWithin`, tri KNN) |
| Réserver | `/spots/[id]` | `insert` dans `bookings` (le trigger impose hôte, prix et statut) |
| Accepter / refuser | `/bookings` | RPC `respond_booking` / `cancel_booking` |
| Imprimer le QR | `/host` | RPC `get_spot_qr_key` / `regenerate_spot_qr_key`, rendu avec `qrcode.react` |
| Scan sur place | `/s/[qrKey]` | RPC `resolve_qr` → `check_in` → `check_out` |

## Modèle de sécurité
- **La clé QR n'est jamais exposée par l'API REST** : des privilèges par colonne excluent `spots.qr_key`. On ne peut donc la lire qu'en étant l'hôte (RPC) ou en scannant physiquement le QR, ce qui sert de preuve de présence.
  ⚠️ Conséquence : ne jamais faire `select('*')` sur `spots`. Utiliser `SPOT_COLUMNS` (`src/types/db.ts`).
- **Les réservations ne peuvent pas être modifiées directement** : il n'y a aucune policy UPDATE ni DELETE. Toutes les transitions passent par des fonctions `SECURITY DEFINER` qui vérifient l'auteur, le statut et la fenêtre horaire.
- **Pas de double réservation** : une contrainte d'exclusion GiST interdit tout chevauchement de créneaux sur un même spot.
- **Anti-fraude sur les kWh déclarés** : la valeur est plafonnée à `puissance × durée réelle × 1,05`.
- Le prix est figé au moment de la réservation (`price_per_kwh`, posé par trigger).

## Pistes suivantes
- Vue carte (MapLibre GL ou Leaflet) branchée sur `nearby_spots`
- Paiement : Stripe Connect (pré-autorisation au check-in, capture au check-out)
- Icônes PNG 192/512 et splash screens iOS
- Expiration automatique des réservations `pending` ou `confirmed` passées (pg_cron)
- Notifications push (Web Push) déclenchées par Realtime sur `bookings`
- Photo du compteur du véhicule au check-out, en cas de litige
