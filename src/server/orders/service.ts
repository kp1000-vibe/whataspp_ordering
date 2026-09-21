/**
 * Order write-side. Everything that changes an order goes through here so that
 * pricing, the state machine, status history, events and CRM rollups stay in lockstep.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import {
  orders, orderItems, orderItemModifiers, orderStatusHistory,
  restaurants, restaurantSettings, customers, conversations,
} from '../../db/schema';
import { newId } from '../../lib/ids';
import { log } from '../../lib/log';
import { assertTransition, CUSTOMER_CANCELLABLE, type OrderStatus } from './state-machine';
import { priceOrder, type LineSpec, type PricedOrder } from '../pricing/engine';
import { allocateSlot, slotStartFor, getCapacity, type SlotAllocation } from '../capacity/slots';
import { recordRedemption } from '../promotions/engine';
import { emit } from '../events/bus';
import { assertSameTenant, requireRole, type TenantScope } from '../tenancy';

export type Actor = { type: 'AI' | 'STAFF' | 'SYSTEM' | 'CUSTOMER'; id?: string | null };

export type OrderView = {
  id: string; orderNumber: number; status: OrderStatus; channel: string;
  restaurantId: string; locationId: string; customerId: string;
  conversationId: string | null;
  subtotalCents: number; discountCents: number; taxCents: number; totalCents: number;
  specialInstructions: string; prepMinutes: number;
  promisedReadyAt: Date | null; pickupSlotStart: Date | null;
  originalReadyAt: Date | null; delayNotifiedAt: Date | null; customerRequestedTime: boolean;
  confirmedAt: Date | null; completedAt: Date | null;
  paymentStatus: string; needsHuman: boolean; aiConfidence: number | null;
  cancelledReason: string; correlationId: string; createdAt: Date;
  appliedPromotionId: string | null;
  items: Array<{
    id: string; menuItemId: string; name: string; quantity: number;
    unitPriceCents: number; modifiersTotalCents: number; lineTotalCents: number;
    notes: string; aiConfidence: number | null;
    modifiers: Array<{ modifierId: string; name: string; priceDeltaCents: number }>;
  }>;
};

async function restaurantPricingContext(scope: TenantScope, locationId: string, customerId: string, at: Date) {
  const db = await getDb();
  const [r] = await db.drizzle.select().from(restaurants).where(eq(restaurants.id, scope.restaurantId)).limit(1);
  if (!r) throw new Error('restaurant not found');
  const [s] = await db.drizzle.select().from(restaurantSettings)
    .where(eq(restaurantSettings.restaurantId, scope.restaurantId)).limit(1);

  return {
    locationId, customerId,
    taxRateBps: r.taxRateBps,
    timezone: r.timezone,
    at,
    minOrderCents: s?.minOrderCents ?? 0,
    maxOrderCents: s?.maxOrderCents ?? 0,
  };
}

async function nextOrderNumber(restaurantId: string): Promise<number> {
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT COALESCE(MAX(order_number), 1000) + 1 AS n FROM orders WHERE restaurant_id = $1;`,
    [restaurantId],
  );
  return Number(rows[0].n);
}

/* ─────────────────── draft creation & update ─────────────────── */

