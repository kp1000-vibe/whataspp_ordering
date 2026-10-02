/**
 * PICKUP SLOT + CAPACITY ENGINE — the core differentiator (spec sections 8-10, 28).
 *
 * The rule this file exists to enforce: an ETA is a PROMISE, and a promise the
 * kitchen cannot keep is worse than a slower honest one. So we never say
 * "20 minutes because biryani takes 20 minutes". We allocate the order into a
 * real pickup slot that still has room, given:
 *
 *   - how many orders are already promised in that slot
 *   - the location's live capacity state (OPEN/BUSY/VERY_BUSY/PAUSED/CLOSED)
 *   - any manual ETA padding a manager has clicked on (+15 / +30)
 *   - the longest item prep time in THIS order
 *   - the minimum lead time and the closing time
 *
 * If no slot has room before closing, we say so rather than inventing one.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { locations, restaurantSettings, businessHours, holidayHours } from '../../db/schema';
import { menuItems } from '../../db/schema';
import { inArray } from 'drizzle-orm';
import { localParts, minutesToClock, addMinutes, whenLabel } from '../../lib/time';
import { openState } from '../prep/engine';
import { now as clockNow } from '../../lib/clock';
import type { TenantScope } from '../tenancy';

export type CapacityState = 'OPEN' | 'BUSY' | 'VERY_BUSY' | 'PAUSED' | 'CLOSED';

export type LocationCapacity = {
  locationId: string;
  state: CapacityState;
  etaOffsetMinutes: number;
  slotMinutes: number;
  maxOrdersPerSlot: number;
  minLeadMinutes: number;
  maxAdvanceMinutes: number;
  busyEtaPaddingMinutes: number;
  note: string;
  timezone: string;
};

export type Slot = {
  /** Absolute start of the slot. */
  start: Date;
  end: Date;
  /** Local clock label of the PROMISED time (slot end), e.g. "7:45 PM". */
  label: string;
  /** Same, with a day when it isn't today: "tomorrow at 11:30 AM". */
  when: string;
  /** Range label, e.g. "7:45-8:00 PM". */
  rangeLabel: string;
  booked: number;
  capacity: number;
  available: boolean;
  /** Why it is not available, when it is not. */
  blockedReason?: 'FULL' | 'TOO_SOON' | 'PAST' | 'CLOSED' | 'BEYOND_HORIZON';
};

export type SlotAllocation =
  | {
      ok: true;
      slot: Slot;
      promisedReadyAt: Date;
      prepMinutes: number;
      /** Exactly what the AI may say. Never a bare number the kitchen didn't agree to. */
      text: string;
      capacityState: CapacityState;
    }
  | {
      ok: false;
      reason: 'PAUSED' | 'CLOSED' | 'NO_SLOTS' | 'BEYOND_HORIZON';
      /** Customer-safe sentence. */
      text: string;
      /** Alternatives we CAN offer, if any. */
      alternatives: Slot[];
      capacityState: CapacityState;
    };

export async function getCapacity(scope: TenantScope, locationId: string): Promise<LocationCapacity> {
  const db = await getDb();
  const [loc] = await db.drizzle.select().from(locations).where(and(
    eq(locations.restaurantId, scope.restaurantId), eq(locations.id, locationId))).limit(1);
  if (!loc) { const { NotFoundError } = await import('../errors'); throw new NotFoundError('Location not found.'); }

  const effectiveMax = loc.capacityState === 'VERY_BUSY' ? loc.maxOrdersPerSlotBusy : loc.maxOrdersPerSlot;

  return {
    locationId: loc.id,
    state: loc.capacityState as CapacityState,
    etaOffsetMinutes: loc.etaOffsetMinutes,
    slotMinutes: Math.max(5, loc.slotMinutes),
    maxOrdersPerSlot: Math.max(1, effectiveMax),
    minLeadMinutes: loc.minLeadMinutes,
    maxAdvanceMinutes: loc.maxAdvanceMinutes,
    busyEtaPaddingMinutes: loc.busyEtaPaddingMinutes,
    note: loc.capacityNote,
    timezone: loc.timezone,
  };
}

