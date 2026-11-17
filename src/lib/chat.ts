// Messagerie : même règle d'ouverture que la base (public.booking_chat_open).
import type { Booking } from "@/types/db";

export type ChatMessage = { id: string; booking_id: string; sender_id: string; body: string; created_at: string; read_at: string | null };

const OPEN = ["pending", "confirmed", "active", "awaiting_meter"];
const DAY = 24 * 3_600_000;

export function chatOpen(b: Pick<Booking, "status" | "end_at" | "checked_out_at"> & { updated_at?: string }, now = Date.now()) {
  if (OPEN.includes(b.status)) return true;
  if (b.status === "completed") return new Date(b.checked_out_at ?? b.end_at).getTime() > now - DAY;
  return !!b.updated_at && new Date(b.updated_at).getTime() > now - DAY;
}

export const QUICK_REPLIES = {
  driver: ["J'arrive dans 10 min", "Je suis devant", "Petit retard, j'arrive", "Merci !"],
  host: ["Je vous ouvre", "Le câble est dans le coffret", "Pas de souci", "Merci !"],
};
