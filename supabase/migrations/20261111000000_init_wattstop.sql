-- =============================================================================
--  WattStop — Recharge VE en P2P, modèle "Zero Hardware" (QR codes)
--  Migration initiale : profiles, spots, bookings + RLS + RPC sécurisées
--  Cible : Supabase (PostgreSQL 15+)
-- =============================================================================
--  Principes de sécurité :
--   1. RLS activée sur TOUTES les tables exposées.
--   2. La clé QR (spots.qr_key) n'est JAMAIS lisible via l'API REST :
--      privilèges par colonne + accès uniquement via fonctions SECURITY DEFINER.
--      => impossible de "check-in" à distance sans être physiquement devant le QR.
--   3. Les transitions de statut des réservations passent exclusivement par des
--      fonctions RPC (pas de policy UPDATE/DELETE côté client) : le prix, les
--      horodatages et le statut ne peuvent pas être falsifiés.
--   4. Anti double-réservation garantie en base (contrainte d'exclusion GiST).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Extensions
-- -----------------------------------------------------------------------------
create extension if not exists postgis    with schema extensions;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto   with schema extensions;

-- -----------------------------------------------------------------------------
-- 1. Types énumérés
-- -----------------------------------------------------------------------------
create type public.user_role as enum ('driver', 'host', 'both');

create type public.connector_type as enum (
  'type2',            -- Wallbox Type 2 (standard EU)
  'type2_cable',      -- Wallbox avec câble attaché
  'domestic_socket',  -- Prise domestique / Green'Up
  'ccs',              -- DC combo
  'chademo'
);

create type public.booking_status as enum (
  'pending',    -- demandée par le conducteur, en attente de l'hôte
  'confirmed',  -- acceptée par l'hôte
  'active',     -- check-in effectué via scan du QR
  'completed',  -- check-out effectué via scan du QR
  'cancelled',  -- annulée (conducteur ou hôte)
  'rejected'    -- refusée par l'hôte
);

-- -----------------------------------------------------------------------------
-- 2. Fonction utilitaire updated_at
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- =============================================================================
-- 3. PROFILES
-- =============================================================================
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  full_name      text check (char_length(full_name) <= 120),
  avatar_url     text check (char_length(avatar_url) <= 2048),
  role           public.user_role not null default 'driver',
  vehicle_model  text check (char_length(vehicle_model) <= 120),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.profiles is 'Profil public lié 1-1 à auth.users.';

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Création automatique du profil à l'inscription
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), 120),
    left(new.raw_user_meta_data ->> 'avatar_url', 2048)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =============================================================================
