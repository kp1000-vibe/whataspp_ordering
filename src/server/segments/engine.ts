/**
 * Customer segmentation.
 *
 * Segments are a declarative rule tree stored as JSON. Rules are evaluated
 * SERVER-SIDE against a feature set computed from orders — the LLM may PROPOSE a
 * rule, it may never decide membership. Every audience number a manager sees
 * comes from this file.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { segments, segmentMembers } from '../../db/schema';
import { newId } from '../../lib/ids';
import { emit } from '../events/bus';
import type { TenantScope } from '../tenancy';

export type NumericField =
  | 'totalOrders' | 'lifetimeSpendCents' | 'averageOrderCents'
  | 'daysSinceLastOrder' | 'daysSinceFirstOrder' | 'cancelledOrders'
  | 'weekendOrderShare' | 'vegetarianItemShare' | 'lunchOrderShare';

export type Comparison = 'gt' | 'gte' | 'lt' | 'lte' | 'eq';

export type Rule =
  | { all: Rule[] }
  | { any: Rule[] }
  | { not: Rule }
  | { field: NumericField; op: Comparison; value: number }
  | { itemPurchases: { menuItemId?: string; nameContains?: string; categoryId?: string }; op: Comparison; value: number }
  | { marketing: 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN' }
  | { hasTag: string }
  | { everOrdered: boolean };

export type CustomerFeatures = {
  customerId: string;
  totalOrders: number;
  lifetimeSpendCents: number;
  averageOrderCents: number;
  daysSinceLastOrder: number;      // Infinity-safe sentinel: 99999 when never ordered
  daysSinceFirstOrder: number;
  cancelledOrders: number;
  weekendOrderShare: number;       // 0..1
  lunchOrderShare: number;         // 0..1 (11:00-14:00 local)
  vegetarianItemShare: number;     // 0..1
  marketing: 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN';
  tags: string[];
  itemCounts: Record<string, number>;   // menuItemId -> units
  itemNames: Record<string, string>;
  categoryOfItem: Record<string, string>;
};

const NEVER = 99999;

export async function computeFeatures(scope: TenantScope, timezone: string): Promise<CustomerFeatures[]> {
  const db = await getDb();

  const { rows: base } = await db.execute(
    `SELECT
       c.id AS customer_id,
       COALESCE(count(o.id) FILTER (WHERE o.status IN ('PICKED_UP','COMPLETED')),0)::int AS total_orders,
       COALESCE(sum(o.total_cents) FILTER (WHERE o.status IN ('PICKED_UP','COMPLETED')),0)::int AS lifetime_spend,
       COALESCE(count(o.id) FILTER (WHERE o.status IN ('CANCELLED','REJECTED')),0)::int AS cancelled,
       max(o.created_at) FILTER (WHERE o.status IN ('PICKED_UP','COMPLETED')) AS last_order_at,
       min(o.created_at) FILTER (WHERE o.status IN ('PICKED_UP','COMPLETED')) AS first_order_at,
       COALESCE(count(o.id) FILTER (
         WHERE o.status IN ('PICKED_UP','COMPLETED')
           AND EXTRACT(DOW FROM o.created_at AT TIME ZONE $2) IN (0,5,6)),0)::int AS weekend_orders,
       COALESCE(count(o.id) FILTER (
         WHERE o.status IN ('PICKED_UP','COMPLETED')
           AND EXTRACT(HOUR FROM o.created_at AT TIME ZONE $2) BETWEEN 11 AND 13),0)::int AS lunch_orders
     FROM customers c
     LEFT JOIN orders o ON o.customer_id = c.id AND o.restaurant_id = c.restaurant_id
     WHERE c.restaurant_id = $1
     GROUP BY c.id;`,
    [scope.restaurantId, timezone],
  );

  const { rows: items } = await db.execute(
    `SELECT o.customer_id, oi.menu_item_id, oi.name_snapshot, mi.category_id,
            COALESCE(mi.is_vegetarian,false) AS is_veg, sum(oi.quantity)::int AS units
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
     WHERE o.restaurant_id = $1 AND o.status IN ('PICKED_UP','COMPLETED')
     GROUP BY o.customer_id, oi.menu_item_id, oi.name_snapshot, mi.category_id, mi.is_vegetarian;`,
    [scope.restaurantId],
  );

  const { rows: consents } = await db.execute(
    `SELECT DISTINCT ON (customer_id) customer_id, marketing_status
     FROM customer_consent WHERE restaurant_id = $1
     ORDER BY customer_id, changed_at DESC;`,
    [scope.restaurantId],
  );

  const { rows: tagRows } = await db.execute(
    `SELECT customer_id, tag FROM customer_tags WHERE restaurant_id = $1;`, [scope.restaurantId]);

  const consentBy = new Map(consents.map((r: any) => [r.customer_id, r.marketing_status]));
  const tagsBy = new Map<string, string[]>();
  for (const r of tagRows as any[]) {
    tagsBy.set(r.customer_id, [...(tagsBy.get(r.customer_id) ?? []), r.tag]);
  }

  const itemsBy = new Map<string, any[]>();
  for (const r of items as any[]) {
    itemsBy.set(r.customer_id, [...(itemsBy.get(r.customer_id) ?? []), r]);
  }

  const nowMs = Date.now();

  return (base as any[]).map((r) => {
    const rows = itemsBy.get(r.customer_id) ?? [];
    const totalUnits = rows.reduce((s, x) => s + x.units, 0);
    const vegUnits = rows.filter((x) => x.is_veg).reduce((s, x) => s + x.units, 0);

    const itemCounts: Record<string, number> = {};
    const itemNames: Record<string, string> = {};
    const categoryOfItem: Record<string, string> = {};
    for (const x of rows) {
      itemCounts[x.menu_item_id] = (itemCounts[x.menu_item_id] ?? 0) + x.units;
      itemNames[x.menu_item_id] = x.name_snapshot;
      if (x.category_id) categoryOfItem[x.menu_item_id] = x.category_id;
    }

    const total = Number(r.total_orders);
    return {
      customerId: r.customer_id,
      totalOrders: total,
      lifetimeSpendCents: Number(r.lifetime_spend),
      averageOrderCents: total ? Math.round(Number(r.lifetime_spend) / total) : 0,
      daysSinceLastOrder: r.last_order_at ? Math.floor((nowMs - new Date(r.last_order_at).getTime()) / 86_400_000) : NEVER,
      daysSinceFirstOrder: r.first_order_at ? Math.floor((nowMs - new Date(r.first_order_at).getTime()) / 86_400_000) : NEVER,
      cancelledOrders: Number(r.cancelled),
      weekendOrderShare: total ? Number(r.weekend_orders) / total : 0,
      lunchOrderShare: total ? Number(r.lunch_orders) / total : 0,
      vegetarianItemShare: totalUnits ? vegUnits / totalUnits : 0,
      marketing: (consentBy.get(r.customer_id) as any) ?? 'UNKNOWN',
      tags: tagsBy.get(r.customer_id) ?? [],
      itemCounts, itemNames, categoryOfItem,
    };
  });
}

function compare(actual: number, op: Comparison, expected: number): boolean {
  switch (op) {
    case 'gt': return actual > expected;
    case 'gte': return actual >= expected;
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
    case 'eq': return actual === expected;
  }
}

export function evaluateRule(rule: Rule, f: CustomerFeatures): boolean {
  if ('all' in rule) return rule.all.every((r) => evaluateRule(r, f));
  if ('any' in rule) return rule.any.some((r) => evaluateRule(r, f));
  if ('not' in rule) return !evaluateRule(rule.not, f);
  if ('marketing' in rule) return f.marketing === rule.marketing;
  if ('hasTag' in rule) return f.tags.includes(rule.hasTag);
  if ('everOrdered' in rule) return rule.everOrdered ? f.totalOrders > 0 : f.totalOrders === 0;

  if ('itemPurchases' in rule) {
    const sel = rule.itemPurchases;
    let units = 0;
    for (const [itemId, count] of Object.entries(f.itemCounts)) {
      if (sel.menuItemId && itemId !== sel.menuItemId) continue;
      if (sel.categoryId && f.categoryOfItem[itemId] !== sel.categoryId) continue;
      if (sel.nameContains && !(f.itemNames[itemId] ?? '').toLowerCase().includes(sel.nameContains.toLowerCase())) continue;
      units += count;
    }
    return compare(units, rule.op, rule.value);
  }

  return compare(f[rule.field], rule.op, rule.value);
}

export async function previewSegment(
  scope: TenantScope, rule: Rule, timezone: string,
): Promise<{ customerIds: string[]; size: number }> {
  const features = await computeFeatures(scope, timezone);
  const ids = features.filter((f) => evaluateRule(rule, f)).map((f) => f.customerId);
  return { customerIds: ids, size: ids.length };
}

export async function recomputeSegment(
  scope: TenantScope, segmentId: string, timezone: string,
): Promise<number> {
  const db = await getDb();
  const [seg] = await db.drizzle.select().from(segments).where(
    and(eq(segments.restaurantId, scope.restaurantId), eq(segments.id, segmentId))).limit(1);
  if (!seg) throw new Error('segment not found in this restaurant');

  const { customerIds } = await previewSegment(scope, seg.rule as Rule, timezone);

  await db.drizzle.delete(segmentMembers).where(eq(segmentMembers.segmentId, segmentId));
  for (const customerId of customerIds) {
    await db.drizzle.insert(segmentMembers).values({
      id: newId('sm'), restaurantId: scope.restaurantId, segmentId, customerId,
    });
  }
  await db.drizzle.update(segments).set({
    lastComputedAt: new Date(), lastCount: customerIds.length, updatedAt: new Date(),
  }).where(eq(segments.id, segmentId));

  await emit({
    name: 'customer.segment.changed', restaurantId: scope.restaurantId,
    payload: { segmentId, size: customerIds.length }, correlationId: scope.correlationId,
  });
  return customerIds.length;
}

export async function recomputeAllSegments(scope: TenantScope, timezone: string): Promise<Record<string, number>> {
  const db = await getDb();
  const rows = await db.drizzle.select().from(segments).where(eq(segments.restaurantId, scope.restaurantId));
  const out: Record<string, number> = {};
  for (const s of rows) out[s.name] = await recomputeSegment(scope, s.id, timezone);
  return out;
}

export async function createSegment(
  scope: TenantScope, args: { name: string; description?: string; rule: Rule; isSystem?: boolean },
): Promise<string> {
  const db = await getDb();
  const id = newId('seg');
  await db.drizzle.insert(segments).values({
    id, restaurantId: scope.restaurantId, name: args.name,
    description: args.description ?? '', rule: args.rule, isSystem: args.isSystem ?? false,
  });
  return id;
}

/** The eight segments every restaurant gets on day one. */
export const SYSTEM_SEGMENTS: Array<{ name: string; description: string; rule: Rule }> = [
  { name: 'New Customers', description: 'First order within the last 30 days',
    rule: { all: [{ field: 'totalOrders', op: 'gte', value: 1 }, { field: 'daysSinceFirstOrder', op: 'lte', value: 30 }] } },
  { name: 'Loyal Customers', description: '10 or more completed orders',
    rule: { field: 'totalOrders', op: 'gte', value: 10 } },
  { name: 'High Value', description: 'Lifetime spend over $500',
    rule: { field: 'lifetimeSpendCents', op: 'gt', value: 50000 } },
  { name: 'At Risk', description: 'Previously active, no order in 30-59 days',
    rule: { all: [
      { field: 'totalOrders', op: 'gte', value: 2 },
      { field: 'daysSinceLastOrder', op: 'gte', value: 30 },
      { field: 'daysSinceLastOrder', op: 'lt', value: 60 },
    ] } },
  { name: 'Lapsed', description: 'No order in 60+ days',
    rule: { all: [
      { field: 'totalOrders', op: 'gte', value: 1 },
      { field: 'daysSinceLastOrder', op: 'gte', value: 60 },
      { field: 'daysSinceLastOrder', op: 'lt', value: 99999 },
    ] } },
  { name: 'Inactive', description: 'No order in 90+ days',
    rule: { all: [
      { field: 'totalOrders', op: 'gte', value: 1 },
      { field: 'daysSinceLastOrder', op: 'gte', value: 90 },
      { field: 'daysSinceLastOrder', op: 'lt', value: 99999 },
    ] } },
  { name: 'Weekend Customers', description: 'Most orders fall on Fri-Sun',
    rule: { all: [{ field: 'totalOrders', op: 'gte', value: 2 }, { field: 'weekendOrderShare', op: 'gte', value: 0.6 }] } },
  { name: 'Vegetarian Customers', description: 'Over half of items purchased are vegetarian',
    rule: { all: [{ field: 'totalOrders', op: 'gte', value: 1 }, { field: 'vegetarianItemShare', op: 'gt', value: 0.5 }] } },
];
