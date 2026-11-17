-- =============================================================================
-- Messagerie conducteur ↔ hôte, attachée à chaque réservation
--   * booking_messages : lisibles uniquement par le conducteur et l'hôte de la réservation.
--   * Envoi uniquement via send_booking_message : auteur posé par la base, conversation ouverte
--     tant que la réservation est en cours, puis 24 h après sa fin ; 10 messages par minute au plus.
--   * mark_booking_messages_read : marque comme lus les messages reçus d'une conversation.
--   * Temps réel (Supabase Realtime) et notification push au destinataire (pg_net → fonction,
--     action notify_message ; contenu relu en base, une seule notification par message).
-- Prérequis : 20261117000000 (push_log, payments_function_url). Rejouable sans erreur.
-- =============================================================================

create table if not exists public.booking_messages (
  id          uuid primary key default gen_random_uuid(),
  booking_id  uuid not null references public.bookings (id) on delete cascade,
  sender_id   uuid not null references public.profiles (id) on delete cascade,
  body        text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index if not exists booking_messages_booking_idx on public.booking_messages (booking_id, created_at);
create index if not exists booking_messages_unread_idx on public.booking_messages (booking_id) where read_at is null;

alter table public.booking_messages enable row level security;
drop policy if exists "booking_messages_select_participants" on public.booking_messages;
create policy "booking_messages_select_participants" on public.booking_messages for select to authenticated
  using (exists (select 1 from public.bookings b
                  where b.id = booking_messages.booking_id
                    and (select auth.uid()) in (b.driver_id, b.host_id)));
revoke all on public.booking_messages from anon, authenticated;
grant select on public.booking_messages to authenticated;

-- La conversation est-elle ouverte ? (réservation en cours, ou terminée / annulée depuis moins de 24 h)
create or replace function public.booking_chat_open(p_booking public.bookings)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
           when p_booking.status in ('pending', 'confirmed', 'active', 'awaiting_meter') then true
           when p_booking.status = 'completed' then coalesce(p_booking.checked_out_at, p_booking.end_at) > now() - interval '24 hours'
           else p_booking.updated_at > now() - interval '24 hours' -- annulée, refusée, expirée… : 24 h pour se dire un dernier mot
         end;
$$;

create or replace function public.send_booking_message(p_booking_id uuid, p_body text)
returns public.booking_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_booking public.bookings;
  v_body    text := btrim(coalesce(p_body, ''));
  v_row     public.booking_messages;
begin
  if v_uid is null then
    raise exception 'Authentification requise' using errcode = '42501';
  end if;
  select * into v_booking from public.bookings where id = p_booking_id and v_uid in (driver_id, host_id);
  if v_booking.id is null then
    raise exception 'Réservation introuvable' using errcode = 'P0002';
  end if;
  if not public.booking_chat_open(v_booking) then
    raise exception 'Conversation terminée (24 h après la fin de la réservation)' using errcode = 'P0001';
  end if;
  if char_length(v_body) = 0 then
    raise exception 'Message vide' using errcode = '22023';
  end if;
  if char_length(v_body) > 1000 then
    raise exception 'Message trop long (1000 caractères au plus)' using errcode = '22023';
  end if;
  if (select count(*) from public.booking_messages m
       where m.sender_id = v_uid and m.created_at > now() - interval '1 minute') >= 10 then
    raise exception 'Trop de messages d''affilée : patientez une minute' using errcode = 'P0001';
  end if;

  insert into public.booking_messages (booking_id, sender_id, body)
  values (p_booking_id, v_uid, v_body)
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.mark_booking_messages_read(p_booking_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.booking_messages m
     set read_at = now()
    from public.bookings b
   where m.booking_id = p_booking_id
     and b.id = m.booking_id
     and auth.uid() in (b.driver_id, b.host_id)
     and m.sender_id <> auth.uid()
     and m.read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Notification push au destinataire (sans jamais bloquer l'envoi)
create or replace function public.booking_messages_notify()
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
      body := jsonb_build_object('action', 'notify_message', 'message_id', new.id),
      headers := '{"Content-Type":"application/json"}'::jsonb,
      timeout_milliseconds := 10000
    );
  end if;
  return new;
exception when others then
  raise warning 'booking_messages_notify: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists booking_messages_push on public.booking_messages;
create trigger booking_messages_push
  after insert on public.booking_messages
  for each row execute function public.booking_messages_notify();

-- Anti-doublon des notifications : push_log accepte aussi les événements « msg:<id> »
-- (la clé (booking_id, event) existe déjà, rien à changer)

revoke execute on function
  public.booking_chat_open(public.bookings),
  public.send_booking_message(uuid, text),
  public.mark_booking_messages_read(uuid),
  public.booking_messages_notify()
from public, anon, authenticated;
grant execute on function
  public.booking_chat_open(public.bookings),
  public.send_booking_message(uuid, text),
  public.mark_booking_messages_read(uuid)
to authenticated;

-- Temps réel : les messages arrivent en direct (la RLS filtre ce que chacun reçoit)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'booking_messages') then
    alter publication supabase_realtime add table public.booking_messages;
  end if;
end;
$$;