export async function createDraftOrder(
  scope: TenantScope,
  args: {
    locationId: string; customerId: string; conversationId?: string | null;
    specs: LineSpec[]; channel?: 'WHATSAPP_TEXT' | 'WHATSAPP_VOICE' | 'CONSOLE' | 'SIMULATOR';
    specialInstructions?: string; promoCode?: string | null; at?: Date;
    /** "I'll pick it up around 8" — null means as soon as possible. */
    requestedPickupAt?: Date | null;
  },
): Promise<{ order: OrderView; pricing: PricedOrder; allocation: SlotAllocation }> {
  const db = await getDb();
  const at = args.at ?? new Date();
  const ctx = { ...(await restaurantPricingContext(scope, args.locationId, args.customerId, at)), promoCode: args.promoCode ?? null };
  const pricing = await priceOrder(scope, args.specs, ctx);

  const allocation = await allocateSlot(scope, {
    locationId: args.locationId,
    menuItemIds: pricing.lines.map((l) => l.menuItemId),
    requestedAt: args.requestedPickupAt ?? null,
    at,
  });

  const orderId = newId('ord');
  const orderNumber = await nextOrderNumber(scope.restaurantId);
  const status: OrderStatus = pricing.priceable ? 'READY_FOR_CONFIRMATION' : (pricing.lines.length ? 'CLARIFICATION_REQUIRED' : 'DRAFT');
  const confidences = pricing.lines.map((l) => l.aiConfidence).filter((c): c is number => c != null);

  await db.drizzle.insert(orders).values({
    id: orderId,
    restaurantId: scope.restaurantId,
    locationId: args.locationId,
    customerId: args.customerId,
    conversationId: args.conversationId ?? null,
    orderNumber,
    status,
    channel: args.channel ?? 'WHATSAPP_TEXT',
    subtotalCents: pricing.subtotalCents,
    discountCents: pricing.discountCents,
    taxCents: pricing.taxCents,
    totalCents: pricing.totalCents,
    appliedPromotionId: pricing.promotion?.id ?? null,
    specialInstructions: args.specialInstructions ?? '',
    prepMinutes: allocation.ok ? allocation.prepMinutes : 0,
    promisedReadyAt: allocation.ok ? allocation.promisedReadyAt : null,
    pickupSlotStart: allocation.ok ? allocation.slot.start : null,
    originalReadyAt: allocation.ok ? allocation.promisedReadyAt : null,
    customerRequestedTime: !!args.requestedPickupAt,
    aiConfidence: confidences.length ? Math.min(...confidences) : null,
    correlationId: scope.correlationId,
  });

  await writeLines(scope, orderId, pricing);
  await db.drizzle.insert(orderStatusHistory).values({
    id: newId('osh'), restaurantId: scope.restaurantId, orderId,
    fromStatus: null, toStatus: status, actorType: 'AI', reason: 'draft created',
  });

  await emit({
    name: 'order.created', restaurantId: scope.restaurantId,
    payload: { orderId, orderNumber, status, totalCents: pricing.totalCents },
    correlationId: scope.correlationId,
  });

  return { order: (await getOrder(scope, orderId))!, pricing, allocation };
}

export async function updateDraftOrder(
  scope: TenantScope,
  args: {
    orderId: string; specs: LineSpec[]; specialInstructions?: string;
    promoCode?: string | null; at?: Date; requestedPickupAt?: Date | null;
  },
): Promise<{ order: OrderView; pricing: PricedOrder; allocation: SlotAllocation }> {
  const db = await getDb();
  const existing = await getOrder(scope, args.orderId);
  assertSameTenant(scope, existing ?? undefined, 'order');

  const draftStates: OrderStatus[] = ['DRAFT', 'CLARIFICATION_REQUIRED', 'READY_FOR_CONFIRMATION'];
  if (!draftStates.includes(existing!.status)) {
    throw new Error(`Order ${existing!.orderNumber} is ${existing!.status} and can no longer be edited by the assistant.`);
  }

  const at = args.at ?? new Date();
  const ctx = { ...(await restaurantPricingContext(scope, existing!.locationId, existing!.customerId, at)), promoCode: args.promoCode ?? null };
  const pricing = await priceOrder(scope, args.specs, ctx);
  const allocation = await allocateSlot(scope, {
    locationId: existing!.locationId,
    menuItemIds: pricing.lines.map((l) => l.menuItemId),
    requestedAt: args.requestedPickupAt ?? existing!.promisedReadyAt ?? null,
    at,
  });

  // Replace lines wholesale — simpler and race-free versus diffing.
  const oldItems = await db.drizzle.select().from(orderItems).where(eq(orderItems.orderId, args.orderId));
  if (oldItems.length) {
    await db.drizzle.delete(orderItemModifiers)
      .where(inArray(orderItemModifiers.orderItemId, oldItems.map((i: any) => i.id)));
    await db.drizzle.delete(orderItems).where(eq(orderItems.orderId, args.orderId));
  }
  await writeLines(scope, args.orderId, pricing);

  const nextStatus: OrderStatus = pricing.priceable ? 'READY_FOR_CONFIRMATION' : (pricing.lines.length ? 'CLARIFICATION_REQUIRED' : 'DRAFT');
  const confidences = pricing.lines.map((l) => l.aiConfidence).filter((c): c is number => c != null);

  await db.drizzle.update(orders).set({
    subtotalCents: pricing.subtotalCents,
    discountCents: pricing.discountCents,
    taxCents: pricing.taxCents,
    totalCents: pricing.totalCents,
    appliedPromotionId: pricing.promotion?.id ?? null,
    specialInstructions: args.specialInstructions ?? existing!.specialInstructions,
    prepMinutes: allocation.ok ? allocation.prepMinutes : existing!.prepMinutes,
    promisedReadyAt: allocation.ok ? allocation.promisedReadyAt : existing!.promisedReadyAt,
    pickupSlotStart: allocation.ok ? allocation.slot.start : null,
    aiConfidence: confidences.length ? Math.min(...confidences) : null,
    status: nextStatus,
    updatedAt: new Date(),
  }).where(eq(orders.id, args.orderId));

  if (nextStatus !== existing!.status) {
    await db.drizzle.insert(orderStatusHistory).values({
      id: newId('osh'), restaurantId: scope.restaurantId, orderId: args.orderId,
      fromStatus: existing!.status, toStatus: nextStatus, actorType: 'AI', reason: 'draft updated',
    });
  }

  return { order: (await getOrder(scope, args.orderId))!, pricing, allocation };
}

