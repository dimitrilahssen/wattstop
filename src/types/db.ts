// Types métier manuels. Pour des types exhaustifs : `npm run db:types` (Supabase CLI).

export type UserRole = "driver" | "host" | "both";
export type ConnectorType = "type2" | "type2_cable" | "domestic_socket" | "ccs" | "chademo";
export type BookingStatus =
  | "pending"
  | "confirmed"
  | "active"
  | "completed"
  | "cancelled"
  | "rejected"
  /** Demande restée sans réponse au début du créneau (tâche planifiée expire_bookings) */
  | "expired"
  /** Réservation confirmée, créneau terminé sans démarrage de recharge */
  | "no_show"
  /** Recharge oubliée (pas de scan de fin) : clôturée 1 h après le créneau, l'hôte doit déclarer les kWh */
  | "awaiting_meter"
  /** Recharge oubliée sans relevé de l'hôte sous 24 h : rien n'est facturé */
  | "unbilled";

export interface Profile {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  role: UserRole;
  vehicle_model: string | null;
}

/** Colonnes lisibles de `spots` (qr_key est volontairement exclue côté base). */
export const SPOT_COLUMNS =
  "id, host_id, title, description, address, connector_type, power_kw, price_per_kwh, access_instructions, photos, is_active, created_at";

export interface Spot {
  id: string;
  host_id: string;
  title: string;
  description: string | null;
  address: string;
  connector_type: ConnectorType;
  power_kw: number;
  price_per_kwh: number;
  access_instructions: string | null;
  photos: string[];
  is_active: boolean;
  created_at: string;
}

export interface NearbySpot {
  id: string;
  title: string;
  address: string;
  connector_type: ConnectorType;
  power_kw: number;
  price_per_kwh: number;
  lat: number;
  lng: number;
  distance_m: number;
}

export interface Booking {
  id: string;
  spot_id: string;
  driver_id: string;
  host_id: string;
  start_at: string;
  end_at: string;
  status: BookingStatus;
  price_per_kwh: number;
  checked_in_at: string | null;
  checked_out_at: string | null;
  /** Clôture automatique d'une recharge oubliée */
  auto_closed_at?: string | null;
  energy_kwh: number | null;
  total_price: number | null;
  driver_note: string | null;
  created_at: string;
}

export interface ResolvedQr {
  spot: Pick<Spot, "id" | "title" | "address" | "connector_type" | "power_kw" | "price_per_kwh" | "access_instructions" | "is_active">;
  is_host: boolean;
  booking: Pick<Booking, "id" | "status" | "start_at" | "end_at" | "checked_in_at"> | null;
}
