-- =============================================================================
-- Avis et notes après chaque recharge
--   * Après une recharge terminée (statut completed), le conducteur note l'hôte et l'hôte
--     note le conducteur : 1 à 5 étoiles + commentaire facultatif, une fois chacun, sous 14 jours.
--   * Publication en double aveugle : un avis reste visible de son seul auteur jusqu'à ce que
--     l'autre partie ait aussi noté, ou jusqu'à la fin des 14 jours. Personne ne note
--     « en réaction » à l'avis reçu.
--   * Écriture uniquement via submit_review (auteur, cible, rôle et spot posés par la base).
--   * Moyennes : profile_ratings (par personne, comme hôte et comme conducteur),
--     spot_ratings (par spot, avis des conducteurs), spot_reviews (derniers avis d'un spot).
-- Rejouable sans erreur.
-- =============================================================================

create table if not exists public.reviews (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references public.bookings (id) on delete cascade,
  spot_id      uuid not null references public.spots (id) on delete cascade,
  author_id    uuid not null references public.profiles (id) on delete cascade,
  target_id    uuid not null references public.profiles (id) on delete cascade,
  author_role  text not null check (author_role in ('driver', 'host')),
  rating       smallint not null check (rating between 1 and 5),
  comment      text check (char_length(comment) <= 500),
  created_at   timestamptz not null default now(),
  constraint reviews_one_per_author unique (booking_id, author_id),
  constraint reviews_not_self check (author_id <> target_id)
);
create index if not exists reviews_target_idx on public.reviews (target_id, created_at desc);
create index if not exists reviews_spot_idx on public.reviews (spot_id, created_at desc);

-- Fenêtre pour noter : 14 jours après la fin de la recharge
create or replace function public.review_deadline(p_booking public.bookings)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_booking.checked_out_at, p_booking.end_at) + interval '14 days';
$$;

-- Les avis d'une réservation sont-ils publics ? (les deux parties ont noté, ou délai écoulé)
create or replace function public.reviews_published(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*) from public.reviews r where r.booking_id = p_booking_id) >= 2
      or exists (select 1 from public.bookings b
                  where b.id = p_booking_id and public.review_deadline(b) < now());
$$;

alter table public.reviews enable row level security;
drop policy if exists "reviews_select_own_or_published" on public.reviews;
create policy "reviews_select_own_or_published" on public.reviews for select to anon, authenticated
  using (author_id = (select auth.uid()) or public.reviews_published(booking_id));
revoke all on public.reviews from anon, authenticated;
grant select on public.reviews to anon, authenticated;

-- Laisser un avis (conducteur → hôte, ou hôte → conducteur)
create or replace function public.submit_review(p_booking_id uuid, p_rating integer, p_comment text default null)
returns public.reviews
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_booking public.bookings;
  v_row     public.reviews;
  v_comment text := nullif(btrim(p_comment), '');
begin
  if v_uid is null then
    raise exception 'Authentification requise' using errcode = '42501';
  end if;

  select * into v_booking from public.bookings where id = p_booking_id and v_uid in (driver_id, host_id);
  if v_booking.id is null then
    raise exception 'Réservation introuvable' using errcode = 'P0002';
  end if;
  if v_booking.status <> 'completed' then
    raise exception 'Vous pourrez noter une fois la recharge terminée' using errcode = 'P0001';
  end if;
  if public.review_deadline(v_booking) < now() then
    raise exception 'Le délai de 14 jours pour noter est dépassé' using errcode = 'P0001';
  end if;
  if p_rating is null or p_rating not between 1 and 5 then
    raise exception 'La note doit être comprise entre 1 et 5' using errcode = '22023';
  end if;
  if char_length(v_comment) > 500 then
    raise exception 'Commentaire trop long (500 caractères au plus)' using errcode = '22023';
  end if;

  insert into public.reviews (booking_id, spot_id, author_id, target_id, author_role, rating, comment)
  values (
    v_booking.id,
    v_booking.spot_id,
    v_uid,
    case when v_uid = v_booking.driver_id then v_booking.host_id else v_booking.driver_id end,
    case when v_uid = v_booking.driver_id then 'driver' else 'host' end,
    p_rating,
    v_comment
  )
  returning * into v_row;
  return v_row;
exception when unique_violation then
  raise exception 'Vous avez déjà noté cette recharge' using errcode = 'P0001';
end;
$$;

-- Moyennes publiques par personne : comme hôte (notes des conducteurs) et comme conducteur
create or replace function public.profile_ratings(p_ids uuid[])
returns table (user_id uuid, host_avg numeric, host_count integer, driver_avg numeric, driver_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select r.target_id,
         round(avg(r.rating) filter (where r.author_role = 'driver'), 1),
         (count(*) filter (where r.author_role = 'driver'))::integer,
         round(avg(r.rating) filter (where r.author_role = 'host'), 1),
         (count(*) filter (where r.author_role = 'host'))::integer
    from public.reviews r
   where r.target_id = any (p_ids[1:500])
     and public.reviews_published(r.booking_id)
   group by r.target_id;
$$;

-- Moyenne publique par spot (avis laissés par les conducteurs)
create or replace function public.spot_ratings(p_ids uuid[])
returns table (spot_id uuid, avg_rating numeric, review_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select r.spot_id, round(avg(r.rating), 1), count(*)::integer
    from public.reviews r
   where r.spot_id = any (p_ids[1:500])
     and r.author_role = 'driver'
     and public.reviews_published(r.booking_id)
   group by r.spot_id;
$$;

-- Derniers avis publics d'un spot, avec le seul prénom de l'auteur
create or replace function public.spot_reviews(p_spot_id uuid, p_limit integer default 10)
returns table (id uuid, rating smallint, comment text, created_at timestamptz, author_first_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.rating, r.comment, r.created_at,
         nullif(split_part(btrim(coalesce(p.full_name, '')), ' ', 1), '')
    from public.reviews r
    join public.spots s on s.id = r.spot_id
    left join public.profiles p on p.id = r.author_id
   where r.spot_id = p_spot_id
     and r.author_role = 'driver'
     and (s.is_active or s.host_id = auth.uid())
     and public.reviews_published(r.booking_id)
   order by r.created_at desc
   limit least(greatest(p_limit, 1), 50);
$$;

revoke execute on function
  public.review_deadline(public.bookings),
  public.reviews_published(uuid),
  public.submit_review(uuid, integer, text),
  public.profile_ratings(uuid[]),
  public.spot_ratings(uuid[]),
  public.spot_reviews(uuid, integer)
from public, anon, authenticated;

-- reviews_published est appelée par la règle de lecture : elle doit rester exécutable
grant execute on function public.reviews_published(uuid) to anon, authenticated;
grant execute on function public.submit_review(uuid, integer, text) to authenticated;
grant execute on function
  public.profile_ratings(uuid[]),
  public.spot_ratings(uuid[]),
  public.spot_reviews(uuid, integer)
to anon, authenticated;
