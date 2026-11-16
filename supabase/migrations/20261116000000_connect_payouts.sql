-- =============================================================================
-- Reversement aux hôtes (Stripe Connect, comptes Express)
--   * host_payout_accounts : compte Stripe de chaque hôte et son état de vérification.
--   * payments : part de l'hôte, commission, transfert Stripe et état du reversement.
-- Comme pour payments, ces données ne sont écrites QUE par l'Edge Function
-- (service_role) après vérification auprès de Stripe : aucun droit d'écriture côté navigateur.
-- =============================================================================

create table public.host_payout_accounts (
  host_id            uuid primary key references public.profiles (id) on delete cascade,
  stripe_account_id  text not null unique,
  details_submitted  boolean not null default false,  -- formulaire Stripe rempli
  payouts_enabled    boolean not null default false,  -- virements vers le compte bancaire possibles
  transfers_active   boolean not null default false,  -- la plateforme peut lui transférer de l'argent
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger host_payout_accounts_set_updated_at
  before update on public.host_payout_accounts
  for each row execute function public.set_updated_at();

alter table public.host_payout_accounts enable row level security;
create policy "host_payout_accounts_select_own"
  on public.host_payout_accounts for select
  to authenticated
  using ((select auth.uid()) = host_id);
revoke all on public.host_payout_accounts from anon, authenticated;
grant select on public.host_payout_accounts to authenticated;

create type public.payout_status as enum (
  'none',                   -- rien à reverser (pas encore prélevé, ou montant non prélevé)
  'awaiting_host_account',  -- prélevé, en attente que l'hôte active ses paiements
  'transferred',            -- transféré sur le compte Stripe de l'hôte
  'failed'
);

alter table public.payments
  add column payout_status      public.payout_status not null default 'none',
  add column host_amount_cents  integer check (host_amount_cents >= 0),
  add column platform_fee_cents integer check (platform_fee_cents >= 0),
  add column stripe_transfer_id text unique;

-- L'hôte suit en direct l'activation de son compte
alter publication supabase_realtime add table public.host_payout_accounts;
