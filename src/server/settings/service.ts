/**
 * Restaurant configuration a new restaurant needs before it can take an order:
 * opening hours, prep time, pickup capacity, policies. Before this module the
 * only way to set any of it was the demo seed — a real signup had no hours and
 * therefore refused every order ("Our hours are not set up yet").
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client';
import { restaurants, restaurantSettings, locations, businessHours, auditLogs } from '../../db/schema';
import { newId } from '../../lib/ids';
import { minutesToClock } from '../../lib/time';
import { ValidationError, NotFoundError } from '../errors';
import { requireRole, type TenantScope } from '../tenancy';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;
const toMinute = (s: string) => (s === '24:00' ? 1440 : Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

async function defaultLocation(scope: TenantScope) {
  const db = await getDb();
  const [loc] = await db.drizzle.select().from(locations)
    .where(and(eq(locations.restaurantId, scope.restaurantId), eq(locations.isActive, true))).limit(1);
  if (!loc) throw new NotFoundError('This restaurant has no location yet.');
  return loc;
}

export async function getSettings(scope: TenantScope) {
  const db = await getDb();
  const [restaurant] = await db.drizzle.select().from(restaurants).where(eq(restaurants.id, scope.restaurantId)).limit(1);
  if (!restaurant) throw new NotFoundError('Restaurant not found.');
  const [settings] = await db.drizzle.select().from(restaurantSettings)
    .where(eq(restaurantSettings.restaurantId, scope.restaurantId)).limit(1);
  const location = await defaultLocation(scope);
  const rows = await db.drizzle.select().from(businessHours).where(and(
    eq(businessHours.restaurantId, scope.restaurantId),
    or(eq(businessHours.locationId, location.id), isNull(businessHours.locationId)),
  ));
  const forLoc = rows.filter((h: any) => h.locationId === location.id);
  const pool = forLoc.length ? forLoc : rows;

  return {
    restaurant: {
      id: restaurant.id, name: restaurant.name, currency: restaurant.currency,
      timezone: restaurant.timezone, taxRateBps: restaurant.taxRateBps, isLive: restaurant.isLive,
    },
    settings,
    location: {
      id: location.id, name: location.name, capacityState: location.capacityState,
      slotMinutes: location.slotMinutes, maxOrdersPerSlot: location.maxOrdersPerSlot,
      maxOrdersPerSlotBusy: location.maxOrdersPerSlotBusy, minLeadMinutes: location.minLeadMinutes,
      maxAdvanceMinutes: location.maxAdvanceMinutes, busyEtaPaddingMinutes: location.busyEtaPaddingMinutes,
      etaOffsetMinutes: location.etaOffsetMinutes,
    },
    hours: [0, 1, 2, 3, 4, 5, 6].map((d) => {
      const h = pool.find((x: any) => x.dayOfWeek === d);
      return h
        ? { dayOfWeek: d, open: toHHMM(h.openMinute), close: toHHMM(h.closeMinute), closed: h.isClosed,
            label: h.isClosed ? 'closed' : `${minutesToClock(h.openMinute)} – ${minutesToClock(h.closeMinute)}` }
        : { dayOfWeek: d, open: null, close: null, closed: true, label: 'not set' };
    }),
  };
}

const SettingsPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  taxRateBps: z.number().int().min(0).max(5000).optional(),
  defaultPrepMinutes: z.number().int().min(1).max(240).optional(),
  minOrderCents: z.number().int().min(0).max(10_000_000).optional(),
  maxOrderCents: z.number().int().min(0).max(100_000_000).optional(),
  allowScheduledOrders: z.boolean().optional(),
  pickupInstructions: z.string().max(1000).optional(),
  parkingInfo: z.string().max(1000).optional(),
  cancellationPolicy: z.string().max(1000).optional(),
  greeting: z.string().max(300).optional(),
  autoPrintOnAccept: z.boolean().optional(),
  slotMinutes: z.number().int().refine((v) => [5, 10, 15, 20, 30, 60].includes(v), 'slot length must be 5, 10, 15, 20, 30 or 60').optional(),
  maxOrdersPerSlot: z.number().int().min(1).max(200).optional(),
  maxOrdersPerSlotBusy: z.number().int().min(1).max(200).optional(),
  minLeadMinutes: z.number().int().min(0).max(240).optional(),
  maxAdvanceMinutes: z.number().int().min(30).max(14 * 24 * 60).optional(),
  busyEtaPaddingMinutes: z.number().int().min(0).max(180).optional(),
}).strict();

export async function updateSettings(scope: TenantScope, body: unknown, userId: string | null) {
  requireRole(scope, 'MANAGER');
  const parsed = SettingsPatch.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid settings.', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  const p = parsed.data;
  const db = await getDb();
  const before = await getSettings(scope);
  const location = await defaultLocation(scope);

  const restaurantPatch: Record<string, unknown> = {};
  if (p.name !== undefined) restaurantPatch.name = p.name;
  if (p.taxRateBps !== undefined) restaurantPatch.taxRateBps = p.taxRateBps;
  if (Object.keys(restaurantPatch).length) {
    await db.drizzle.update(restaurants).set({ ...restaurantPatch, updatedAt: new Date() }).where(eq(restaurants.id, scope.restaurantId));
  }

  const settingsKeys = ['defaultPrepMinutes', 'minOrderCents', 'maxOrderCents', 'allowScheduledOrders', 'pickupInstructions',
    'parkingInfo', 'cancellationPolicy', 'greeting', 'autoPrintOnAccept'] as const;
  const settingsPatch: Record<string, unknown> = {};
  for (const k of settingsKeys) if (p[k] !== undefined) settingsPatch[k] = p[k];
  if (Object.keys(settingsPatch).length) {
    await db.drizzle.insert(restaurantSettings).values({ restaurantId: scope.restaurantId, ...settingsPatch })
      .onConflictDoUpdate({ target: restaurantSettings.restaurantId, set: { ...settingsPatch, updatedAt: new Date() } });
  }

  const locationKeys = ['slotMinutes', 'maxOrdersPerSlot', 'maxOrdersPerSlotBusy', 'minLeadMinutes', 'maxAdvanceMinutes', 'busyEtaPaddingMinutes'] as const;
  const locationPatch: Record<string, unknown> = {};
  for (const k of locationKeys) if (p[k] !== undefined) locationPatch[k] = p[k];
  if (Object.keys(locationPatch).length) {
    await db.drizzle.update(locations).set({ ...locationPatch, updatedAt: new Date() }).where(eq(locations.id, location.id));
  }

  await db.drizzle.insert(auditLogs).values({
    id: newId('aud'), restaurantId: scope.restaurantId, actorType: 'USER', actorId: userId,
    action: 'settings.updated', entityType: 'restaurant', entityId: scope.restaurantId,
    before: before as any, after: p as any, correlationId: scope.correlationId,
  });
  return getSettings(scope);
}

const HoursBody = z.object({
  hours: z.array(z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    open: z.string().regex(HHMM).nullable().optional(),
    close: z.string().regex(HHMM).nullable().optional(),
    closed: z.boolean().default(false),
  })).length(7),
});

export async function setHours(scope: TenantScope, body: unknown, userId: string | null) {
  requireRole(scope, 'MANAGER');
  const parsed = HoursBody.safeParse(body);
  if (!parsed.success) throw new ValidationError('Hours need all 7 days with HH:MM times.', parsed.error.issues.map((i) => i.message));
  const days = new Set(parsed.data.hours.map((h) => h.dayOfWeek));
  if (days.size !== 7) throw new ValidationError('Each day of the week must appear exactly once.');
  for (const h of parsed.data.hours) {
    if (h.closed) continue;
    if (!h.open || !h.close) throw new ValidationError(`Day ${h.dayOfWeek}: open and close times are required unless closed.`);
    if (toMinute(h.close) <= toMinute(h.open)) throw new ValidationError(`Day ${h.dayOfWeek}: closing time must be after opening time.`);
  }

  const db = await getDb();
  const location = await defaultLocation(scope);
  await db.drizzle.delete(businessHours).where(and(
    eq(businessHours.restaurantId, scope.restaurantId),
    or(eq(businessHours.locationId, location.id), isNull(businessHours.locationId)),
  ));
  for (const h of parsed.data.hours) {
    await db.drizzle.insert(businessHours).values({
      id: newId('bh'), restaurantId: scope.restaurantId, locationId: location.id, dayOfWeek: h.dayOfWeek,
      openMinute: h.closed ? 0 : toMinute(h.open!), closeMinute: h.closed ? 0 : toMinute(h.close!), isClosed: h.closed,
    });
  }
  await db.drizzle.insert(auditLogs).values({
    id: newId('aud'), restaurantId: scope.restaurantId, actorType: 'USER', actorId: userId,
    action: 'hours.updated', entityType: 'restaurant', entityId: scope.restaurantId,
    after: parsed.data as any, correlationId: scope.correlationId,
  });
  return getSettings(scope);
}
