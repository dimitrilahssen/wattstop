-- =============================================================================
-- Notifications push (Web Push), même quand l'app est fermée
--   * push_subscriptions : les appareils de chaque utilisateur (il gère les siens)
--   * push_config        : clés VAPID générées par la fonction, illisibles côté navigateur
--   * push_log           : une notification au plus par (réservation, événement)
--   * déclencheur sur bookings : chaque changement de statut appelle la fonction
--     (action notify_booking) via pg_net ; le contenu est relu en base par la fonction
--   * tâche toutes les 5 min : rappel au conducteur 10 min avant la fin de son créneau
-- Prérequis : migration 20261116120000 (pg_net, app_settings.payments_function_url).
-- =============================================================================

create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles (id) on delete cascade,
  endpoint    text not null unique check (endpoint ~ '^https://'),
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
drop policy if exists "push_subscriptions_own_select" on public.push_subscriptions;
create policy "push_subscriptions_own_select" on public.push_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "push_subscriptions_own_insert" on public.push_subscriptions;
create policy "push_subscriptions_own_insert" on public.push_subscriptions for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "push_subscriptions_own_delete" on public.push_subscriptions;
create policy "push_subscriptions_own_delete" on public.push_subscriptions for delete to authenticated
  using ((select auth.uid()) = user_id);
revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, delete on public.push_subscriptions to authenticated;

-- Clés VAPID (une ligne) : seule la fonction (service_role) y accède
create table if not exists public.push_config (
  id           boolean primary key default true check (id),
  public_key   text not null,
  private_key  text not null,
  created_at   timestamptz not null default now()
);
alter table public.push_config enable row level security;
revoke all on public.push_config from anon, authenticated;

-- Anti-doublon : chaque événement n'est notifié qu'une fois
create table if not exists public.push_log (
  booking_id  uuid not null references public.bookings (id) on delete cascade,
  event       text not null,
  sent_at     timestamptz not null default now(),
  primary key (booking_id, event)
);
alter table public.push_log enable row level security;
revoke all on public.push_log from anon, authenticated;

-- Qui a annulé : pour ne prévenir que l'autre partie
alter table public.bookings add column if not exists cancelled_by uuid references public.profiles (id) on delete set null;

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
     set status = 'cancelled',
         cancelled_by = auth.uid()
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

-- Déclencheur : prévient la fonction de chaque nouveau statut (sans jamais bloquer la réservation)
create or replace function public.notify_booking_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  select payments_function_url into v_url from public.app_settings where id;
  if v_url is not null then
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('action', 'notify_booking', 'booking_id', new.id),
      headers := '{"Content-Type":"application/json"}'::jsonb,
      timeout_milliseconds := 10000
    );
  end if;
  return new;
exception when others then
  -- Une notification ratée ne doit jamais empêcher une réservation
  raise warning 'notify_booking_change: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists bookings_notify_change on public.bookings;
create trigger bookings_notify_change
  after insert or update of status on public.bookings
  for each row execute function public.notify_booking_change();

-- Rappel de fin de créneau, toutes les 5 minutes
do $$
begin
  if exists (select 1 from cron.job where jobname = 'wattstop-push-reminders') then
    perform cron.unschedule('wattstop-push-reminders');
  end if;
  perform cron.schedule(
    'wattstop-push-reminders',
    '*/5 * * * *',
    $job$
      select net.http_post(
        url := s.payments_function_url,
        body := '{"action":"push_reminders"}'::jsonb,
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 20000
      )
      from public.app_settings s
      where s.id and s.payments_function_url is not null
    $job$
  );
end;
$$;