async function writeLines(scope: TenantScope, orderId: string, pricing: PricedOrder): Promise<void> {
  const db = await getDb();
  for (const line of pricing.lines) {
    const itemId = newId('oi');
    await db.drizzle.insert(orderItems).values({
      id: itemId, restaurantId: scope.restaurantId, orderId,
      menuItemId: line.menuItemId, nameSnapshot: line.name, quantity: line.quantity,
      unitPriceCents: line.unitPriceCents, modifiersTotalCents: line.modifiersTotalCents,
      lineTotalCents: line.lineTotalCents, notes: line.notes, aiConfidence: line.aiConfidence,
    });
    for (const m of line.modifiers) {
      await db.drizzle.insert(orderItemModifiers).values({
        id: newId('oim'), restaurantId: scope.restaurantId, orderItemId: itemId,
        modifierId: m.modifierId, nameSnapshot: m.name, priceDeltaCents: m.priceDeltaCents,
      });
    }
  }
}

/* ─────────────────── transitions ─────────────────── */

export async function transition(
  scope: TenantScope,
  args: { orderId: string; to: OrderStatus; actor: Actor; reason?: string },
): Promise<OrderView> {
  const db = await getDb();
  const current = await getOrder(scope, args.orderId);
  assertSameTenant(scope, current ?? undefined, 'order');

  assertTransition(current!.status, args.to);

  const patch: Record<string, unknown> = { status: args.to, updatedAt: new Date() };
  if (args.to === 'CONFIRMED') patch.confirmedAt = new Date();
  if (args.to === 'COMPLETED') patch.completedAt = new Date();
  if (args.to === 'CANCELLED' || args.to === 'REJECTED') patch.cancelledReason = args.reason ?? '';

  await db.drizzle.update(orders).set(patch).where(eq(orders.id, args.orderId));
  await db.drizzle.insert(orderStatusHistory).values({
    id: newId('osh'), restaurantId: scope.restaurantId, orderId: args.orderId,
    fromStatus: current!.status, toStatus: args.to,
    actorType: args.actor.type, actorId: args.actor.id ?? null, reason: args.reason ?? '',
  });

  const eventName = {
    CONFIRMED: 'order.confirmed', RECEIVED: 'order.received', ACCEPTED: 'order.accepted',
    PREPARING: 'order.started', READY: 'order.ready', PICKED_UP: 'order.picked_up',
    COMPLETED: 'order.completed', CANCELLED: 'order.cancelled', REJECTED: 'order.rejected',
  }[args.to as string];

  if (eventName) {
    await emit({
      name: eventName as any, restaurantId: scope.restaurantId,
      payload: { orderId: args.orderId, orderNumber: current!.orderNumber, from: current!.status, to: args.to },
      correlationId: current!.correlationId || scope.correlationId,
    });
  }

  if (args.to === 'CONFIRMED' && current!.appliedPromotionId) {
    await recordRedemption(current!.appliedPromotionId);
  }

  log.info('order transition', {
    orderId: args.orderId, from: current!.status, to: args.to,
    actor: args.actor.type, correlationId: current!.correlationId,
  });

  return (await getOrder(scope, args.orderId))!;
}

