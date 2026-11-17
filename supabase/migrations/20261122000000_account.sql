-- =============================================================================
-- Page « Mon compte »
--   * Prénom obligatoire pour réserver ou publier un spot (l'hôte et le conducteur se voient,
--     les avis publics affichent le prénom). Demandé à la première connexion.
--   * Suppression du compte (RGPD) : faite par l'Edge Function (action account_delete) qui
--     efface les données personnelles et bloque la connexion. L'historique des réservations
--     et des paiements est conservé de façon anonyme (obligation comptable, et l'autre partie
--     garde son historique) : d'où profiles.deleted_at plutôt qu'une suppression en cascade.
-- Rejouable sans erreur.
-- =============================================================================

alter table public.profiles add column if not exists deleted_at timestamptz;

-- Prénom obligatoire pour réserver
create or replace function public.bookings_require_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles p
                  where p.id = new.driver_id
                    and p.deleted_at is null
                    and char_length(btrim(coalesce(p.full_name, ''))) > 0) then
    raise exception 'Indiquez votre prénom dans « Mon compte » avant de réserver' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_with_name on public.bookings;
create trigger bookings_with_name
  before insert on public.bookings
  for each row execute function public.bookings_require_name();

-- Prénom obligatoire pour publier un spot
create or replace function public.spots_require_name()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.profiles p
                  where p.id = new.host_id
                    and p.deleted_at is null
                    and char_length(btrim(coalesce(p.full_name, ''))) > 0) then
    raise exception 'Indiquez votre prénom dans « Mon compte » avant de publier un spot' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists spots_with_name on public.spots;
create trigger spots_with_name
  before insert on public.spots
  for each row execute function public.spots_require_name();

revoke execute on function public.bookings_require_name(), public.spots_require_name() from public, anon, authenticated;
