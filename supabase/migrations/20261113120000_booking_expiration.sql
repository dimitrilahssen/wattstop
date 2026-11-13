-- =============================================================================
-- Expiration automatique des réservations
--   * pending   dont le créneau a commencé sans réponse de l'hôte → expired
--   * confirmed dont le créneau est terminé sans check-in         → no_show
-- Les deux statuts sortent de la contrainte anti-chevauchement : le créneau est libéré.
-- Exécution : toutes les 5 minutes via pg_cron (+ appelable à la demande).
-- =============================================================================

-- 1. Nouveaux statuts
alter type public.booking_status add value if not exists 'expired';
alter type public.booking_status add value if not exists 'no_show';

-- 2. Fonction d'expiration (idempotente)
--    En plpgsql : les nouveaux statuts ne sont résolus qu'à l'exécution,
--    ce qui permet de tout lancer dans une seule requête.
create or replace function public.expire_bookings()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.bookings
     set status = 'expired'
   where status = 'pending'
     and start_at <= now();

  update public.bookings
     set status = 'no_show'
   where status = 'confirmed'
     and end_at <= now();
end;
$$;

-- Appelable par les utilisateurs connectés : elle n'applique que des règles horaires
-- globales, sans paramètre ni donnée renvoyée (utile aux tests et à un rafraîchissement manuel).
revoke execute on function public.expire_bookings() from public, anon;
grant execute on function public.expire_bookings() to authenticated;

-- 3. L'hôte ne peut plus accepter une demande dont le créneau a déjà commencé,
--    même si la tâche planifiée n'est pas encore passée.
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
     and start_at > now()
  returning * into v_row;

  if v_row.id is null then
    if exists (select 1 from public.bookings
                where id = p_booking_id and host_id = auth.uid()
                  and status = 'pending' and start_at <= now()) then
      raise exception 'Demande expirée : le créneau a déjà commencé' using errcode = 'P0001';
    end if;
    raise exception 'Réservation introuvable ou déjà traitée' using errcode = 'P0001';
  end if;
  return v_row;
end;
$$;

-- 4. Planification toutes les 5 minutes (pg_cron est disponible sur Supabase)
create extension if not exists pg_cron;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'wattstop-expire-bookings') then
    perform cron.unschedule('wattstop-expire-bookings');
  end if;
  perform cron.schedule('wattstop-expire-bookings', '*/5 * * * *', 'select public.expire_bookings()');
end;
$$;
