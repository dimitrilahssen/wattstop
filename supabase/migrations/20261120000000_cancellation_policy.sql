-- =============================================================================
-- Règle d'annulation (garantie par carte enregistrée)
--   * driver_cards : carte du conducteur enregistrée chez Stripe (client + moyen de paiement).
--     Écrite UNIQUEMENT par l'Edge Function ; le navigateur ne lit que la marque et les 4 chiffres.
--     Quand le paiement est obligatoire, une carte est exigée pour envoyer une demande.
--   * Annulation gratuite d'une demande en attente, jusqu'à 2 h avant le début, ou dans les
--     10 minutes qui suivent la demande. Au-delà, si le conducteur annule une réservation
--     acceptée : frais forfaitaires (2 € par défaut), reversés à l'hôte.
--   * Réservation non honorée (conducteur absent) : mêmes frais.
--   * L'hôte qui annule ne déclenche jamais de frais pour le conducteur.
--   * booking_fees : frais décidés par la base (déclencheur), prélevés ensuite par la fonction
--     (action charge_fees : appel immédiat via pg_net + passage toutes les 10 min).
-- Prérequis : 20261116120000 (pg_net, payments_function_url), 20261117000000 (cancelled_by).
-- Rejouable sans erreur.
-- =============================================================================

alter table public.app_settings
  add column if not exists cancellation_fee_cents integer not null default 200 check (cancellation_fee_cents >= 0),
  add column if not exists free_cancellation_minutes integer not null default 120 check (free_cancellation_minutes >= 0),
  add column if not exists cancellation_grace_minutes integer not null default 10 check (cancellation_grace_minutes >= 0);

-- ---------------------------------------------------------------------------
-- Carte enregistrée du conducteur
-- ---------------------------------------------------------------------------
create table if not exists public.driver_cards (
  driver_id                 uuid primary key references public.profiles (id) on delete cascade,
  stripe_customer_id        text not null unique,
  stripe_payment_method_id  text,
  card_brand                text,
  card_last4                text,
  card_exp_month            smallint,
  card_exp_year             smallint,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

drop trigger if exists driver_cards_set_updated_at on public.driver_cards;
create trigger driver_cards_set_updated_at
  before update on public.driver_cards
  for each row execute function public.set_updated_at();

alter table public.driver_cards enable row level security;
drop policy if exists "driver_cards_select_own" on public.driver_cards;
create policy "driver_cards_select_own" on public.driver_cards for select to authenticated
  using ((select auth.uid()) = driver_id);
revoke all on public.driver_cards from anon, authenticated;
-- Les identifiants Stripe ne sortent jamais vers le navigateur
grant select (driver_id, stripe_payment_method_id, card_brand, card_last4, card_exp_month, card_exp_year, updated_at)
  on public.driver_cards to authenticated;

-- Demande de réservation : carte enregistrée obligatoire quand le paiement l'est
create or replace function public.bookings_require_card()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce((select payments_required from public.app_settings where id), false)
     and not exists (select 1 from public.driver_cards c
                      where c.driver_id = new.driver_id and c.stripe_payment_method_id is not null) then
    raise exception 'Enregistrez une carte bancaire pour réserver (rien n''est prélevé à la demande)' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_with_card on public.bookings;
create trigger bookings_with_card
  before insert on public.bookings
  for each row execute function public.bookings_require_card();

-- ---------------------------------------------------------------------------
-- Frais d'annulation tardive / d'absence
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'booking_fee_kind') then
    create type public.booking_fee_kind as enum ('late_cancellation', 'no_show');
  end if;
  if not exists (select 1 from pg_type where typname = 'booking_fee_status') then
    create type public.booking_fee_status as enum ('pending', 'charged', 'failed', 'waived');
  end if;
end;
$$;

