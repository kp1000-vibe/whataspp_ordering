/**
 * Customer-facing order notifications (spec section 15).
 *
 * The rule: we NEVER silently miss a promised pickup time. If staff pushes the
 * ETA back, the customer is told, with the new time and an apology.
 * Messages are sent in the language the customer has been using.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { orders, customers, conversations, restaurants, notifications } from '../../db/schema';
import { newId } from '../../lib/ids';
import { whenLabel } from '../../lib/time';
import { now as clockNow } from '../../lib/clock';
import { log } from '../../lib/log';
import { messagingFor } from '../messaging/registry';
import { on } from '../events/bus';
import { recordOutbound, findOrCreateConversation } from '../conversations/service';
import { t, type Language } from '../ai/language';
import { systemScope, type TenantScope } from '../tenancy';
import { getOrder } from '../orders/service';

async function contextFor(scope: TenantScope, orderId: string) {
  const db = await getDb();
  const order = await getOrder(scope, orderId);
  if (!order) return null;

  const [customer] = await db.drizzle.select().from(customers).where(and(
    eq(customers.restaurantId, scope.restaurantId), eq(customers.id, order.customerId))).limit(1);
  const [restaurant] = await db.drizzle.select().from(restaurants)
    .where(eq(restaurants.id, scope.restaurantId)).limit(1);
  if (!customer || !restaurant) return null;

  const conversation = order.conversationId
    ? (await db.drizzle.select().from(conversations).where(eq(conversations.id, order.conversationId)).limit(1))[0]
    : await findOrCreateConversation(scope, { customerId: customer.id, locationId: order.locationId });

  return {
    order, customer, restaurant, conversation,
    language: (customer.language ?? 'en') as Language,
    timezone: restaurant.timezone as string,
  };
}

async function sendToCustomer(
  scope: TenantScope, orderId: string, body: string,
): Promise<void> {
  const ctx = await contextFor(scope, orderId);
  if (!ctx) return;

  const provider = await messagingFor(scope.restaurantId);
  const result = await provider.send({
    to: ctx.customer.phoneE164, kind: 'TEXT', category: 'TRANSACTIONAL', body,
  });

  await recordOutbound(scope, {
    conversationId: ctx.conversation.id, body,
    providerMessageId: result.ok ? result.providerMessageId : null,
    authorType: 'SYSTEM', category: 'TRANSACTIONAL',
  });

  if (!result.ok) {
    log.error('customer notification failed', {
      orderId, error: result.error, retryable: result.retryable, correlationId: scope.correlationId,
    });
  }
}

export async function notifyConfirmed(scope: TenantScope, orderId: string): Promise<void> {
  const ctx = await contextFor(scope, orderId);
  if (!ctx) return;
  const when = ctx.order.promisedReadyAt ? whenLabel(ctx.order.promisedReadyAt, clockNow(), ctx.timezone) : null;
  const body = [
    `${t(ctx.language, 'confirmed')} #${ctx.order.orderNumber}`,
    when ? `${t(ctx.language, 'willBeReady')} ${when}.` : '',
    t(ctx.language, 'weWillMessage'),
  ].filter(Boolean).join(' ');
  await sendToCustomer(scope, orderId, body);
}

export async function notifyPreparing(scope: TenantScope, orderId: string): Promise<void> {
  const ctx = await contextFor(scope, orderId);
  if (!ctx) return;
  await sendToCustomer(scope, orderId, `${t(ctx.language, 'preparing')} 👨‍🍳`);
}

export async function notifyReady(scope: TenantScope, orderId: string): Promise<void> {
  const ctx = await contextFor(scope, orderId);
  if (!ctx) return;
  await sendToCustomer(scope, orderId,
    `${t(ctx.language, 'ready')} 🎉 #${ctx.order.orderNumber}`);
}

/**
 * Pushes the promised time back and TELLS the customer. There is deliberately no
 * way to move the ETA without a notification — that is the product promise.
 */
export async function delayOrder(
  scope: TenantScope, orderId: string, extraMinutes: number, reason = '',
): Promise<{ newReadyAt: Date | null }> {
  const db = await getDb();
  const ctx = await contextFor(scope, orderId);
  if (!ctx || !ctx.order.promisedReadyAt) return { newReadyAt: null };

  const newReadyAt = new Date(ctx.order.promisedReadyAt.getTime() + extraMinutes * 60_000);
  await db.drizzle.update(orders).set({
    promisedReadyAt: newReadyAt,
    originalReadyAt: ctx.order.originalReadyAt ?? ctx.order.promisedReadyAt,
    delayNotifiedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(eq(orders.restaurantId, scope.restaurantId), eq(orders.id, orderId)));

  const when = whenLabel(newReadyAt, clockNow(), ctx.timezone);
  await sendToCustomer(scope, orderId,
    `${t(ctx.language, 'running_late')} ${when}. ${reason}`.trim());

  return { newReadyAt };
}

/** Staff-facing in-console notification. */
export async function notifyStaff(
  scope: TenantScope, args: { kind: string; title: string; body?: string; orderId?: string },
): Promise<void> {
  const db = await getDb();
  await db.drizzle.insert(notifications).values({
    id: newId('ntf'), restaurantId: scope.restaurantId,
    kind: args.kind, title: args.title, body: args.body ?? '', orderId: args.orderId ?? null,
  });
}

/* ─────────── event wiring ─────────── */

/** Called once at boot (and after resetHandlers() in tests). Synchronous on purpose. */
export function registerNotificationHandlers(): void {
  on('order.confirmed', async (e) => {
    await notifyConfirmed(systemScope(e.restaurantId!, e.correlationId), e.payload.orderId as string);
  }, 'notify:confirmed');

  on('order.received', async (e) => {
    await notifyStaff(systemScope(e.restaurantId!, e.correlationId), {
      kind: 'NEW_ORDER',
      title: `New order #${e.payload.orderNumber}`,
      orderId: e.payload.orderId as string,
    });
  }, 'notify:staff-new-order');

  on('order.started', async (e) => {
    await notifyPreparing(systemScope(e.restaurantId!, e.correlationId), e.payload.orderId as string);
  }, 'notify:preparing');

  on('order.ready', async (e) => {
    await notifyReady(systemScope(e.restaurantId!, e.correlationId), e.payload.orderId as string);
  }, 'notify:ready');
}
