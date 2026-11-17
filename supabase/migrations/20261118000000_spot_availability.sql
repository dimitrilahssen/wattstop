-- =============================================================================
-- Horaires de disponibilité des spots
--   * spot_hours    : plages hebdomadaires (ex. lun 18:00 → 08:00 le lendemain).
--                     Aucune plage = spot disponible à toute heure (comportement d'avant).
--   * spot_closures : fermetures ponctuelles (vacances, travaux), du jour J au jour J' inclus.
--   * la base refuse toute réservation hors horaires ou pendant une fermeture
--     (même en contournant l'app), en plus de l'interdiction de chevauchement existante.
--   * spot_busy_slots : créneaux déjà pris d'un spot (sans dire par qui), pour la fiche.
--   * spots_open_now  : spots libres maintenant (filtre « Disponible maintenant » de la carte).
-- Heures exprimées dans le fuseau du spot (spots.timezone, Europe/Paris par défaut).
-- Rejouable sans erreur.
-- =============================================================================

alter table public.spots add column if not exists timezone text not null default 'Europe/Paris';

-- Plages hebdomadaires. weekday : 1 = lundi … 7 = dimanche (ISO).
-- closes <= opens : la plage se termine le lendemain ; opens = closes : 24 h.
create table if not exists public.spot_hours (
  id        uuid primary key default gen_random_uuid(),
  spot_id   uuid not null references public.spots (id) on delete cascade,
  weekday   smallint not null check (weekday between 1 and 7),
  opens     time not null check (opens < '24:00'),
  closes    time not null
);
create index if not exists spot_hours_spot_idx on public.spot_hours (spot_id, weekday);

create table if not exists public.spot_closures (
  id         uuid primary key default gen_random_uuid(),
  spot_id    uuid not null references public.spots (id) on delete cascade,
  starts_on  date not null,
  ends_on    date not null,
  reason     text check (char_length(reason) <= 200),
  created_at timestamptz not null default now(),
  constraint spot_closures_order check (ends_on >= starts_on),
  constraint spot_closures_max check (ends_on - starts_on <= 366)
);
create index if not exists spot_closures_spot_idx on public.spot_closures (spot_id, ends_on);

-- Lecture : quiconque voit le spot (la RLS de spots s'applique dans la sous-requête)
alter table public.spot_hours enable row level security;
drop policy if exists "spot_hours_select_visible" on public.spot_hours;
create policy "spot_hours_select_visible" on public.spot_hours for select to anon, authenticated
  using (exists (select 1 from public.spots s where s.id = spot_id));
revoke all on public.spot_hours from anon, authenticated;
grant select on public.spot_hours to anon, authenticated;
-- Écriture : uniquement via set_spot_hours (remplacement atomique de la semaine)

alter table public.spot_closures enable row level security;
drop policy if exists "spot_closures_select_visible" on public.spot_closures;
create policy "spot_closures_select_visible" on public.spot_closures for select to anon, authenticated
  using (exists (select 1 from public.spots s where s.id = spot_id));
drop policy if exists "spot_closures_insert_host" on public.spot_closures;
create policy "spot_closures_insert_host" on public.spot_closures for insert to authenticated
  with check (exists (select 1 from public.spots s where s.id = spot_id and s.host_id = (select auth.uid())));
drop policy if exists "spot_closures_delete_host" on public.spot_closures;
create policy "spot_closures_delete_host" on public.spot_closures for delete to authenticated
  using (exists (select 1 from public.spots s where s.id = spot_id and s.host_id = (select auth.uid())));
revoke all on public.spot_closures from anon, authenticated;
grant select on public.spot_closures to anon, authenticated;
grant insert (spot_id, starts_on, ends_on, reason), delete on public.spot_closures to authenticated;

-- Le créneau [p_from, p_to) est-il réservable côté horaires ?
-- null = oui ; 'closed' = fermeture ponctuelle ; 'hours' = hors des plages hebdomadaires.
create or replace function public.spot_slot_problem(p_spot_id uuid, p_from timestamptz, p_to timestamptz)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz    text;
  v_open  tstzmultirange;
  v_slot  tstzrange := tstzrange(p_from, p_to, '[)');
begin
  select timezone into v_tz from public.spots where id = p_spot_id;
  if v_tz is null then
    return null; -- spot inexistant : les autres contrôles s'en chargent
  end if;

  if exists (
    select 1 from public.spot_closures c
     where c.spot_id = p_spot_id
       and tstzrange(c.starts_on::timestamp at time zone v_tz,
                     (c.ends_on + 1)::timestamp at time zone v_tz, '[)') && v_slot
  ) then
    return 'closed';
  end if;

  if not exists (select 1 from public.spot_hours h where h.spot_id = p_spot_id) then
    return null; -- pas d'horaires : disponible à toute heure
  end if;

  -- Plages ouvertes sur les jours couverts (la veille comprise, pour les plages de nuit),
  -- fusionnées : lun 18:00 → 24:00 et mar 00:00 → 08:00 forment une seule plage.
  select range_agg(tstzrange(
           (x.d + h.opens) at time zone v_tz,
           ((x.d + case when h.closes > h.opens then 0 else 1 end) + h.closes) at time zone v_tz,
           '[)'))
    into v_open
    from generate_series(((p_from at time zone v_tz)::date - 1)::timestamp,
                         (p_to at time zone v_tz)::date::timestamp, interval '1 day') g(day)
    cross join lateral (select g.day::date as d) x
    join public.spot_hours h
      on h.spot_id = p_spot_id and h.weekday = extract(isodow from x.d);

  if v_open is null or not v_open @> v_slot then
    return 'hours';
  end if;
  return null;
end;
$$;

-- Contrôle à chaque nouvelle réservation (après la normalisation : nom de trigger postérieur)
create or replace function public.bookings_check_hours()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_problem text := public.spot_slot_problem(new.spot_id, new.start_at, new.end_at);
begin
  if v_problem = 'closed' then
    raise exception 'Ce spot est fermé à ces dates' using errcode = 'P0001';
  elsif v_problem = 'hours' then
    raise exception 'Créneau en dehors des horaires de disponibilité de ce spot' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_within_hours on public.bookings;
create trigger bookings_within_hours
  before insert on public.bookings
  for each row execute function public.bookings_check_hours();

-- Hôte : remplace toutes les plages d'un spot. [] = disponible à toute heure.
-- p_hours : [{"weekday":1,"opens":"18:00","closes":"08:00"}, …]
create or replace function public.set_spot_hours(p_spot_id uuid, p_hours jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.spots where id = p_spot_id and host_id = auth.uid()) then
    raise exception 'Spot introuvable' using errcode = '42501';
  end if;
  if p_hours is null or jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 70 then
    raise exception 'Horaires invalides' using errcode = '22023';
  end if;

  delete from public.spot_hours where spot_id = p_spot_id;
  insert into public.spot_hours (spot_id, weekday, opens, closes)
  select p_spot_id, (x ->> 'weekday')::smallint, (x ->> 'opens')::time, (x ->> 'closes')::time
    from jsonb_array_elements(p_hours) x;
end;
$$;

-- Créneaux déjà pris (demandes en attente, acceptées, en cours) des 14 prochains jours.
-- Ne révèle ni le conducteur ni le statut.
create or replace function public.spot_busy_slots(p_spot_id uuid)
returns table (start_at timestamptz, end_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select b.start_at, b.end_at
    from public.bookings b
    join public.spots s on s.id = b.spot_id
   where b.spot_id = p_spot_id
     and (s.is_active or s.host_id = auth.uid())
     and b.status in ('pending', 'confirmed', 'active')
     and b.end_at > now()
     and b.start_at < now() + interval '14 days'
   order by b.start_at
   limit 200;
$$;

-- Parmi ces spots, ceux où l'on peut démarrer une recharge d'au moins 1 h maintenant
create or replace function public.spots_open_now(p_ids uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.id
    from public.spots s
   where s.id = any (p_ids[1:500])
     and s.is_active
     and public.spot_slot_problem(s.id, now(), now() + interval '1 hour') is null
     and not exists (
       select 1 from public.bookings b
        where b.spot_id = s.id
          and b.status in ('pending', 'confirmed', 'active')
          and tstzrange(b.start_at, b.end_at, '[)') && tstzrange(now(), now() + interval '1 hour', '[)')
     );
$$;

revoke execute on function
  public.spot_slot_problem(uuid, timestamptz, timestamptz),
  public.bookings_check_hours(),
  public.set_spot_hours(uuid, jsonb),
  public.spot_busy_slots(uuid),
  public.spots_open_now(uuid[])
from public, anon, authenticated;

grant execute on function public.set_spot_hours(uuid, jsonb) to authenticated;
grant execute on function public.spot_busy_slots(uuid), public.spots_open_now(uuid[]) to anon, authenticated;