/** Customer-driven confirmation: CONFIRMED then immediately RECEIVED by the restaurant. */
export async function confirmOrder(scope: TenantScope, orderId: string, actor: Actor = { type: 'CUSTOMER' }): Promise<OrderView> {
  await transition(scope, { orderId, to: 'CONFIRMED', actor, reason: 'customer confirmed' });
  return transition(scope, { orderId, to: 'RECEIVED', actor: { type: 'SYSTEM' }, reason: 'delivered to restaurant' });
}

export async function cancelOrder(
  scope: TenantScope, orderId: string, actor: Actor, reason: string,
): Promise<{ ok: true; order: OrderView } | { ok: false; reason: string; order: OrderView }> {
  const current = await getOrder(scope, orderId);
  assertSameTenant(scope, current ?? undefined, 'order');

  if (actor.type === 'CUSTOMER' && !CUSTOMER_CANCELLABLE.includes(current!.status)) {
    return {
      ok: false,
      reason: `Your order is already ${current!.status.toLowerCase().replace('_', ' ')}.`,
      order: current!,
    };
  }
  const order = await transition(scope, { orderId, to: 'CANCELLED', actor, reason });
  return { ok: true, order };
}

/** Staff override of an order's contents. Always audited. */
export async function staffEditOrder(
  scope: TenantScope,
  args: { orderId: string; specs: LineSpec[]; reason: string; userId: string },
): Promise<{ order: OrderView; pricing: PricedOrder }> {
  requireRole(scope, 'STAFF');
  const db = await getDb();
  const existing = await getOrder(scope, args.orderId);
  assertSameTenant(scope, existing ?? undefined, 'order');

  const at = new Date();
  const ctx = await restaurantPricingContext(scope, existing!.locationId, existing!.customerId, at);
  const pricing = await priceOrder(scope, args.specs, ctx);

  const oldItems = await db.drizzle.select().from(orderItems).where(eq(orderItems.orderId, args.orderId));
  if (oldItems.length) {
    await db.drizzle.delete(orderItemModifiers)
      .where(inArray(orderItemModifiers.orderItemId, oldItems.map((i: any) => i.id)));
    await db.drizzle.delete(orderItems).where(eq(orderItems.orderId, args.orderId));
  }
  await writeLines(scope, args.orderId, pricing);

  await db.drizzle.update(orders).set({
    subtotalCents: pricing.subtotalCents, discountCents: pricing.discountCents,
    taxCents: pricing.taxCents, totalCents: pricing.totalCents, updatedAt: new Date(),
  }).where(eq(orders.id, args.orderId));

  const { auditLogs } = await import('../../db/schema');
  await db.drizzle.insert(auditLogs).values({
    id: newId('aud'), restaurantId: scope.restaurantId, actorType: 'USER', actorId: args.userId,
    action: 'order.staff_edit', entityType: 'order', entityId: args.orderId,
    before: { items: existing!.items, totalCents: existing!.totalCents },
    after: { items: pricing.lines, totalCents: pricing.totalCents },
    correlationId: scope.correlationId,
  });

  return { order: (await getOrder(scope, args.orderId))!, pricing };
}

/* ─────────────────── reads ─────────────────── */

export async function getOrder(scope: TenantScope, orderId: string): Promise<OrderView | null> {
  const db = await getDb();
  const [row] = await db.drizzle.select().from(orders)
    .where(and(eq(orders.restaurantId, scope.restaurantId), eq(orders.id, orderId))).limit(1);
  if (!row) return null;
  return hydrate(row);
}

export async function getOrderByNumber(scope: TenantScope, orderNumber: number): Promise<OrderView | null> {
  const db = await getDb();
  const [row] = await db.drizzle.select().from(orders)
    .where(and(eq(orders.restaurantId, scope.restaurantId), eq(orders.orderNumber, orderNumber))).limit(1);
  return row ? hydrate(row) : null;
}

