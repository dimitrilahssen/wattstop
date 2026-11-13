-- =============================================================================
-- Un conducteur garde la vue sur les spots qu'il a réservés, même désactivés.
-- Sans cette règle, quand un hôte retire son spot, l'historique du conducteur
-- (page Réservations) perd le titre et l'adresse du spot.
-- Les colonnes lisibles restent limitées par les GRANT : qr_key reste secrète.
-- =============================================================================
create policy "spots_select_booked_by_driver"
  on public.spots for select
  to authenticated
  using (
    exists (
      select 1
        from public.bookings b
       where b.spot_id = spots.id
         and b.driver_id = (select auth.uid())
    )
  );