-- 4. SPOTS (bornes / prises partagées)
-- =============================================================================
create table public.spots (
  id                   uuid primary key default gen_random_uuid(),
  host_id              uuid not null references public.profiles (id) on delete cascade,
  title                text not null check (char_length(title) between 3 and 120),
  description          text check (char_length(description) <= 2000),
  address              text not null check (char_length(address) <= 300),
  -- Géolocalisation (WGS84). Insertion côté client : 'SRID=4326;POINT(lng lat)'
  location             extensions.geography(Point, 4326) not null,
  connector_type       public.connector_type not null,
  power_kw             numeric(5, 1) not null check (power_kw > 0 and power_kw <= 350),
  price_per_kwh        numeric(6, 3) not null check (price_per_kwh >= 0 and price_per_kwh <= 5),
  access_instructions  text check (char_length(access_instructions) <= 2000),
  photos               text[] not null default '{}',
  is_active            boolean not null default true,
  -- Clé secrète imprimée dans le QR code collé sur la prise (128 bits d'entropie)
  qr_key               text not null unique
                         default encode(extensions.gen_random_bytes(16), 'hex'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on column public.spots.qr_key is
  'Secret physique du QR. Non lisible via PostgREST : utiliser get_spot_qr_key() (hôte) ou les RPC check_in/check_out.';

create index spots_location_gix on public.spots using gist (location);
create index spots_host_id_idx  on public.spots (host_id);
create index spots_active_idx   on public.spots (is_active) where is_active;

create trigger spots_set_updated_at
  before update on public.spots
  for each row execute function public.set_updated_at();

-- Un conducteur qui publie un spot devient automatiquement hôte
create or replace function public.promote_to_host()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set role = case when role = 'driver' then 'both'::public.user_role else role end
   where id = new.host_id;
  return new;
end;
$$;

create trigger spots_promote_host
  after insert on public.spots
  for each row execute function public.promote_to_host();

-- =============================================================================
-- 5. BOOKINGS (réservations / sessions de recharge)
-- =============================================================================
create table public.bookings (
  id               uuid primary key default gen_random_uuid(),
  spot_id          uuid not null references public.spots (id) on delete restrict,
  driver_id        uuid not null references public.profiles (id) on delete cascade,
  host_id          uuid not null references public.profiles (id) on delete cascade, -- dénormalisé (RLS), posé par trigger
  start_at         timestamptz not null,
  end_at           timestamptz not null,
  status           public.booking_status not null default 'pending',
  price_per_kwh    numeric(6, 3) not null,  -- snapshot du tarif au moment de la réservation, posé par trigger
  checked_in_at    timestamptz,
  checked_out_at   timestamptz,
  energy_kwh       numeric(7, 2) check (energy_kwh >= 0),
  total_price      numeric(10, 2) check (total_price >= 0),
  driver_note      text check (char_length(driver_note) <= 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint bookings_time_order   check (end_at > start_at),
  constraint bookings_max_duration check (end_at - start_at <= interval '12 hours'),
  constraint bookings_not_self     check (driver_id <> host_id),
  -- Aucun chevauchement de créneaux "vivants" sur un même spot
  constraint bookings_no_overlap exclude using gist (
    spot_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('pending', 'confirmed', 'active'))
);

create index bookings_driver_idx on public.bookings (driver_id, start_at desc);
create index bookings_host_idx   on public.bookings (host_id, start_at desc);
create index bookings_spot_idx   on public.bookings (spot_id, start_at);

create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();

-- Normalisation à l'insertion : impossible pour le client de forcer statut/prix/hôte
create or replace function public.bookings_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_spot public.spots%rowtype;
begin
  select * into v_spot from public.spots where id = new.spot_id;

  if not found or not v_spot.is_active then
    raise exception 'Spot indisponible' using errcode = 'P0001';
  end if;

  if v_spot.host_id = new.driver_id then
    raise exception 'Vous ne pouvez pas réserver votre propre spot' using errcode = 'P0001';
  end if;

  if new.start_at < now() - interval '5 minutes' then
    raise exception 'Le créneau doit commencer dans le futur' using errcode = 'P0001';
  end if;

  new.host_id        := v_spot.host_id;
  new.price_per_kwh  := v_spot.price_per_kwh;
  new.status         := 'pending';
  new.checked_in_at  := null;
  new.checked_out_at := null;
  new.energy_kwh     := null;
  new.total_price    := null;
  return new;
end;
$$;

create trigger bookings_normalize_insert
  before insert on public.bookings
  for each row execute function public.bookings_before_insert();

-- =============================================================================
-- 6. ROW LEVEL SECURITY
-- =============================================================================
alter table public.profiles enable row level security;
alter table public.spots    enable row level security;
alter table public.bookings enable row level security;

-- ---------- PROFILES ----------
-- Lecture : tout utilisateur connecté (profil public : nom, avatar, véhicule)
create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated
  using (true);

-- Mise à jour : uniquement son propre profil
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);
-- Pas d'INSERT (trigger handle_new_user) ni de DELETE (cascade depuis auth.users)

-- ---------- SPOTS ----------
-- Lecture : spots actifs visibles par tous (carte publique), + ses propres spots inactifs
create policy "spots_select_active_or_own"
  on public.spots for select
  to anon, authenticated
  using (is_active or (select auth.uid()) = host_id);

create policy "spots_insert_own"
  on public.spots for insert
  to authenticated
  with check ((select auth.uid()) = host_id);

create policy "spots_update_own"
  on public.spots for update
  to authenticated
  using ((select auth.uid()) = host_id)
  with check ((select auth.uid()) = host_id);

create policy "spots_delete_own"
  on public.spots for delete
  to authenticated
  using ((select auth.uid()) = host_id);

-- ---------- BOOKINGS ----------
-- Lecture : le conducteur et l'hôte concernés uniquement
create policy "bookings_select_participants"
  on public.bookings for select
  to authenticated
  using ((select auth.uid()) in (driver_id, host_id));

-- Création : uniquement pour soi-même (le trigger fixe host/prix/statut)
create policy "bookings_insert_as_driver"
  on public.bookings for insert
  to authenticated
  with check ((select auth.uid()) = driver_id);

-- Pas de policy UPDATE / DELETE : toutes les transitions passent par les RPC ci-dessous.

-- =============================================================================
-- 7. PRIVILÈGES PAR COLONNE (défense en profondeur, en plus de la RLS)
-- =============================================================================
-- Supabase accorde ALL par défaut à anon/authenticated : on resserre.

-- profiles
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name, avatar_url, vehicle_model) on public.profiles to authenticated;

-- spots : qr_key exclue de toute lecture/écriture directe
revoke all on public.spots from anon, authenticated;
grant select (
  id, host_id, title, description, address, location, connector_type, power_kw,
  price_per_kwh, access_instructions, photos, is_active, created_at, updated_at
) on public.spots to anon, authenticated;
grant insert (
  host_id, title, description, address, location, connector_type, power_kw,
  price_per_kwh, access_instructions, photos, is_active
) on public.spots to authenticated;
grant update (
  title, description, address, location, connector_type, power_kw,
  price_per_kwh, access_instructions, photos, is_active
) on public.spots to authenticated;
grant delete on public.spots to authenticated;

-- bookings : lecture + insertion limitée, aucune mise à jour directe
revoke all on public.bookings from anon, authenticated;
grant select on public.bookings to authenticated;
grant insert (spot_id, driver_id, start_at, end_at, driver_note) on public.bookings to authenticated;

-- =============================================================================
-- 8. FONCTIONS RPC
-- =============================================================================

-- 8.1 Recherche géographique des spots proches (SECURITY INVOKER => RLS appliquée)
create or replace function public.nearby_spots(
  p_lat       double precision,
  p_lng       double precision,
  p_radius_m  integer default 10000,
  p_limit     integer default 50
)
returns table (
  id              uuid,
  title           text,
  address         text,
  connector_type  public.connector_type,
  power_kw        numeric,
  price_per_kwh   numeric,
  lat             double precision,
  lng             double precision,
  distance_m      double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with origin as (
    select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography as g
  )
  select s.id, s.title, s.address, s.connector_type, s.power_kw, s.price_per_kwh,
         extensions.st_y(s.location::extensions.geometry) as lat,
         extensions.st_x(s.location::extensions.geometry) as lng,
         extensions.st_distance(s.location, o.g)          as distance_m
    from public.spots s, origin o
   where s.is_active
     and extensions.st_dwithin(s.location, o.g, least(greatest(p_radius_m, 100), 100000))
   order by s.location operator(extensions.<->) o.g
   limit least(greatest(p_limit, 1), 200);
$$;

-- 8.2 Hôte : récupérer la clé QR d'un de ses spots (pour l'imprimer)
create or replace function public.get_spot_qr_key(p_spot_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  select qr_key into v_key
    from public.spots
   where id = p_spot_id and host_id = auth.uid();

  if v_key is null then
    raise exception 'Spot introuvable ou non autorisé' using errcode = '42501';
  end if;
  return v_key;
end;
$$;

-- 8.3 Hôte : régénérer la clé QR (QR volé / abîmé). L'ancien QR devient invalide.
create or replace function public.regenerate_spot_qr_key(p_spot_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  update public.spots
     set qr_key = encode(extensions.gen_random_bytes(16), 'hex')
   where id = p_spot_id and host_id = auth.uid()
  returning qr_key into v_key;

  if v_key is null then
    raise exception 'Spot introuvable ou non autorisé' using errcode = '42501';
  end if;
  return v_key;
end;
$$;

-- 8.4 Résolution d'un QR scanné : infos du spot + réservation pertinente de l'appelant
create or replace function public.resolve_qr(p_qr_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_spot    public.spots%rowtype;
  v_booking public.bookings%rowtype;
begin
  if v_uid is null then
    raise exception 'Authentification requise' using errcode = '42501';
  end if;

  select * into v_spot from public.spots where qr_key = p_qr_key;
  if not found then
    raise exception 'QR code invalide' using errcode = 'P0002';
  end if;

  -- Réservation "active" en priorité, sinon la prochaine "confirmed" du jour
  select * into v_booking
    from public.bookings b
   where b.spot_id = v_spot.id
     and b.driver_id = v_uid
     and (b.status = 'active'
          or (b.status = 'confirmed' and b.end_at > now() and b.start_at < now() + interval '12 hours'))
   order by (b.status = 'active') desc, b.start_at
   limit 1;

  return jsonb_build_object(
    'spot', jsonb_build_object(
      'id', v_spot.id,
      'title', v_spot.title,
      'address', v_spot.address,
      'connector_type', v_spot.connector_type,
      'power_kw', v_spot.power_kw,
      'price_per_kwh', v_spot.price_per_kwh,
      'access_instructions', v_spot.access_instructions,
      'is_active', v_spot.is_active
    ),
    'is_host', v_spot.host_id = v_uid,
    'booking', case when v_booking.id is null then null else jsonb_build_object(
      'id', v_booking.id,
      'status', v_booking.status,
      'start_at', v_booking.start_at,
      'end_at', v_booking.end_at,
      'checked_in_at', v_booking.checked_in_at
    ) end
  );
end;
$$;

-- 8.5 Hôte : accepter / refuser une demande
create or replace function public.respond_booking(p_booking_id uuid, p_accept boolean)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.bookings;
begin
  update public.bookings
     set status = case when p_accept then 'confirmed' else 'rejected' end::public.booking_status
   where id = p_booking_id
     and host_id = auth.uid()
     and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Réservation introuvable ou déjà traitée' using errcode = 'P0001';
  end if;
  return v_row;
end;
$$;

-- 8.6 Conducteur ou hôte : annuler (avant check-in uniquement)
create or replace function public.cancel_booking(p_booking_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.bookings;
begin
  update public.bookings
     set status = 'cancelled'
   where id = p_booking_id
     and auth.uid() in (driver_id, host_id)
     and status in ('pending', 'confirmed')
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Annulation impossible' using errcode = 'P0001';
  end if;
  return v_row;
end;
$$;

-- 8.7 Conducteur : CHECK-IN en scannant le QR (preuve de présence physique)
create or replace function public.check_in(p_qr_key text)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_spot_id uuid;
  v_row     public.bookings;
begin
  select id into v_spot_id from public.spots where qr_key = p_qr_key and is_active;
  if v_spot_id is null then
    raise exception 'QR code invalide' using errcode = 'P0002';
  end if;

  update public.bookings
     set status = 'active',
         checked_in_at = now()
   where id = (
           select b.id from public.bookings b
            where b.spot_id = v_spot_id
              and b.driver_id = auth.uid()
              and b.status = 'confirmed'
              and now() between b.start_at - interval '15 minutes' and b.end_at
            order by b.start_at
            limit 1
            for update
         )
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Aucune réservation confirmée pour ce créneau' using errcode = 'P0001';
  end if;
  return v_row;
end;
$$;

-- 8.8 Conducteur : CHECK-OUT en scannant le QR + déclaration des kWh
--     Anti-fraude : kWh plafonnés à puissance × durée réelle (+5 % de tolérance).
create or replace function public.check_out(p_qr_key text, p_energy_kwh numeric)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_spot     public.spots%rowtype;
  v_booking  public.bookings%rowtype;
  v_max_kwh  numeric;
  v_row      public.bookings;
begin
  if p_energy_kwh is null or p_energy_kwh < 0 then
    raise exception 'Énergie invalide' using errcode = '22023';
  end if;

  select * into v_spot from public.spots where qr_key = p_qr_key;
  if not found then
    raise exception 'QR code invalide' using errcode = 'P0002';
  end if;

  select * into v_booking
    from public.bookings
   where spot_id = v_spot.id
     and driver_id = auth.uid()
     and status = 'active'
   for update;

  if not found then
    raise exception 'Aucune session de recharge active sur ce spot' using errcode = 'P0001';
  end if;

  v_max_kwh := v_spot.power_kw
             * extract(epoch from (now() - v_booking.checked_in_at)) / 3600.0
             * 1.05;

  if p_energy_kwh > v_max_kwh then
    raise exception 'Énergie déclarée incohérente (max théorique : % kWh)', round(v_max_kwh, 2)
      using errcode = '22023';
  end if;

  update public.bookings
     set status         = 'completed',
         checked_out_at = now(),
         energy_kwh     = round(p_energy_kwh, 2),
         total_price    = round(p_energy_kwh * v_booking.price_per_kwh, 2)
   where id = v_booking.id
  returning * into v_row;

  return v_row;
end;
$$;

-- Droits d'exécution : jamais pour anon (sauf recherche publique)
revoke execute on function
  public.get_spot_qr_key(uuid),
  public.regenerate_spot_qr_key(uuid),
  public.resolve_qr(text),
  public.respond_booking(uuid, boolean),
  public.cancel_booking(uuid),
  public.check_in(text),
  public.check_out(text, numeric)
from public, anon;

grant execute on function
  public.get_spot_qr_key(uuid),
  public.regenerate_spot_qr_key(uuid),
  public.resolve_qr(text),
  public.respond_booking(uuid, boolean),
  public.cancel_booking(uuid),
  public.check_in(text),
  public.check_out(text, numeric)
to authenticated;

grant execute on function public.nearby_spots(double precision, double precision, integer, integer)
  to anon, authenticated;

-- Fonctions internes de trigger : non appelables via l'API
revoke execute on function
  public.handle_new_user(),
  public.promote_to_host(),
  public.bookings_before_insert()
from public, anon, authenticated;

-- =============================================================================
-- 9. STORAGE : photos des spots (bucket public en lecture, écriture dans son dossier)
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('spot-photos', 'spot-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "spot_photos_insert_own_folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'spot-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "spot_photos_delete_own_folder"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'spot-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- =============================================================================
-- 10. REALTIME : notifications de réservation (RLS respectée par Realtime)
-- =============================================================================
alter publication supabase_realtime add table public.bookings;