export async function listOrders(
  scope: TenantScope, opts: { statuses?: OrderStatus[]; customerId?: string; limit?: number } = {},
): Promise<OrderView[]> {
  const db = await getDb();
  const conds = [eq(orders.restaurantId, scope.restaurantId)];
  if (opts.statuses?.length) conds.push(inArray(orders.status, opts.statuses));
  if (opts.customerId) conds.push(eq(orders.customerId, opts.customerId));
  if (scope.locationId) conds.push(eq(orders.locationId, scope.locationId));

  const rows = await db.drizzle.select().from(orders)
    .where(and(...conds)).orderBy(desc(orders.createdAt)).limit(opts.limit ?? 100);
  return Promise.all(rows.map(hydrate));
}

/** Most recent completed order for "the usual" / "same as last time". */
export async function lastCompletedOrder(scope: TenantScope, customerId: string): Promise<OrderView | null> {
  const db = await getDb();
  const [row] = await db.drizzle.select().from(orders).where(and(
    eq(orders.restaurantId, scope.restaurantId),
    eq(orders.customerId, customerId),
    inArray(orders.status, ['PICKED_UP', 'COMPLETED']),
  )).orderBy(desc(orders.createdAt)).limit(1);
  return row ? hydrate(row) : null;
}

async function hydrate(row: any): Promise<OrderView> {
  const db = await getDb();
  const items = await db.drizzle.select().from(orderItems).where(eq(orderItems.orderId, row.id));
  const mods = items.length
    ? await db.drizzle.select().from(orderItemModifiers)
        .where(inArray(orderItemModifiers.orderItemId, items.map((i: any) => i.id)))
    : [];

  return {
    id: row.id, orderNumber: row.orderNumber, status: row.status, channel: row.channel,
    restaurantId: row.restaurantId, locationId: row.locationId, customerId: row.customerId,
    conversationId: row.conversationId,
    subtotalCents: row.subtotalCents, discountCents: row.discountCents,
    taxCents: row.taxCents, totalCents: row.totalCents,
    specialInstructions: row.specialInstructions, prepMinutes: row.prepMinutes,
    promisedReadyAt: row.promisedReadyAt, pickupSlotStart: row.pickupSlotStart,
    originalReadyAt: row.originalReadyAt, delayNotifiedAt: row.delayNotifiedAt,
    customerRequestedTime: row.customerRequestedTime,
    confirmedAt: row.confirmedAt, completedAt: row.completedAt,
    paymentStatus: row.paymentStatus, needsHuman: row.needsHuman, aiConfidence: row.aiConfidence,
    cancelledReason: row.cancelledReason, correlationId: row.correlationId, createdAt: row.createdAt,
    appliedPromotionId: row.appliedPromotionId,
    items: items.map((i: any) => ({
      id: i.id, menuItemId: i.menuItemId, name: i.nameSnapshot, quantity: i.quantity,
      unitPriceCents: i.unitPriceCents, modifiersTotalCents: i.modifiersTotalCents,
      lineTotalCents: i.lineTotalCents, notes: i.notes, aiConfidence: i.aiConfidence,
      modifiers: mods.filter((m: any) => m.orderItemId === i.id).map((m: any) => ({
        modifierId: m.modifierId, name: m.nameSnapshot, priceDeltaCents: m.priceDeltaCents,
      })),
    })),
  };
}

export async function markNeedsHuman(scope: TenantScope, orderId: string, needsHuman: boolean): Promise<void> {
  const db = await getDb();
  await db.drizzle.update(orders).set({ needsHuman, updatedAt: new Date() })
    .where(and(eq(orders.restaurantId, scope.restaurantId), eq(orders.id, orderId)));
}

export async function attachConversation(scope: TenantScope, orderId: string, conversationId: string): Promise<void> {
  const db = await getDb();
  await db.drizzle.update(orders).set({ conversationId, updatedAt: new Date() })
    .where(and(eq(orders.restaurantId, scope.restaurantId), eq(orders.id, orderId)));
  await db.drizzle.update(conversations).set({ activeDraftOrderId: orderId, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}
