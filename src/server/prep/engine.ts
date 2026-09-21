/**
 * Opening-hours and preparation-time engine.
 * The AI asks for an estimate; it never invents one, and it never promises an
 * exact time — `estimate()` returns a RANGE and a `promisedReadyAt` ceiling.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { businessHours, holidayHours, restaurantSettings, orders, menuItems } from '../../db/schema';
import { localParts, minutesToClock, addMinutes } from '../../lib/time';
import type { TenantScope } from '../tenancy';
import { inArray, sql } from 'drizzle-orm';

export type OpenState = {
  isOpen: boolean;
  reason: 'OPEN' | 'CLOSED_TODAY' | 'BEFORE_OPEN' | 'AFTER_CLOSE' | 'HOLIDAY' | 'NO_HOURS_CONFIGURED';
  todayOpenMinute: number | null;
  todayCloseMinute: number | null;
  /** Human sentence the AI is allowed to send verbatim. */
  message: string;
  nextOpenText: string | null;
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function openState(
  scope: TenantScope, locationId: string, timezone: string, at = new Date(),
): Promise<OpenState> {
  const db = await getDb();
  const local = localParts(at, timezone);

  const [holiday] = await db.drizzle.select().from(holidayHours).where(
    and(eq(holidayHours.restaurantId, scope.restaurantId), eq(holidayHours.date, local.dateKey))).limit(1);

  const hours = await db.drizzle.select().from(businessHours)
    .where(eq(businessHours.restaurantId, scope.restaurantId));

  const forLocation = hours.filter((h: any) => h.locationId === locationId);
  const pool = forLocation.length ? forLocation : hours.filter((h: any) => h.locationId === null);

  const nextOpenText = describeNextOpen(pool, local.dayOfWeek);

  if (holiday) {
    if (holiday.isClosed) {
      return {
        isOpen: false, reason: 'HOLIDAY', todayOpenMinute: null, todayCloseMinute: null,
        message: holiday.note || `We're closed today.`, nextOpenText,
      };
    }
    return evaluateWindow(holiday.openMinute!, holiday.closeMinute!, local.minuteOfDay, nextOpenText, 'HOLIDAY_OPEN');
  }

  const today = pool.find((h: any) => h.dayOfWeek === local.dayOfWeek);
  if (!today) {
    return {
      isOpen: false, reason: 'NO_HOURS_CONFIGURED', todayOpenMinute: null, todayCloseMinute: null,
      message: `Our hours are not set up yet — please contact the restaurant.`, nextOpenText,
    };
  }
  if (today.isClosed) {
    return {
      isOpen: false, reason: 'CLOSED_TODAY', todayOpenMinute: null, todayCloseMinute: null,
      message: `We're closed on ${DAY_NAMES[local.dayOfWeek]}.`, nextOpenText,
    };
  }
  return evaluateWindow(today.openMinute, today.closeMinute, local.minuteOfDay, nextOpenText);
}

function evaluateWindow(
  open: number, close: number, nowMin: number, nextOpenText: string | null, _tag?: string,
): OpenState {
  if (nowMin < open) {
    return {
      isOpen: false, reason: 'BEFORE_OPEN', todayOpenMinute: open, todayCloseMinute: close,
      message: `We're currently closed. We open today at ${minutesToClock(open)}.`, nextOpenText,
    };
  }
  if (nowMin >= close) {
    return {
      isOpen: false, reason: 'AFTER_CLOSE', todayOpenMinute: open, todayCloseMinute: close,
      message: `We're closed for today. ${nextOpenText ? `We're open ${nextOpenText}.` : ''}`.trim(), nextOpenText,
    };
  }
  return {
    isOpen: true, reason: 'OPEN', todayOpenMinute: open, todayCloseMinute: close,
    message: `We're open until ${minutesToClock(close)}.`, nextOpenText,
  };
}

function describeNextOpen(pool: any[], fromDay: number): string | null {
  for (let i = 1; i <= 7; i++) {
    const day = (fromDay + i) % 7;
    const h = pool.find((x) => x.dayOfWeek === day && !x.isClosed);
    if (h) {
      const label = i === 1 ? 'tomorrow' : DAY_NAMES[day];
      return `${label} from ${minutesToClock(h.openMinute)} to ${minutesToClock(h.closeMinute)}`;
    }
  }
  return null;
}

/* ───────────────── preparation time ───────────────── */

export type PrepEstimate = {
  prepMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  queueDepth: number;
  atCapacity: boolean;
  promisedReadyAt: Date;
  /** Exactly what the AI is permitted to tell the customer. */
  text: string;
};

const ACTIVE_STATUSES = ['RECEIVED', 'ACCEPTED', 'PREPARING'] as const;

export async function estimatePrep(
  scope: TenantScope,
  args: { locationId: string; timezone: string; menuItemIds: string[]; at?: Date },
): Promise<PrepEstimate> {
  const db = await getDb();
  const at = args.at ?? new Date();

  const [settings] = await db.drizzle.select().from(restaurantSettings)
    .where(eq(restaurantSettings.restaurantId, scope.restaurantId)).limit(1);

  const base = settings?.defaultPrepMinutes ?? 20;
  const perQueued = settings?.minutesPerQueuedOrder ?? 1.5;
  const maxConcurrent = settings?.maxConcurrentOrders ?? 15;
  const peakBuffer = settings?.peakPrepBufferMinutes ?? 10;

  // Longest item prep drives the line; a kitchen works in parallel, not in series.
  let itemMax = 0;
  if (args.menuItemIds.length) {
    const items = await db.drizzle.select().from(menuItems).where(
      and(eq(menuItems.restaurantId, scope.restaurantId), inArray(menuItems.id, args.menuItemIds)));
    for (const i of items) itemMax = Math.max(itemMax, i.prepMinutes || 0);
  }

  const { rows } = await db.execute(
    `SELECT count(*)::int AS n FROM orders
     WHERE restaurant_id = $1 AND location_id = $2 AND status = ANY($3);`,
    [scope.restaurantId, args.locationId, ACTIVE_STATUSES as unknown as string[]],
  );
  const queueDepth: number = rows[0]?.n ?? 0;
  const atCapacity = queueDepth >= maxConcurrent;

  const queueMinutes = Math.round(queueDepth * perQueued);
  const peak = isPeak(at, args.timezone) ? peakBuffer : 0;

  const prepMinutes = Math.max(base, itemMax) + queueMinutes + peak;
  const minMinutes = prepMinutes;
  const maxMinutes = prepMinutes + 5;
  const promisedReadyAt = addMinutes(at, maxMinutes);

  return {
    prepMinutes, minMinutes, maxMinutes, queueDepth, atCapacity, promisedReadyAt,
    text: `${minMinutes}-${maxMinutes} minutes`,
  };
}

/** Peak = the usual lunch and dinner rushes, in the restaurant's local time. */
function isPeak(at: Date, timezone: string): boolean {
  const m = localParts(at, timezone).minuteOfDay;
  const lunch = m >= 11 * 60 + 30 && m <= 13 * 60 + 30;
  const dinner = m >= 17 * 60 + 30 && m <= 20 * 60;
  return lunch || dinner;
}
