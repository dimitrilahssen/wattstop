-- =============================================================================
-- Paiements Stripe (pré-autorisation au check-in, capture au check-out)
--   * public.payments : un paiement par réservation. Écrit UNIQUEMENT par l'Edge
--     Function « payments » (rôle service_role) après vérification auprès de Stripe :
--     aucun droit d'écriture pour anon / authenticated, donc impossible à falsifier.
--   * check_in exige un paiement « authorized » quand app_settings.payments_required
--     est vrai (activé en dernière étape, une fois Stripe configuré).
-- =============================================================================

create type public.payment_status as enum (
  'requires_authorization', -- PaymentIntent créé, carte pas encore validée
  'authorized',             -- montant bloqué sur la carte (capture manuelle)
  'captured',               -- montant réel prélevé
  'waived',                 -- montant final < 0,50 € (minimum Stripe) : rien n'est prélevé
  'canceled',               -- blocage libéré sans prélèvement
  'failed'
);

create table public.payments (
  booking_id               uuid primary key references public.bookings (id) on delete cascade,
  stripe_payment_intent_id text not null unique,
  status                   public.payment_status not null default 'requires_authorization',
  currency                 text not null default 'eur',
  amount_authorized_cents  integer not null check (amount_authorized_cents >= 0),
  amount_captured_cents    integer check (amount_captured_cents >= 0),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

alter table public.payments enable row level security;

-- Lecture : le conducteur et l'hôte de la réservation
create policy "payments_select_participants"
  on public.payments for select
  to authenticated
  using (
    exists (
      select 1 from public.bookings b
       where b.id = payments.booking_id
         and (select auth.uid()) in (b.driver_id, b.host_id)
    )
  );

revoke all on public.payments from anon, authenticated;
grant select on public.payments to authenticated;

-- Réglages globaux de l'app (une seule ligne)
create table public.app_settings (
  id                boolean primary key default true check (id),
  payments_required boolean not null default false
);
insert into public.app_settings (id) values (true) on conflict do nothing;

alter table public.app_settings enable row level security;
create policy "app_settings_select_all" on public.app_settings for select to anon, authenticated using (true);
revoke all on public.app_settings from anon, authenticated;
grant select on public.app_settings to anon, authenticated;

-- check_in : paiement autorisé obligatoire quand payments_required est vrai
create or replace function public.check_in(p_qr_key text)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_spot_id    uuid;
  v_booking_id uuid;
  v_row        public.bookings;
begin
  select id into v_spot_id from public.spots where qr_key = p_qr_key and is_active;
  if v_spot_id is null then
    raise exception 'QR code invalide' using errcode = 'P0002';
  end if;

  select b.id into v_booking_id
    from public.bookings b
   where b.spot_id = v_spot_id
     and b.driver_id = auth.uid()
     and b.status = 'confirmed'
     and now() between b.start_at - interval '15 minutes' and b.end_at
   order by b.start_at
   limit 1
   for update;

  if v_booking_id is null then
    raise exception 'Aucune réservation confirmée pour ce créneau' using errcode = 'P0001';
  end if;

  if (select payments_required from public.app_settings where id)
     and not exists (select 1 from public.payments p
                      where p.booking_id = v_booking_id and p.status = 'authorized') then
    raise exception 'Paiement non autorisé : validez d''abord votre carte' using errcode = 'P0001';
  end if;

  update public.bookings
     set status = 'active', checked_in_at = now()
   where id = v_booking_id
  returning * into v_row;
  return v_row;
end;
$$;

-- Temps réel : l'écran suit l'état du paiement
alter publication supabase_realtime add table public.payments;
