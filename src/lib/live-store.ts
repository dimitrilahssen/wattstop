// Petit store partagé (sans dépendance) pour les notifications temps réel :
// file de toasts, compteur d'événements non vus (pastille de l'onglet Résas)
// et actions faites dans cet onglet (pour ne pas notifier l'utilisateur de ses propres clics).

export type Toast = { id: number; title: string; body?: string; href?: string };

type State = { toasts: Toast[]; unseen: number };

let state: State = { toasts: [], unseen: 0 };
const listeners = new Set<() => void>();
const selfActions = new Map<string, number>();
let nextId = 1;

function emit(next: State) {
  state = next;
  listeners.forEach((l) => l());
}

export const liveStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot: () => state,
  getServerSnapshot: () => state,

  push(toast: Omit<Toast, "id">, countAsUnseen: boolean) {
    const t = { ...toast, id: nextId++ };
    emit({ toasts: [...state.toasts, t].slice(-3), unseen: state.unseen + (countAsUnseen ? 1 : 0) });
    setTimeout(() => liveStore.dismiss(t.id), 8000);
  },
  dismiss(id: number) {
    if (state.toasts.some((t) => t.id === id)) emit({ ...state, toasts: state.toasts.filter((t) => t.id !== id) });
  },
  markSeen() {
    if (state.unseen) emit({ ...state, unseen: 0 });
  },
};

/**
 * À appeler juste avant une action de l'utilisateur sur une réservation, avec le statut qu'elle va produire.
 * On marque le couple (réservation, statut) : un autre changement sur la même réservation reste notifié.
 */
export function markSelfAction(bookingId: string, status: string) {
  selfActions.set(`${bookingId}:${status}`, Date.now());
}

/** Vrai si ce changement de statut vient d'une action faite dans cet onglet il y a moins de 15 s. */
export function isSelfAction(bookingId: string, status: string) {
  const at = selfActions.get(`${bookingId}:${status}`);
  return at !== undefined && Date.now() - at < 15_000;
}
