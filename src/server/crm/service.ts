/**
 * Customer profiles, consent, and the rollups every segment and campaign reads.
 * Rollups are recomputed from orders (source of truth), never incremented blindly,
 * so a replayed event cannot corrupt lifetime value.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { customers, customerConsent, customerTags, orders, orderItems } from '../../db/schema';
import { newId } from '../../lib/ids';
import { toE164 } from '../../lib/phone';
import { emit } from '../events/bus';
import type { TenantScope } from '../tenancy';

export type CustomerProfile = {
  id: string; phoneE164: string; name: string | null;
  totalOrders: number; lifetimeSpendCents: number; averageOrderCents: number;
  firstOrderAt: Date | null; lastOrderAt: Date | null; lastInteractionAt: Date | null;
  daysSinceLastOrder: number | null;
  cancelledOrders: number;
  marketingStatus: 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN';
  tags: string[];
  favouriteItems: Array<{ menuItemId: string; name: string; count: number }>;
  preferredLocationId: string | null;
  notes: string;
};

export async function findOrCreateCustomer(
  scope: TenantScope, rawPhone: string, name?: string | null,
): Promise<{ id: string; created: boolean }> {
  const db = await getDb();
  const { phone } = toE164(rawPhone);

  const [existing] = await db.drizzle.select().from(customers).where(
    and(eq(customers.restaurantId, scope.restaurantId), eq(customers.phoneE164, phone))).limit(1);

  if (existing) {
    if (name && !existing.name) {
      await db.drizzle.update(customers).set({ name, updatedAt: new Date() }).where(eq(customers.id, existing.id));
    }
    return { id: existing.id, created: false };
  }

  const id = newId('cus');
  await db.drizzle.insert(customers).values({
    id, restaurantId: scope.restaurantId, phoneE164: phone, name: name ?? null,
    lastInteractionAt: new Date(),
  });
  await db.drizzle.insert(customerConsent).values({
    id: newId('con'), restaurantId: scope.restaurantId, customerId: id,
    marketingStatus: 'UNKNOWN', source: 'first_contact',
  });

  await emit({
    name: 'customer.created', restaurantId: scope.restaurantId,
    payload: { customerId: id, phone }, correlationId: scope.correlationId,
  });
  return { id, created: true };
}

export async function touchInteraction(scope: TenantScope, customerId: string): Promise<void> {
  const db = await getDb();
  await db.drizzle.update(customers).set({ lastInteractionAt: new Date(), updatedAt: new Date() })
    .where(and(eq(customers.restaurantId, scope.restaurantId), eq(customers.id, customerId)));
}

/**
 * Recompute rollups from the orders table. Idempotent by construction.
 * Called on order.completed / order.cancelled.
 */