create table if not exists public.booking_fees (
  booking_id                uuid primary key references public.bookings (id) on delete cascade,
  kind                      public.booking_fee_kind not null,
  amount_cents              integer not null check (amount_cents >= 0),
  status                    public.booking_fee_status not null default 'pending',
  stripe_payment_intent_id  text unique,
  failure_message           text,
  payout_status             public.payout_status not null default 'none',
  host_amount_cents         integer check (host_amount_cents >= 0),
  platform_fee_cents        integer check (platform_fee_cents >= 0),
  stripe_transfer_id        text unique,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

drop trigger if exists booking_fees_set_updated_at on public.booking_fees;
create trigger booking_fees_set_updated_at
  before update on public.booking_fees
  for each row execute function public.set_updated_at();

alter table public.booking_fees enable row level security;
drop policy if exists "booking_fees_select_participants" on public.booking_fees;
create policy "booking_fees_select_participants" on public.booking_fees for select to authenticated
  using (exists (select 1 from public.bookings b
                  where b.id = booking_fees.booking_id
                    and (select auth.uid()) in (b.driver_id, b.host_id)));
revoke all on public.booking_fees from anon, authenticated;
grant select on public.booking_fees to authenticated;

-- Annulation gratuite ? (même règle que l'affichage dans l'app)
create or replace function public.cancellation_is_free(p_booking public.bookings, p_at timestamptz default now())
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_booking.status <> 'confirmed'
      or p_at <= p_booking.start_at - make_interval(mins => s.free_cancellation_minutes)
      or p_at <= p_booking.created_at + make_interval(mins => s.cancellation_grace_minutes)
    from public.app_settings s
   where s.id;
$$;

-- Décide des frais au changement de statut (jamais côté navigateur)
create or replace function public.bookings_decide_fee()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fee  integer;
  v_kind public.booking_fee_kind;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  select cancellation_fee_cents into v_fee from public.app_settings where id;
  if coalesce(v_fee, 0) = 0 or not coalesce((select payments_required from public.app_settings where id), false) then
    return new;
  end if;

  if new.status = 'cancelled' and new.cancelled_by = new.driver_id
     and not public.cancellation_is_free(old, now()) then
    v_kind := 'late_cancellation';
  elsif new.status = 'no_show' then
    v_kind := 'no_show';
  else
    return new;
  end if;

  insert into public.booking_fees (booking_id, kind, amount_cents)
  values (new.id, v_kind, v_fee)
  on conflict (booking_id) do nothing;
  return new;
end;
$$;

drop trigger if exists bookings_fee_on_status on public.bookings;
create trigger bookings_fee_on_status
  after update of status on public.bookings
  for each row execute function public.bookings_decide_fee();

-- Prélèvement immédiat : la fonction est prévenue de chaque nouveau frais
create or replace function public.booking_fees_notify()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
begin
  select payments_function_url into v_url from public.app_settings where id;
  if v_url is not null then
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('action', 'charge_fees', 'booking_id', new.booking_id),
      headers := '{"Content-Type":"application/json"}'::jsonb,
      timeout_milliseconds := 20000
    );
  end if;
  return new;
exception when others then
  raise warning 'booking_fees_notify: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists booking_fees_charge on public.booking_fees;
create trigger booking_fees_charge
  after insert on public.booking_fees
  for each row execute function public.booking_fees_notify();

-- Filet de sécurité : les frais pas encore prélevés sont retentés toutes les 10 minutes
do $$
begin
  if exists (select 1 from cron.job where jobname = 'wattstop-charge-fees') then
    perform cron.unschedule('wattstop-charge-fees');
  end if;
  perform cron.schedule(
    'wattstop-charge-fees',
    '*/10 * * * *',
    $job$
      select net.http_post(
        url := s.payments_function_url,
        body := '{"action":"charge_fees"}'::jsonb,
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 20000
      )
      from public.app_settings s
      where s.id and s.payments_function_url is not null
    $job$
  );
end;
$$;

revoke execute on function
  public.bookings_require_card(),
  public.bookings_decide_fee(),
  public.booking_fees_notify()
from public, anon, authenticated;
grant execute on function public.cancellation_is_free(public.bookings, timestamptz) to authenticated;

-- Temps réel : l'écran suit le prélèvement des frais
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'booking_fees') then
    alter publication supabase_realtime add table public.booking_fees;
  end if;
end;
$$;
