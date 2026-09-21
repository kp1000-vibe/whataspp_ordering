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
import { locations, restaurantSettings } from '../../db/schema';
import { menuItems } from '../../db/schema';
import { inArray } from 'drizzle-orm';
import { localParts, minutesToClock, addMinutes } from '../../lib/time';
import { openState } from '../prep/engine';
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
  /** Local clock label, e.g. "7:45 PM". */
  label: string;
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
  if (!loc) throw new Error('location not found in this restaurant');

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

/**
 * Lists the pickup slots between the earliest possible time and the horizon,
 * marking each as available or not, and why.
 */
export async function listSlots(scope: TenantScope, q: SlotQuery): Promise<{
  slots: Slot[]; capacity: LocationCapacity; earliestReadyAt: Date; prepMinutes: number;
}> {
  const now = q.at ?? new Date();
  const cap = await getCapacity(scope, q.locationId);
  const db = await getDb();
  const [settings] = await db.drizzle.select().from(restaurantSettings)
    .where(eq(restaurantSettings.restaurantId, scope.restaurantId)).limit(1);

  const basePrep = Math.max(settings?.defaultPrepMinutes ?? 20, await itemPrepMinutes(scope, q.menuItemIds));
  const busyPad = cap.state === 'BUSY' || cap.state === 'VERY_BUSY' ? cap.busyEtaPaddingMinutes : 0;
  const prepMinutes = basePrep + busyPad + cap.etaOffsetMinutes;

  const earliestReadyAt = addMinutes(now, Math.max(prepMinutes, cap.minLeadMinutes));
  const horizon = addMinutes(now, cap.maxAdvanceMinutes);

  const open = await openState(scope, q.locationId, cap.timezone, now);
  const closeMinute = open.todayCloseMinute;

  const firstSlot = slotStartFor(earliestReadyAt, cap.slotMinutes);
  const bookings = await bookingsBySlot(scope, q.locationId, firstSlot, addMinutes(horizon, cap.slotMinutes));

  const slots: Slot[] = [];
  for (let t = firstSlot.getTime(); t <= horizon.getTime(); t += cap.slotMinutes * 60_000) {
    const start = new Date(t);
    const end = addMinutes(start, cap.slotMinutes);
    const booked = bookings.get(t) ?? 0;

    let blockedReason: Slot['blockedReason'];
    if (start < earliestReadyAt) blockedReason = 'TOO_SOON';
    else if (booked >= cap.maxOrdersPerSlot) blockedReason = 'FULL';
    else if (closeMinute != null && localParts(start, cap.timezone).minuteOfDay > closeMinute) blockedReason = 'CLOSED';

    const local = localParts(start, cap.timezone);
    const localEnd = localParts(end, cap.timezone);

    slots.push({
      start, end,
      label: minutesToClock(local.minuteOfDay),
      rangeLabel: `${minutesToClock(local.minuteOfDay)}-${minutesToClock(localEnd.minuteOfDay)}`,
      booked, capacity: cap.maxOrdersPerSlot,
      available: !blockedReason,
      blockedReason,
    });
  }

  return { slots, capacity: cap, earliestReadyAt, prepMinutes };
}

/**
 * Allocates the order into the best slot.
 * `requestedAt` honours "I'll pick it up around 8" — if that slot is full we say
 * so explicitly and offer the next one rather than silently moving them.
 */
