/**
 * Conversation persistence and the three-way memory split (section 31):
 *   conversation memory  -> `conversations.state` (this order, short rolling window)
 *   customer memory      -> customers / order history (long term)
 *   business knowledge   -> menu, settings, FAQ (never copied into the prompt wholesale)
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { conversations, conversationMessages } from '../../db/schema';
import { newId } from '../../lib/ids';
import type { TenantScope } from '../tenancy';

export type ConversationRow = typeof conversations.$inferSelect;

export async function findOrCreateConversation(
  scope: TenantScope, args: { customerId: string; locationId: string },
): Promise<ConversationRow> {
  const db = await getDb();
  const [existing] = await db.drizzle.select().from(conversations).where(and(
    eq(conversations.restaurantId, scope.restaurantId),
    eq(conversations.customerId, args.customerId),
  )).orderBy(desc(conversations.updatedAt)).limit(1);

  if (existing) return existing;

  const id = newId('cnv');
  await db.drizzle.insert(conversations).values({
    id, restaurantId: scope.restaurantId, customerId: args.customerId,
    locationId: args.locationId, handledBy: 'AI', state: {},
  });
  const [row] = await db.drizzle.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return row;
}

/**
 * Idempotent inbound persistence. The unique index on provider_message_id is the
 * real defence against WhatsApp's at-least-once webhook delivery.
 */
export async function recordInbound(
  scope: TenantScope,
  args: {
    conversationId: string; body: string; providerMessageId: string;
    kind?: 'TEXT' | 'AUDIO' | 'IMAGE'; mediaUrl?: string | null;
  },
): Promise<{ messageId: string; duplicate: boolean }> {
  const db = await getDb();
  const id = newId('msg');
  const { rows } = await db.execute(
    `INSERT INTO conversation_messages
       (id, restaurant_id, conversation_id, direction, kind, category, body,
        provider_message_id, media_url, author_type, correlation_id)
     VALUES ($1,$2,$3,'INBOUND',$4,'TRANSACTIONAL',$5,$6,$7,'CUSTOMER',$8)
     ON CONFLICT (provider_message_id) DO NOTHING
     RETURNING id;`,
    [id, scope.restaurantId, args.conversationId, args.kind ?? 'TEXT', args.body,
     args.providerMessageId, args.mediaUrl ?? null, scope.correlationId],
  );

  if (rows.length === 0) {
    const [dup] = await db.drizzle.select().from(conversationMessages)
      .where(eq(conversationMessages.providerMessageId, args.providerMessageId)).limit(1);
    return { messageId: dup?.id ?? '', duplicate: true };
  }

  await db.drizzle.update(conversations)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, args.conversationId));

  return { messageId: id, duplicate: false };
}

export async function recordOutbound(
  scope: TenantScope,
  args: {
    conversationId: string; body: string; providerMessageId?: string | null;
    category?: 'TRANSACTIONAL' | 'MARKETING' | 'SERVICE';
    kind?: 'TEXT' | 'TEMPLATE' | 'SYSTEM';
    authorType?: 'AI' | 'STAFF' | 'SYSTEM'; authorId?: string | null;
  },
): Promise<string> {
  const db = await getDb();
  const id = newId('msg');
  await db.drizzle.insert(conversationMessages).values({
    id, restaurantId: scope.restaurantId, conversationId: args.conversationId,
    direction: 'OUTBOUND', kind: args.kind ?? 'TEXT', category: args.category ?? 'TRANSACTIONAL',
    body: args.body, providerMessageId: args.providerMessageId ?? null,
    authorType: args.authorType ?? 'AI', authorId: args.authorId ?? null,
    correlationId: scope.correlationId,
  });
  await db.drizzle.update(conversations)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(conversations.id, args.conversationId));
  return id;
}

export async function recentMessages(
  scope: TenantScope, conversationId: string, limit = 12,
) {
  const db = await getDb();
  const rows = await db.drizzle.select().from(conversationMessages).where(and(
    eq(conversationMessages.restaurantId, scope.restaurantId),
    eq(conversationMessages.conversationId, conversationId),
  )).orderBy(desc(conversationMessages.createdAt)).limit(limit);
  return rows.reverse();
}

export async function setState(
  scope: TenantScope, conversationId: string, patch: Record<string, unknown>,
): Promise<void> {
  const db = await getDb();
  const [row] = await db.drizzle.select().from(conversations).where(and(
    eq(conversations.restaurantId, scope.restaurantId), eq(conversations.id, conversationId))).limit(1);
  const next = { ...(row?.state ?? {}), ...patch };
  await db.drizzle.update(conversations).set({ state: next, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

export async function setActiveDraft(
  scope: TenantScope, conversationId: string, orderId: string | null,
): Promise<void> {
  const db = await getDb();
  await db.drizzle.update(conversations)
    .set({ activeDraftOrderId: orderId, updatedAt: new Date() })
    .where(and(eq(conversations.restaurantId, scope.restaurantId), eq(conversations.id, conversationId)));
}

export async function setHandledBy(
  scope: TenantScope, conversationId: string, handledBy: 'AI' | 'STAFF', userId?: string | null,
): Promise<void> {
  const db = await getDb();
  await db.drizzle.update(conversations).set({
    handledBy, handedOverToUserId: handledBy === 'STAFF' ? userId ?? null : null, updatedAt: new Date(),
  }).where(and(eq(conversations.restaurantId, scope.restaurantId), eq(conversations.id, conversationId)));
}

export async function getConversation(scope: TenantScope, conversationId: string): Promise<ConversationRow | null> {
  const db = await getDb();
  const [row] = await db.drizzle.select().from(conversations).where(and(
    eq(conversations.restaurantId, scope.restaurantId), eq(conversations.id, conversationId))).limit(1);
  return row ?? null;
}

export async function listConversations(scope: TenantScope, limit = 100) {
  const db = await getDb();
  return db.drizzle.select().from(conversations)
    .where(eq(conversations.restaurantId, scope.restaurantId))
    .orderBy(desc(conversations.lastMessageAt)).limit(limit);
}
