-- =============================================================================
-- Libération automatique des montants bloqués qui n'ont plus lieu d'être
-- (réservations non honorées, expirées, annulées ou refusées).
--
-- Toutes les 10 minutes, pg_cron appelle l'Edge Function de paiement (action
-- « release_stale ») via pg_net. L'action ne fait que libérer des blocages que la
-- base désigne déjà comme caducs : elle ne peut ni prélever ni transférer d'argent.
--
-- Après cette migration, renseigner l'adresse de la fonction :
--   update public.app_settings
--      set payments_function_url = 'https://<projet>.supabase.co/functions/v1/<adresse>';
-- =============================================================================

create extension if not exists pg_net;

alter table public.app_settings
  add column if not exists payments_function_url text
    check (payments_function_url is null or payments_function_url ~ '^https://');

do $$
begin
  if exists (select 1 from cron.job where jobname = 'wattstop-release-holds') then
    perform cron.unschedule('wattstop-release-holds');
  end if;
  perform cron.schedule(
    'wattstop-release-holds',
    '*/10 * * * *',
    $job$
      select net.http_post(
        url := s.payments_function_url,
        body := '{"action":"release_stale"}'::jsonb,
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 20000
      )
      from public.app_settings s
      where s.id and s.payments_function_url is not null
    $job$
  );
end;
$$;
