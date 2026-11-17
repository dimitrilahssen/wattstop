// Horaires de disponibilité : même logique que la base (public.spot_slot_problem),
// pour guider le conducteur avant l'envoi. La base reste seule juge.
// Les heures sont lues dans le fuseau du navigateur (celui du spot : Europe/Paris).

/** weekday : 1 = lundi … 7 = dimanche. closes <= opens : se termine le lendemain ; opens = closes : 24 h. */
export type SpotHour = { weekday: number; opens: string; closes: string };
export type SpotClosure = { id?: string; starts_on: string; ends_on: string; reason?: string | null };
export type BusySlot = { start_at: string; end_at: string };
export type SlotProblem = "order" | "too_long" | "past" | "closed" | "hours" | "busy";

export const DAY_SHORT = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
export const DAY_LONG = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
export const PROBLEM_LABELS: Record<SlotProblem, string> = {
  order: "La fin doit être après le début.",
  too_long: "Un créneau dure 12 h au plus.",
  past: "Le créneau doit commencer dans le futur.",
  closed: "Le spot est fermé à ces dates.",
  hours: "En dehors des horaires de disponibilité du spot.",
  busy: "Ce créneau chevauche une réservation existante.",
};

const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
const STEP = 15 * MIN;
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const hhmm = (t: string) => t.slice(0, 5);
const isoDay = (d: Date) => d.getDay() || 7;
const localDate = (ymd: string) => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
};

type Range = [number, number];

function merge(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** Plages ouvertes entre from et to (la veille comprise, pour les plages de nuit), fusionnées. */
function openRanges(hours: SpotHour[], from: number, to: number): Range[] {
  if (hours.length === 0) return [[-Infinity, Infinity]];
  const out: Range[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - 1);
  for (; d.getTime() <= to; d.setDate(d.getDate() + 1)) {
    for (const h of hours) {
      if (h.weekday !== isoDay(d)) continue;
      const o = toMin(h.opens), c = toMin(h.closes);
      const s = new Date(d);
      s.setHours(0, o, 0, 0);
      const e = new Date(d);
      if (c <= o) e.setDate(e.getDate() + 1);
      e.setHours(0, c, 0, 0);
      out.push([s.getTime(), e.getTime()]);
    }
  }
  return merge(out);
}

function closureRanges(closures: SpotClosure[]): Range[] {
  return closures.map((c) => {
    const end = localDate(c.ends_on);
    end.setDate(end.getDate() + 1);
    return [localDate(c.starts_on).getTime(), end.getTime()];
  });
}

/** Contexte précalculé pour tester rapidement beaucoup de créneaux. */
export function availabilityChecker(hours: SpotHour[], closures: SpotClosure[], busy: BusySlot[], horizonDays = 15) {
  const now = Date.now();
  const open = openRanges(hours, now - DAY_MS, now + horizonDays * DAY_MS);
  const closed = closureRanges(closures);
  const taken: Range[] = busy.map((b) => [new Date(b.start_at).getTime(), new Date(b.end_at).getTime()]);
  const overlaps = (rs: Range[], a: number, b: number) => rs.some(([s, e]) => a < e && s < b);

  function problem(from: number, to: number): SlotProblem | null {
    if (!(to > from)) return "order";
    if (to - from > 12 * 60 * MIN) return "too_long";
    if (from < Date.now() - 5 * MIN) return "past";
    if (overlaps(closed, from, to)) return "closed";
    const ranges = from < now - DAY_MS || to > now + horizonDays * DAY_MS ? openRanges(hours, from, to) : open;
    if (!ranges.some(([s, e]) => s <= from && to <= e)) return "hours";
    if (overlaps(taken, from, to)) return "busy";
    return null;
  }

  /** Premier créneau libre à partir de `after`, d'une durée visée de `wantMs` (au moins 15 min). */
  function nextSlot(after: number, wantMs = 2 * 60 * MIN): { start: Date; end: Date } | null {
    let t = Math.ceil(after / STEP) * STEP;
    const limit = now + 14 * DAY_MS;
    for (; t < limit; t += STEP) {
      if (problem(t, t + STEP)) continue;
      let end = t + STEP;
      while (end - t < wantMs && !problem(t, end + STEP)) end += STEP;
      return { start: new Date(t), end: new Date(end) };
    }
    return null;
  }

  return { problem, nextSlot };
}

function dayLabel(ranges: SpotHour[]): string {
  if (ranges.length === 0) return "Fermé";
  return [...ranges]
    .sort((a, b) => toMin(a.opens) - toMin(b.opens))
    .map((h) => {
      const o = toMin(h.opens), c = toMin(h.closes);
      if (o === c) return o === 0 ? "Toute la journée" : `${hhmm(h.opens)} → ${hhmm(h.closes)} le lendemain`;
      return c < o && c !== 0 ? `${hhmm(h.opens)} → ${hhmm(h.closes)} le lendemain` : `${hhmm(h.opens)} → ${c === 0 ? "minuit" : hhmm(h.closes)}`;
    })
    .join(", ");
}

/** Résumé lisible : [{ days: "Lun – Ven", label: "18:00 → 08:00 le lendemain" }, …]. Vide = toujours disponible. */
export function weekSummary(hours: SpotHour[]): { days: string; label: string }[] {
  if (hours.length === 0) return [];
  const labels = DAY_SHORT.map((_, i) => dayLabel(hours.filter((h) => h.weekday === i + 1)));
  const out: { days: string; label: string }[] = [];
  let i = 0;
  while (i < 7) {
    let j = i;
    while (j + 1 < 7 && labels[j + 1] === labels[i]) j++;
    out.push({ days: i === j ? DAY_SHORT[i] : `${DAY_SHORT[i]} – ${DAY_SHORT[j]}`, label: labels[i] });
    i = j + 1;
  }
  return out;
}

export function formatClosure(c: SpotClosure): string {
  const f = (ymd: string) => localDate(ymd).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  return c.starts_on === c.ends_on ? `Le ${f(c.starts_on)}` : `Du ${f(c.starts_on)} au ${f(c.ends_on)}`;
}

export function formatSlot(start: Date, end: Date): string {
  const day = (d: Date) => d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  const time = (d: Date) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return day(start) === day(end) ? `${day(start)}, ${time(start)} → ${time(end)}` : `${day(start)} ${time(start)} → ${day(end)} ${time(end)}`;
}
