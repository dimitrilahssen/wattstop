-- =============================================================================
-- Recharges oubliées (le conducteur n'a pas scanné à la fin)
--   * active, 1 h après la fin du créneau      → awaiting_meter (l'hôte déclare les kWh)
--     La durée facturable s'arrête à la fin du créneau (checked_out_at = end_at).
--   * awaiting_meter sans relevé sous 24 h     → unbilled (rien n'est facturé)
--   * declare_meter : l'hôte saisit les kWh de son compteur, plafonnés par l'anti-fraude
--     (puissance × durée branchée × 1,05) ; la réservation passe en completed et le
--     paiement suit le chemin normal (prélèvement puis reversement à l'hôte).
-- Les montants bloqués des recharges non facturées sont libérés par release_stale.
-- =============================================================================

alter type public.booking_status add value if not exists 'awaiting_meter';
alter type public.booking_status add value if not exists 'unbilled';

alter table public.bookings add column if not exists auto_closed_at timestamptz;

-- Expiration (tâche planifiée toutes les 5 min + à l'ouverture de « Réservations »)
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

  -- Recharge oubliée : clôture 1 h après la fin du créneau, durée facturable arrêtée à la fin du créneau
  update public.bookings
     set status = 'awaiting_meter',
         checked_out_at = greatest(checked_in_at, end_at),
         auto_closed_at = now()
   where status = 'active'
     and end_at + interval '1 hour' <= now();

  -- Pas de relevé de l'hôte sous 24 h : rien n'est facturé
  update public.bookings
     set status = 'unbilled',
         energy_kwh = 0,
         total_price = 0
   where status = 'awaiting_meter'
     and auto_closed_at + interval '24 hours' <= now();
end;
$$;

-- L'hôte déclare les kWh relevés sur son compteur
create or replace function public.declare_meter(p_booking_id uuid, p_energy_kwh numeric)
returns public.bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b     public.bookings%rowtype;
  v_power numeric;
  v_max   numeric;
  v_row   public.bookings;
begin
  if p_energy_kwh is null or p_energy_kwh < 0 then
    raise exception 'Énergie invalide' using errcode = '22023';
  end if;

  select * into v_b
    from public.bookings
   where id = p_booking_id
     and host_id = auth.uid()
   for update;
  if not found then
    raise exception 'Réservation introuvable' using errcode = 'P0001';
  end if;
  if v_b.status <> 'awaiting_meter' then
    raise exception 'Aucun relevé attendu pour cette réservation' using errcode = 'P0001';
  end if;

  select power_kw into v_power from public.spots where id = v_b.spot_id;
  v_max := v_power
         * extract(epoch from (v_b.checked_out_at - v_b.checked_in_at)) / 3600.0
         * 1.05;
  if p_energy_kwh > v_max then
    raise exception 'Relevé incohérent (max théorique : % kWh)', round(v_max, 2)
      using errcode = '22023';
  end if;

  update public.bookings
     set status      = 'completed',
         energy_kwh  = round(p_energy_kwh, 2),
         total_price = round(p_energy_kwh * v_b.price_per_kwh, 2)
   where id = v_b.id
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.declare_meter(uuid, numeric) from public, anon;
grant execute on function public.declare_meter(uuid, numeric) to authenticated;
