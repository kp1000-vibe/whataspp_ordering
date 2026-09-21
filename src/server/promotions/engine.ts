/**
 * Promotion evaluation. Runs server-side only.
 * The AI can READ active promotions; it can never create, modify or apply one.
 *
 * MVP policy (documented decision): promotions do NOT stack. The single
 * best-value eligible promotion is applied. Stacking rules are a rabbit hole of
 * edge cases and every real POS we looked at defaults to "best one wins".
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { promotions, segmentMembers, customers } from '../../db/schema';
import { applyBps } from '../../lib/money';
import { localParts } from '../../lib/time';
import type { TenantScope } from '../tenancy';

export type PricedLine = {
  menuItemId: string;
  quantity: number;
  unitPriceCents: number;
  modifiersTotalCents: number;
  lineTotalCents: number;
};

export type PromotionRow = typeof promotions.$inferSelect;

export type PromotionEvaluation = {
  promotion: PromotionRow | null;
  discountCents: number;
  reason: string;
};

export async function activePromotions(
  scope: TenantScope, at: Date, timezone: string,
): Promise<PromotionRow[]> {
  const db = await getDb();
  const rows: PromotionRow[] = await db.drizzle.select().from(promotions).where(
    and(eq(promotions.restaurantId, scope.restaurantId), eq(promotions.isActive, true)));
  return rows.filter((p) => withinWindow(p, at, timezone));
}

function withinWindow(p: PromotionRow, at: Date, timezone: string): boolean {
  if (p.startsAt && at < p.startsAt) return false;
  if (p.endsAt && at > p.endsAt) return false;

  const local = localParts(at, timezone);
  const days = p.daysOfWeek ?? [];
  if (days.length > 0 && !days.includes(local.dayOfWeek)) return false;

  if (p.startMinute != null && p.endMinute != null) {
    if (local.minuteOfDay < p.startMinute || local.minuteOfDay > p.endMinute) return false;
  }
  if (p.maxRedemptions != null && p.redemptions >= p.maxRedemptions) return false;
  return true;
}

async function customerEligible(
  scope: TenantScope, p: PromotionRow, customerId: string,
): Promise<boolean> {
  const db = await getDb();

  if (p.firstOrderOnly) {
    const [c] = await db.drizzle.select().from(customers).where(
      and(eq(customers.restaurantId, scope.restaurantId), eq(customers.id, customerId))).limit(1);
    if (!c || c.totalOrders > 0) return false;
  }
  if (p.segmentId) {
    const member = await db.drizzle.select().from(segmentMembers).where(
      and(eq(segmentMembers.segmentId, p.segmentId), eq(segmentMembers.customerId, customerId))).limit(1);
    if (member.length === 0) return false;
  }
  return true;
}

/** Subtotal of only the lines a targeted promotion applies to (empty list = whole order). */
function eligibleSubtotal(p: PromotionRow, lines: PricedLine[]): number {
  const targets = p.appliesToItemIds ?? [];
  const applicable = targets.length === 0 ? lines : lines.filter((l) => targets.includes(l.menuItemId));
  return applicable.reduce((sum, l) => sum + l.lineTotalCents, 0);
}

export function computeDiscount(p: PromotionRow, lines: PricedLine[]): number {
  const base = eligibleSubtotal(p, lines);
  if (base <= 0) return 0;

  switch (p.type) {
    case 'PERCENT_OFF':
      return Math.min(base, applyBps(base, p.value));
    case 'FIXED_OFF':
      return Math.min(base, p.value);
    case 'FREE_ITEM': {
      if (!p.freeItemId) return 0;
      const line = lines.find((l) => l.menuItemId === p.freeItemId);
      if (!line) return 0;
      return Math.min(base, line.unitPriceCents);
    }
    case 'BOGO': {
      const targets = p.appliesToItemIds ?? [];
      const applicable = targets.length === 0 ? lines : lines.filter((l) => targets.includes(l.menuItemId));
      // Expand to unit prices, sort ascending, free every 2nd unit (cheapest first).
      const units: number[] = [];
      for (const l of applicable) {
        for (let i = 0; i < l.quantity; i++) units.push(l.unitPriceCents + Math.round(l.modifiersTotalCents / l.quantity));
      }
      units.sort((a, b) => a - b);
      let free = 0;
      const pairs = Math.floor(units.length / 2);
      for (let i = 0; i < pairs; i++) free += units[i];
      return Math.min(base, free);
    }
    default:
      return 0;
  }
}

/**
 * Picks the single best eligible promotion.
 * `requestedCode` restricts evaluation to that code (customer typed a code).
 */
export async function evaluateBestPromotion(
  scope: TenantScope,
  args: { customerId: string; lines: PricedLine[]; subtotalCents: number; at: Date; timezone: string; requestedCode?: string | null },
): Promise<PromotionEvaluation> {
  const all = await activePromotions(scope, args.at, args.timezone);
  const pool = args.requestedCode
    ? all.filter((p) => (p.code ?? '').toUpperCase() === args.requestedCode!.toUpperCase())
    : all.filter((p) => !p.code);   // code-less promos apply automatically

  if (pool.length === 0) {
    return {
      promotion: null, discountCents: 0,
      reason: args.requestedCode ? 'That promo code is not valid right now.' : 'No automatic promotions active.',
    };
  }

  let best: PromotionEvaluation = { promotion: null, discountCents: 0, reason: 'No promotion met its conditions.' };

  for (const p of pool) {
    if (args.subtotalCents < p.minSubtotalCents) continue;
    if (!(await customerEligible(scope, p, args.customerId))) continue;
    const discount = computeDiscount(p, args.lines);
    if (discount > best.discountCents) {
      best = { promotion: p, discountCents: discount, reason: p.name };
    }
  }
  return best;
}

export async function recordRedemption(promotionId: string): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE promotions SET redemptions = redemptions + 1 WHERE id = $1;`, [promotionId]);
}