export async function recomputeCustomerRollups(scope: TenantScope, customerId: string): Promise<void> {
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT
       count(*) FILTER (WHERE status IN ('PICKED_UP','COMPLETED'))::int              AS total_orders,
       COALESCE(sum(total_cents) FILTER (WHERE status IN ('PICKED_UP','COMPLETED')),0)::int AS lifetime_spend,
       count(*) FILTER (WHERE status IN ('CANCELLED','REJECTED'))::int               AS cancelled,
       min(created_at) FILTER (WHERE status IN ('PICKED_UP','COMPLETED'))            AS first_order_at,
       max(created_at) FILTER (WHERE status IN ('PICKED_UP','COMPLETED'))            AS last_order_at
     FROM orders WHERE restaurant_id = $1 AND customer_id = $2;`,
    [scope.restaurantId, customerId],
  );
  const r = rows[0] ?? {};
  await db.drizzle.update(customers).set({
    totalOrders: Number(r.total_orders ?? 0),
    lifetimeSpendCents: Number(r.lifetime_spend ?? 0),
    cancelledOrders: Number(r.cancelled ?? 0),
    firstOrderAt: r.first_order_at ? new Date(r.first_order_at) : null,
    lastOrderAt: r.last_order_at ? new Date(r.last_order_at) : null,
    updatedAt: new Date(),
  }).where(and(eq(customers.restaurantId, scope.restaurantId), eq(customers.id, customerId)));
}

export async function getProfile(scope: TenantScope, customerId: string): Promise<CustomerProfile | null> {
  const db = await getDb();
  const [c] = await db.drizzle.select().from(customers).where(
    and(eq(customers.restaurantId, scope.restaurantId), eq(customers.id, customerId))).limit(1);
  if (!c) return null;

  const [consent] = await db.drizzle.select().from(customerConsent)
    .where(eq(customerConsent.customerId, customerId))
    .orderBy(desc(customerConsent.changedAt)).limit(1);

  const tags = await db.drizzle.select().from(customerTags).where(eq(customerTags.customerId, customerId));

  const { rows: favs } = await db.execute(
    `SELECT oi.menu_item_id, oi.name_snapshot AS name, sum(oi.quantity)::int AS count
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1 AND o.customer_id = $2 AND o.status IN ('PICKED_UP','COMPLETED')
     GROUP BY oi.menu_item_id, oi.name_snapshot
     ORDER BY count DESC LIMIT 5;`,
    [scope.restaurantId, customerId],
  );

  const daysSince = c.lastOrderAt
    ? Math.floor((Date.now() - new Date(c.lastOrderAt).getTime()) / 86_400_000)
    : null;

  return {
    id: c.id, phoneE164: c.phoneE164, name: c.name,
    totalOrders: c.totalOrders, lifetimeSpendCents: c.lifetimeSpendCents,
    averageOrderCents: c.totalOrders ? Math.round(c.lifetimeSpendCents / c.totalOrders) : 0,
    firstOrderAt: c.firstOrderAt, lastOrderAt: c.lastOrderAt, lastInteractionAt: c.lastInteractionAt,
    daysSinceLastOrder: daysSince,
    cancelledOrders: c.cancelledOrders,
    marketingStatus: consent?.marketingStatus ?? 'UNKNOWN',
    tags: tags.map((t: any) => t.tag),
    favouriteItems: favs.map((f: any) => ({ menuItemId: f.menu_item_id, name: f.name, count: f.count })),
    preferredLocationId: c.preferredLocationId,
    notes: c.notes,
  };
}

export async function listCustomers(
  scope: TenantScope, opts: { limit?: number; search?: string } = {},
): Promise<CustomerProfile[]> {
  const db = await getDb();
  const rows = await db.drizzle.select().from(customers)
    .where(eq(customers.restaurantId, scope.restaurantId))
    .orderBy(desc(customers.lastOrderAt))
    .limit(opts.limit ?? 200);

  const filtered = opts.search
    ? rows.filter((r: any) =>
        (r.name ?? '').toLowerCase().includes(opts.search!.toLowerCase()) || r.phoneE164.includes(opts.search!))
    : rows;

  const profiles = await Promise.all(filtered.map((r: any) => getProfile(scope, r.id)));
  return profiles.filter((p): p is CustomerProfile => p !== null);
}

/* ─────────────── consent (WhatsApp compliance) ─────────────── */

const OPT_OUT_PATTERNS = [
  /^\s*stop\s*$/i, /^\s*unsubscribe\s*$/i, /^\s*opt\s*out\s*$/i, /^\s*cancel\s+subscription\s*$/i,
  /\bstop\s+(sending|messaging|texting)\b/i, /\b(don'?t|do not)\s+(message|text|contact)\s+me\b/i,
  /\bremove\s+me\s+from\b/i, /\bunsubscribe\s+me\b/i, /\bno\s+more\s+(offers|promos|marketing)\b/i,
];
const OPT_IN_PATTERNS = [
  /^\s*start\s*$/i, /^\s*subscribe\s*$/i, /^\s*(yes,?\s*)?opt\s*in\s*$/i,
  /\bsend\s+me\s+(offers|deals|promos)\b/i,
];

export function detectConsentIntent(text: string): 'OPT_OUT' | 'OPT_IN' | null {
  if (OPT_OUT_PATTERNS.some((p) => p.test(text))) return 'OPT_OUT';
  if (OPT_IN_PATTERNS.some((p) => p.test(text))) return 'OPT_IN';
  return null;
}

export async function setMarketingConsent(
  scope: TenantScope, customerId: string,
  status: 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN', source: string,
): Promise<void> {
  const db = await getDb();
  await db.drizzle.insert(customerConsent).values({
    id: newId('con'), restaurantId: scope.restaurantId, customerId,
    marketingStatus: status, source, changedAt: new Date(),
  });
  await emit({
    name: 'customer.consent.changed', restaurantId: scope.restaurantId,
    payload: { customerId, status, source }, correlationId: scope.correlationId,
  });
}

export async function marketingStatusOf(scope: TenantScope, customerId: string): Promise<'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN'> {
  const db = await getDb();
  const [row] = await db.drizzle.select().from(customerConsent)
    .where(and(eq(customerConsent.restaurantId, scope.restaurantId), eq(customerConsent.customerId, customerId)))
    .orderBy(desc(customerConsent.changedAt)).limit(1);
  return row?.marketingStatus ?? 'UNKNOWN';
}

export async function addTag(scope: TenantScope, customerId: string, tag: string, source = 'manual'): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO customer_tags (id, restaurant_id, customer_id, tag, source)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (customer_id, tag) DO NOTHING;`,
    [newId('tag'), scope.restaurantId, customerId, tag, source],
  );
}