export async function allocateSlot(scope: TenantScope, q: SlotQuery): Promise<SlotAllocation> {
  const now = q.at ?? new Date();
  const { slots, capacity, prepMinutes } = await listSlots(scope, q);

  if (capacity.state === 'PAUSED') {
    return {
      ok: false, reason: 'PAUSED', capacityState: capacity.state, alternatives: [],
      text: capacity.note || `We've paused new orders for a few minutes while the kitchen catches up. Please try again shortly.`,
    };
  }
  if (capacity.state === 'CLOSED') {
    const open = await openState(scope, q.locationId, capacity.timezone, now);
    return {
      ok: false, reason: 'CLOSED', capacityState: capacity.state, alternatives: [],
      text: `${open.message}${open.nextOpenText ? ` We're open ${open.nextOpenText}.` : ''}`.trim(),
    };
  }

  const openSlots = slots.filter((s) => s.available);
  if (openSlots.length === 0) {
    return {
      ok: false, reason: 'NO_SLOTS', capacityState: capacity.state,
      alternatives: slots.slice(0, 3),
      text: `We're fully booked for pickups today. Sorry about that.`,
    };
  }

  // Honour a requested time when we can.
  if (q.requestedAt) {
    const wanted = slotStartFor(q.requestedAt, capacity.slotMinutes).getTime();
    const exact = slots.find((s) => s.start.getTime() === wanted);

    if (exact?.available) {
      return success(exact, prepMinutes, capacity, true);
    }
    const next = openSlots.find((s) => s.start.getTime() > wanted) ?? openSlots[0];
    const why = exact?.blockedReason === 'TOO_SOON'
      ? `We can't have it ready that soon`
      : exact?.blockedReason === 'CLOSED'
        ? `We're closed by then`
        : `${exact ? exact.label : 'That time'} is full`;

    return {
      ok: false, reason: exact?.blockedReason === 'TOO_SOON' ? 'NO_SLOTS' : 'BEYOND_HORIZON',
      capacityState: capacity.state,
      alternatives: openSlots.slice(0, q.alternatives ?? 3),
      text: `${why}. The next available pickup is ${next.label}. Would you like that?`,
    };
  }

  return success(openSlots[0], prepMinutes, capacity, false);
}

function success(slot: Slot, prepMinutes: number, cap: LocationCapacity, requested: boolean): SlotAllocation {
  const busyPrefix = cap.state === 'VERY_BUSY'
    ? `We're very busy right now — `
    : cap.state === 'BUSY' ? `We're busy right now — ` : '';

  return {
    ok: true, slot, prepMinutes,
    // Promise the END of the slot: under-promise, over-deliver.
    promisedReadyAt: slot.end,
    capacityState: cap.state,
    text: requested
      ? `Pickup at ${slot.label} works.`
      : `${busyPrefix}the earliest pickup for this order is ${slot.label}.`,
  };
}

/* ─────────────── parsing a requested pickup time ─────────────── */

/**
 * "around 8", "at 8:30 pm", "in 30 minutes", "8 baje".
 * Returns null when the customer did not ask for a time — do NOT guess one.
 */
export function parseRequestedTime(text: string, now: Date, timezone: string): Date | null {
  const t = text.toLowerCase();

  const inMinutes = t.match(/\bin\s+(\d{1,3})\s*(min|mins|minutes?)\b/);
  if (inMinutes) return addMinutes(now, Number(inMinutes[1]));

  const inHours = t.match(/\bin\s+(?:an?\s+hour|1\s*(?:hr|hour))\b/);
  if (inHours) return addMinutes(now, 60);

  // "8", "8:30", "8 pm", "8.30pm", "20:15", "8 baje"
  const clock = t.match(/\b(?:at|around|by|for)?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|baje|bje)?\b/);
  if (!clock) return null;
  // Guard against matching quantities: require an explicit time cue.
  if (!/\b(at|around|by|pick\s*(it)?\s*up|pickup|baje|am|pm|o'?clock)\b/.test(t)) return null;

  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const suffix = clock[3];

  if (hour > 23 || minute > 59) return null;
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;

  const local = localParts(now, timezone);
  // No am/pm given: pick whichever reading is in the future (people say "8" at 6pm meaning 8pm).
  if (!suffix && hour <= 12) {
    const asPm = hour < 12 ? hour + 12 : hour;
    if (asPm * 60 + minute > local.minuteOfDay) hour = asPm;
  }

  const targetMinute = hour * 60 + minute;
  let deltaMinutes = targetMinute - local.minuteOfDay;
  if (deltaMinutes < -120) deltaMinutes += 1440;   // clearly tomorrow
  if (deltaMinutes < 0) return null;               // in the past today

  return addMinutes(now, deltaMinutes);
}
