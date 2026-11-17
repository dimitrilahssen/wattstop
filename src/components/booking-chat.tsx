"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { setChatOpen } from "@/lib/live-store";
import { QUICK_REPLIES, type ChatMessage } from "@/lib/chat";

const time = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });

/**
 * Conversation conducteur ↔ hôte d'une réservation. Messages en direct (Realtime, filtré par la RLS),
 * marqués comme lus à l'ouverture. Envoi par la base (send_booking_message) : auteur et délai vérifiés.
 */
export function BookingChat({
  bookingId,
  meId,
  role,
  otherLabel,
  canWrite,
  unread: initialUnread,
  hasMessages,
}: {
  bookingId: string;
  meId: string;
  role: "driver" | "host";
  otherLabel: string;
  canWrite: boolean;
  unread: number;
  hasMessages: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [unread, setUnread] = useState(initialUnread);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setUnread(initialUnread), [initialUnread]);

  // Lien direct depuis une notification (push : #booking-<id>, notification dans l'app : ?chat=<id>)
  const params = useSearchParams();
  useEffect(() => {
    if (params.get("chat") === bookingId || window.location.hash === `#booking-${bookingId}`) setOpen(true);
  }, [bookingId, params]);

  const markRead = useCallback(async () => {
    await createClient().rpc("mark_booking_messages_read", { p_booking_id: bookingId });
    setUnread(0);
  }, [bookingId]);

  useEffect(() => {
    if (!open) return;
    setChatOpen(bookingId, true);
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("booking_messages")
        .select("id, booking_id, sender_id, body, created_at, read_at")
        .eq("booking_id", bookingId)
        .order("created_at")
        .limit(200);
      if (!cancelled) setMessages((data ?? []) as ChatMessage[]);
      await markRead();
    })();
    const channel = supabase
      .channel(`chat-${bookingId}`)
      .on<ChatMessage>(
        "postgres_changes",
        { event: "*", schema: "public", table: "booking_messages", filter: `booking_id=eq.${bookingId}` },
        (change: RealtimePostgresChangesPayload<ChatMessage>) => {
          if (change.eventType === "DELETE") return;
          const m = change.new;
          setMessages((list) => {
            const rest = (list ?? []).filter((x) => x.id !== m.id);
            return [...rest, m].sort((a, b) => a.created_at.localeCompare(b.created_at));
          });
          if (change.eventType === "INSERT" && m.sender_id !== meId) void markRead();
        }
      )
      .subscribe();
    return () => {
      cancelled = true;
      setChatOpen(bookingId, false);
      void supabase.removeChannel(channel);
    };
  }, [open, bookingId, meId, markRead]);

  // Toujours afficher le dernier message
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function send(body: string) {
    const value = body.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    const { data, error } = await createClient().rpc("send_booking_message", { p_booking_id: bookingId, p_body: value });
    setBusy(false);
    if (error) return setError(error.message);
    setText("");
    const m = data as ChatMessage;
    setMessages((list) => [...(list ?? []).filter((x) => x.id !== m.id), m]);
  }

  if (!canWrite && !hasMessages) return null;

  const lastMine = [...(messages ?? [])].reverse().find((m) => m.sender_id === meId);

  return (
    <div className="grid gap-2" data-testid="booking-chat">
      <button
        type="button"
        className="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>💬 Messages avec {otherLabel}</span>
        <span className="flex items-center gap-2">
          {unread > 0 && (
            <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-white" data-testid="chat-unread">
              {unread} non lu{unread > 1 ? "s" : ""}
            </span>
          )}
          <span className="text-subtle">{open ? "▴" : "▾"}</span>
        </span>
      </button>

      {open && (
        <div className="grid gap-2">
          <div ref={listRef} className="grid max-h-72 gap-2 overflow-y-auto rounded-lg bg-soft p-3" aria-live="polite" data-testid="chat-messages">
            {messages === null && <p className="text-sm text-subtle">Chargement…</p>}
            {messages?.length === 0 && (
              <p className="text-sm text-subtle">Aucun message. Prévenez {otherLabel} d&apos;un retard ou posez une question sur l&apos;accès.</p>
            )}
            {messages?.map((m, i) => {
              const mine = m.sender_id === meId;
              const newDay = i === 0 || day(messages[i - 1].created_at) !== day(m.created_at);
              return (
                <div key={m.id} className="grid gap-1">
                  {newDay && <p className="text-center text-xs text-subtle">{day(m.created_at)}</p>}
                  <div className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${mine ? "justify-self-end bg-accent text-white" : "justify-self-start bg-surface"}`}>
                    {m.body}
                    <span className={`ml-2 text-[11px] ${mine ? "text-white/80" : "text-subtle"}`}>{time(m.created_at)}</span>
                  </div>
                  {mine && m.id === lastMine?.id && m.read_at && <p className="justify-self-end text-[11px] text-subtle">Lu</p>}
                </div>
              );
            })}
          </div>

          {canWrite ? (
            <>
              <div className="flex flex-wrap gap-2">
                {QUICK_REPLIES[role].map((q) => (
                  <button key={q} type="button" disabled={busy} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:border-accent/50" onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send(text);
                }}
              >
                <textarea
                  className="input min-h-0 flex-1 resize-none py-2"
                  rows={1}
                  maxLength={1000}
                  placeholder="Votre message"
                  aria-label="Votre message"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send(text);
                    }
                  }}
                />
                <button className="btn-primary px-4 py-2" disabled={busy || !text.trim()}>
                  Envoyer
                </button>
              </form>
            </>
          ) : (
            <p className="text-xs text-subtle">Conversation terminée (24 h après la fin de la réservation).</p>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}