export async function removeTag(scope: TenantScope, customerId: string, tag: string): Promise<void> {
  const db = await getDb();
  await db.drizzle.delete(customerTags).where(and(
    eq(customerTags.restaurantId, scope.restaurantId),
    eq(customerTags.customerId, customerId),
    eq(customerTags.tag, tag),
  ));
}

/**
 * GDPR/CCPA erasure. Wipes the customer's identifiers EVERYWHERE they were
 * copied — not just the customers row. Kitchen tickets, the event log and the
 * job queue all held copies of the name or phone (found by eval B20).
 * Anonymised order facts (items, totals) are kept for accounting.
 */
export async function eraseCustomer(scope: TenantScope, customerId: string): Promise<void> {
  const db = await getDb();
  const [c] = await db.drizzle.select().from(customers).where(
    and(eq(customers.restaurantId, scope.restaurantId), eq(customers.id, customerId))).limit(1);
  if (!c) {
    const { NotFoundError } = await import('../errors');
    throw new NotFoundError('Customer not found.');
  }
  const phoneDigits = c.phoneE164.replace(/\D/g, '');
  const name = c.name ?? '';

  await db.drizzle.update(customers).set({
    phoneE164: `erased:${customerId}`, name: null, notes: '', updatedAt: new Date(),
  }).where(eq(customers.id, customerId));

  const convIds = `SELECT id FROM conversations WHERE restaurant_id = $1 AND customer_id = $2`;
  const orderIds = `SELECT id FROM orders WHERE restaurant_id = $1 AND customer_id = $2`;

  await db.execute(`UPDATE conversation_messages SET body = '[erased]', media_url = NULL WHERE conversation_id IN (${convIds});`, [scope.restaurantId, customerId]);
  await db.execute(`UPDATE conversations SET state = '{}'::jsonb WHERE id IN (${convIds});`, [scope.restaurantId, customerId]);
  await db.execute(
    `UPDATE print_jobs SET payload = regexp_replace(regexp_replace(payload, 'CUSTOMER: [^\n]*', 'CUSTOMER: [erased]', 'g'), 'PHONE: [^\n]*', 'PHONE: [erased]', 'g')
     WHERE order_id IN (${orderIds});`, [scope.restaurantId, customerId]);
  await db.execute(
    `UPDATE voice_messages SET transcript = '[erased]' WHERE conversation_message_id IN
       (SELECT id FROM conversation_messages WHERE conversation_id IN (${convIds}));`, [scope.restaurantId, customerId]);

  // Event log and job queue: redact any record that mentions this customer.
  const like = [`%${customerId}%`, phoneDigits ? `%${phoneDigits}%` : '%__never__%', name ? `%${name}%` : '%__never__%'];
  for (const table of ['domain_events', 'jobs']) {
    await db.execute(
      `UPDATE ${table} SET payload = jsonb_build_object('redacted', true, 'reason', 'erasure_request')
       WHERE payload::text LIKE $1 OR payload::text LIKE $2 OR payload::text LIKE $3;`, like);
  }
  await db.execute(
    `UPDATE audit_logs SET before = NULL, after = NULL
     WHERE restaurant_id = $1 AND (before::text LIKE $2 OR after::text LIKE $2 OR before::text LIKE $3 OR after::text LIKE $3);`,
    [scope.restaurantId, like[1], like[2]]);

  await setMarketingConsent(scope, customerId, 'OPTED_OUT', 'erasure_request');
}