export async function setCapacityState(
  scope: TenantScope, locationId: string,
  args: { state?: CapacityState; etaOffsetMinutes?: number; note?: string },
): Promise<LocationCapacity> {
  const db = await getDb();
  const patch: Record<string, unknown> = { capacityChangedAt: new Date(), updatedAt: new Date() };
  if (args.state) patch.capacityState = args.state;
  if (args.etaOffsetMinutes != null) patch.etaOffsetMinutes = Math.max(0, Math.min(180, args.etaOffsetMinutes));
  if (args.note != null) patch.capacityNote = args.note;

  await db.drizzle.update(locations).set(patch).where(and(
    eq(locations.restaurantId, scope.restaurantId), eq(locations.id, locationId)));

  return getCapacity(scope, locationId);
}

/** Snaps a time down to the start of its slot. */
export function slotStartFor(at: Date, slotMinutes: number): Date {
  const ms = slotMinutes * 60_000;
  return new Date(Math.floor(at.getTime() / ms) * ms);
}

/** How many orders are already promised into each slot for this location. */
async function bookingsBySlot(
  scope: TenantScope, locationId: string, from: Date, to: Date,
): Promise<Map<number, number>> {
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT pickup_slot_start, count(*)::int AS n
     FROM orders
     WHERE restaurant_id = $1 AND location_id = $2
       AND pickup_slot_start >= $3 AND pickup_slot_start < $4
       AND status IN ('CONFIRMED','RECEIVED','ACCEPTED','PREPARING','READY')
     GROUP BY pickup_slot_start;`,
    [scope.restaurantId, locationId, from.toISOString(), to.toISOString()],
  );
  const map = new Map<number, number>();
  for (const r of rows as any[]) {
    if (r.pickup_slot_start) map.set(new Date(r.pickup_slot_start).getTime(), Number(r.n));
  }
  return map;
}

/** Longest single-item prep time in this order; a kitchen cooks in parallel. */
async function itemPrepMinutes(scope: TenantScope, menuItemIds: string[]): Promise<number> {
  if (menuItemIds.length === 0) return 0;
  const db = await getDb();
  const items = await db.drizzle.select().from(menuItems).where(and(
    eq(menuItems.restaurantId, scope.restaurantId), inArray(menuItems.id, menuItemIds)));
  return items.reduce((max: number, i: any) => Math.max(max, i.prepMinutes || 0), 0);
}

export type SlotQuery = {
  locationId: string;
  menuItemIds: string[];
  /** Customer asked for a specific time ("around 8"), as an absolute Date. */
  requestedAt?: Date | null;
  at?: Date;
  /** How many slots of alternatives to return. */
  alternatives?: number;
};

/* ─────────────── opening hours, per slot ─────────────── */

type HoursIndex = {
  /** Is the whole slot [start, end) inside opening hours on its own local day? */
  slotOpen: (start: Date, end: Date) => boolean;
  /** The next instant at or after `from` when the kitchen is open. */
  nextOpening: (from: Date) => Date | null;
  /** Today's closing minute-of-day, or null if closed today. */
  closeMinuteOn: (at: Date) => number | null;
};

async function hoursIndex(scope: TenantScope, locationId: string, tz: string): Promise<HoursIndex> {
  const db = await getDb();
  const hours = await db.drizzle.select().from(businessHours).where(eq(businessHours.restaurantId, scope.restaurantId));
  const holidays = await db.drizzle.select().from(holidayHours).where(eq(holidayHours.restaurantId, scope.restaurantId));
  const forLoc = hours.filter((h: any) => h.locationId === locationId);
  const pool = forLoc.length ? forLoc : hours.filter((h: any) => h.locationId === null);
  const holidayBy = new Map<string, any>(holidays.map((h: any) => [h.date, h]));

  /** [open, close] minute window for a local date, or null if closed all day. */
  const windowFor = (at: Date): [number, number] | null => {
    const lp = localParts(at, tz);
    const hol = holidayBy.get(lp.dateKey);
    if (hol) return hol.isClosed || hol.openMinute == null ? null : [hol.openMinute, hol.closeMinute];
    const day = pool.find((h: any) => h.dayOfWeek === lp.dayOfWeek);
    return !day || day.isClosed ? null : [day.openMinute, day.closeMinute];
  };

  return {
    slotOpen(start, end) {
      const s = localParts(start, tz);
      const e = localParts(end, tz);
      if (s.dateKey !== e.dateKey && e.minuteOfDay !== 0) return false;  // slots never span midnight
      const w = windowFor(start);
      if (!w) return false;
      const endMinute = e.minuteOfDay === 0 && s.dateKey !== e.dateKey ? 1440 : e.minuteOfDay;
      return s.minuteOfDay >= w[0] && endMinute <= w[1];
    },
    nextOpening(from) {
      for (let d = 0; d <= 8; d++) {
        const day = new Date(from.getTime() + d * 86_400_000);
        const w = windowFor(day);
        if (!w) continue;
        const m = localParts(day, tz).minuteOfDay;
        if (d === 0) {
          if (m >= w[0] && m < w[1]) return from;
          if (m < w[0]) return new Date(from.getTime() + (w[0] - m) * 60_000);
          continue;
        }
        return new Date(day.getTime() + (w[0] - m) * 60_000);
      }
      return null;
    },
    closeMinuteOn(at) {
      return windowFor(at)?.[1] ?? null;
    },
  };
}

/* ─────────────── slots ─────────────── */

type SlotPlan = {
  slots: Slot[];                 // every generated slot, including CLOSED ones
  capacity: LocationCapacity;
  earliestReadyAt: Date;
  horizonEnd: Date;
  prepMinutes: number;
  kitchenOpenNow: boolean;
  allowScheduled: boolean;
  hours: HoursIndex;
  now: Date;
};

async function plan(scope: TenantScope, q: SlotQuery, kitchenStartOverride?: Date): Promise<SlotPlan> {
  const now = q.at ?? clockNow();
  const cap = await getCapacity(scope, q.locationId);
  const db = await getDb();
  const [settings] = await db.drizzle.select().from(restaurantSettings)
    .where(eq(restaurantSettings.restaurantId, scope.restaurantId)).limit(1);

  const basePrep = Math.max(settings?.defaultPrepMinutes ?? 20, await itemPrepMinutes(scope, q.menuItemIds));
  const busyPad = cap.state === 'BUSY' || cap.state === 'VERY_BUSY' ? cap.busyEtaPaddingMinutes : 0;
  const prepMinutes = basePrep + busyPad + cap.etaOffsetMinutes;
  const allowScheduled = !!settings?.allowScheduledOrders;

  const hours = await hoursIndex(scope, q.locationId, cap.timezone);
  const openNow = hours.nextOpening(now)?.getTime() === now.getTime();

  // The kitchen cannot start cooking before it opens.
  const kitchenStart = kitchenStartOverride ?? (openNow ? now : (hours.nextOpening(now) ?? now));
  const earliestReadyAt = addMinutes(kitchenStart, Math.max(prepMinutes, cap.minLeadMinutes));
  let horizonEnd = addMinutes(kitchenStart, cap.maxAdvanceMinutes);

  // Without scheduled orders nothing may be promised after tonight's close.
  if (!allowScheduled) {
    const close = hours.closeMinuteOn(now);
    if (close != null) {
      const lp = localParts(now, cap.timezone);
      const closeAt = addMinutes(now, close - lp.minuteOfDay);
      if (closeAt < horizonEnd) horizonEnd = closeAt;
    }
  }

  const slotMs = cap.slotMinutes * 60_000;
  const firstStart = slotStartFor(earliestReadyAt, cap.slotMinutes);
  const bookings = await bookingsBySlot(scope, q.locationId, firstStart, addMinutes(horizonEnd, cap.slotMinutes * 2));

  const slots: Slot[] = [];
  for (let t = firstStart.getTime(); t < horizonEnd.getTime() + slotMs; t += slotMs) {
    const start = new Date(t);
    const end = new Date(t + slotMs);
    if (end > addMinutes(horizonEnd, cap.slotMinutes)) break;
    const booked = bookings.get(t) ?? 0;

    let blockedReason: Slot['blockedReason'];
    if (end < earliestReadyAt) blockedReason = 'TOO_SOON';
    else if (!hours.slotOpen(start, end)) blockedReason = 'CLOSED';
    else if (end > horizonEnd) blockedReason = 'BEYOND_HORIZON';
    else if (booked >= cap.maxOrdersPerSlot) blockedReason = 'FULL';

    slots.push(makeSlot(start, end, booked, cap, now, blockedReason));
  }

  return { slots, capacity: cap, earliestReadyAt, horizonEnd, prepMinutes, kitchenOpenNow: openNow, allowScheduled, hours, now };
}

function makeSlot(start: Date, end: Date, booked: number, cap: LocationCapacity, now: Date, blockedReason?: Slot['blockedReason']): Slot {
  const s = localParts(start, cap.timezone);
  const e = localParts(end, cap.timezone);
  return {
    start, end,
    // The label IS the promise: food is ready by the END of the slot, and that
    // single time is what the customer sees before AND after confirming.
    label: minutesToClock(e.minuteOfDay),
    when: whenLabel(end, now, cap.timezone),
    rangeLabel: `${minutesToClock(s.minuteOfDay)}-${minutesToClock(e.minuteOfDay)}`,
    booked, capacity: cap.maxOrdersPerSlot,
    available: !blockedReason,
    blockedReason,
  };
}

/**
 * Pickup slots for display: open slots from the earliest possible pickup up to
 * the booking horizon. Closed periods are omitted.
 */
export async function listSlots(scope: TenantScope, q: SlotQuery): Promise<{
  slots: Slot[]; capacity: LocationCapacity; earliestReadyAt: Date; prepMinutes: number;
}> {
  const p = await plan(scope, q);
  return {
    slots: p.slots.filter((s) => s.blockedReason !== 'CLOSED' && s.blockedReason !== 'BEYOND_HORIZON'),
    capacity: p.capacity, earliestReadyAt: p.earliestReadyAt, prepMinutes: p.prepMinutes,
  };
}

/** The earliest pickup the engine would promise right now (used for "how long?"). */
export async function earliestPickup(scope: TenantScope, q: SlotQuery): Promise<{ slot: Slot | null; prepMinutes: number; capacity: LocationCapacity; now: Date }> {
  const alloc = await allocateSlot(scope, q);
  const p = await plan(scope, q);
  return { slot: alloc.ok ? alloc.slot : null, prepMinutes: p.prepMinutes, capacity: p.capacity, now: p.now };
}

/**
 * Allocates the order into a real slot.
 * `requestedAt` honours "I'll pick it up around 8". When that cannot be done,
 * the customer is told WHY (too soon / closed / too far ahead / full) and offered
 * exactly one concrete alternative — which is alternatives[0].
 */
export async function allocateSlot(scope: TenantScope, q: SlotQuery): Promise<SlotAllocation> {
  let p = await plan(scope, q);
  const cap = p.capacity;

  if (cap.state === 'PAUSED') {
    return { ok: false, reason: 'PAUSED', capacityState: cap.state, alternatives: [],
      text: cap.note || `We've paused new orders for a few minutes while the kitchen catches up. Please try again shortly.` };
  }
  if (cap.state === 'CLOSED') {
    const open = await openState(scope, q.locationId, cap.timezone, p.now);
    return { ok: false, reason: 'CLOSED', capacityState: cap.state, alternatives: [],
      text: `We're closed for today.${open.nextOpenText ? ` We're open ${open.nextOpenText}.` : ''}` };
  }

  let available = p.slots.filter((s) => s.available);

  // Nothing left today but scheduled orders are allowed: roll to the next opening.
  if (available.length === 0 && p.allowScheduled) {
    const after = addMinutes(p.horizonEnd, cap.slotMinutes);
    const next = p.hours.nextOpening(after);
    if (next) { p = await plan(scope, q, next); available = p.slots.filter((s) => s.available); }
  }

  if (available.length === 0) {
    const open = await openState(scope, q.locationId, cap.timezone, p.now);
    const closeMin = p.hours.closeMinuteOn(p.now);
    const closing = closeMin != null ? ` We close at ${minutesToClock(closeMin)}.` : '';
    return { ok: false, reason: 'NO_SLOTS', capacityState: cap.state, alternatives: [],
      text: `Sorry — we can't take any more pickups for tonight.${closing}${open.nextOpenText ? ` We're open ${open.nextOpenText}.` : ''}`.replace(/\s+/g, ' ').trim() };
  }

  if (q.requestedAt) {
    const slotMs = cap.slotMinutes * 60_000;
    // The slot whose END (the promise) is at or just after the requested time.
    const endMs = Math.ceil(q.requestedAt.getTime() / slotMs) * slotMs;
    const wanted = p.slots.find((s) => s.end.getTime() === endMs);
    const wantedLabel = whenLabel(new Date(endMs), p.now, cap.timezone);

    if (wanted?.available) return success(wanted, p, true);

    const nearest = [...available].sort((a, b) =>
      Math.abs(a.end.getTime() - endMs) - Math.abs(b.end.getTime() - endMs))[0];
    const after = available.find((s) => s.end.getTime() > endMs);

    let text: string;
    let offer: Slot;
    if (endMs < p.earliestReadyAt.getTime()) {
      offer = available[0];
      text = `We can't have it ready that soon. The earliest pickup is ${offer.when}. Would you like that?`;
    } else if (endMs > p.horizonEnd.getTime() + slotMs) {
      offer = available[available.length - 1];
      const hoursAhead = Math.round(cap.maxAdvanceMinutes / 60);
      text = p.allowScheduled
        ? `That's too far ahead — we take pickups up to ${hoursAhead} hours in advance. The latest we can book right now is ${offer.when}. Would you like that?`
        : `We can only take orders for later today, up to closing. The latest pickup we can book is ${offer.when}. Would you like that?`;
    } else if (!wanted || wanted.blockedReason === 'CLOSED') {
      offer = nearest;
      text = `We're closed at ${wantedLabel}. The closest pickup we can do is ${offer.when}. Would you like that?`;
    } else {
      offer = after ?? nearest;
      text = `${wantedLabel} is full. The next available pickup is ${offer.when}. Would you like that?`;
    }
    return { ok: false, reason: 'BEYOND_HORIZON', capacityState: cap.state, alternatives: [offer], text };
  }

  return success(available[0], p, false);
}

function success(slot: Slot, p: SlotPlan, requested: boolean): SlotAllocation {
  const cap = p.capacity;
  const busyPrefix = cap.state === 'VERY_BUSY' ? `We're very busy right now, so ` : cap.state === 'BUSY' ? `We're busy right now, so ` : '';
  const closedPrefix = !p.kitchenOpenNow ? `We're closed right now, so ` : '';
  return {
    ok: true, slot, prepMinutes: p.prepMinutes,
    promisedReadyAt: slot.end,
    capacityState: cap.state,
    text: requested
      ? `Pickup at ${slot.when} works.`
      : `${closedPrefix || busyPrefix}the earliest pickup for this order is ${slot.when}.`.replace(/^the/, 'The'),
  };
}

/* ─────────────── parsing a requested pickup time ─────────────── */

/**
 * "around 8", "at 8:30 pm", "in 30 minutes", "8 baje".
 * Only numbers attached to a time cue are read: "2 chicken biryani ... around 8"
 * means 8 o'clock, never 2 o'clock. Returns null when no time was asked for —
 * the system never guesses one.
 */
export function parseRequestedTime(text: string, now: Date, timezone: string): Date | null {
  const t = text.toLowerCase().replace(/\bfor\s+\d{1,3}\s*(?:people|persons|pax|guests|ppl)\b/g, ' ');

  const rel = t.match(/\bin\s+(\d{1,3}|an?|one|half an?)\s*(min(?:ute)?s?|hours?|hrs?)\b/);
  if (rel) {
    const n = /^\d/.test(rel[1]) ? Number(rel[1]) : rel[1].startsWith('half') ? 0.5 : 1;
    return addMinutes(now, /^h/.test(rel[2]) ? Math.round(n * 60) : n);
  }

  const m =
    t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/) ??
    t.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(?:baje|bje|o'?clock)\b/) ??
    t.match(/(?:\bat|\baround|\bby|\bafter|\btill|\buntil|@)\s*(\d{1,2})(?:[:.](\d{2}))?\b(?!\s*(?:people|persons|pax|min|mins|minutes|hours?|x\b))/) ??
    t.match(/\b(\d{1,2})[:.](\d{2})\b/);
  if (!m) return null;

  const hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const suffix = (m[3] ?? '').replace(/\./g, '');
  if (hour > 23 || minute > 59) return null;

  // Anchor to the whole minute: "around 8" means 8:00:00, not 8:00 plus however
  // many seconds past the minute it happens to be (which rounded up a slot).
  now = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const local = localParts(now, timezone);
  let candidates: number[];
  if (suffix === 'pm') candidates = [(hour % 12) + 12];
  else if (suffix === 'am') candidates = [hour % 12];
  else if (hour >= 13 || hour === 0) candidates = [hour];
  else candidates = hour === 12 ? [12] : [hour, hour + 12];   // "8" could be 8 AM or 8 PM

  const deltas = candidates.map((h) => h * 60 + minute - local.minuteOfDay);
  const future = deltas.filter((d) => d >= 0).sort((a, b) => a - b);
  if (future.length) return addMinutes(now, future[0]);
  if (deltas.some((d) => d >= -120)) return null;                 // just passed: not a booking
  return addMinutes(now, Math.min(...deltas) + 1440);             // clearly means tomorrow
}
