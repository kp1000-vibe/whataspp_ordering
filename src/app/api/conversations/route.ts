import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json, readJson } from '../../../server/http';
import { listConversations, recentMessages, setHandledBy, recordOutbound, getConversation } from '../../../server/conversations/service';
import { NotFoundError } from '../../../server/errors';
import { messagingFor } from '../../../server/messaging/registry';
import { getDb } from '../../../db/client';
import { customers } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    const url = new URL(request.url);
    const conversationId = url.searchParams.get('id');

    if (conversationId) {
      return json({ messages: await recentMessages(scope, conversationId, 60) });
    }

    const rows = await listConversations(scope, 50);
    const db = await getDb();
    const people = await db.drizzle.select().from(customers).where(eq(customers.restaurantId, scope.restaurantId));
    const byId = new Map<string, any>(people.map((p: any) => [p.id, p]));

    return json({
      conversations: rows.map((c: any) => {
        const person = byId.get(c.customerId);
        return {
          id: c.id,
          handledBy: c.handledBy,
          lastMessageAt: c.lastMessageAt,
          activeDraftOrderId: c.activeDraftOrderId,
          customer: person ? { name: person.name, phone: person.phoneE164, language: person.language } : null,
        };
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Take over a conversation, hand it back to the AI, or send a staff message.
 * While handledBy is STAFF the agent stands down entirely — the customer is
 * never stuck talking to a bot that cannot help them.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { scope, user } = await requireScope();
    const body = await readJson(request);
    const conversationId = String(body.conversationId ?? '');
    if (!conversationId) return json({ error: 'conversationId is required.' }, 400);
    // Another restaurant's conversation id is indistinguishable from a missing one.
    if (!(await getConversation(scope, conversationId))) throw new NotFoundError('Conversation not found.');

    if (body.action === 'takeover' || body.action === 'release') {
      await setHandledBy(scope, conversationId, body.action === 'takeover' ? 'STAFF' : 'AI', user.userId);
      return json({ ok: true });
    }

    if (body.action === 'send') {
      const text = String(body.text ?? '').trim();
      if (!text) return json({ error: 'Message is empty.' }, 400);

      const db = await getDb();
      const { rows } = await db.execute(
        `SELECT c.phone_e164 FROM conversations cv
         JOIN customers c ON c.id = cv.customer_id
         WHERE cv.id = $1 AND cv.restaurant_id = $2;`,
        [conversationId, scope.restaurantId],
      );
      if (!rows[0]) return json({ error: 'Conversation not found.' }, 404);

      const provider = await messagingFor(scope.restaurantId);
      const result = await provider.send({
        to: rows[0].phone_e164, kind: 'TEXT', category: 'SERVICE', body: text,
      });
      await recordOutbound(scope, {
        conversationId, body: text, authorType: 'STAFF', authorId: user.userId,
        category: 'SERVICE', providerMessageId: result.ok ? result.providerMessageId : null,
      });
      return result.ok ? json({ ok: true }) : json({ error: result.error }, 502);
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (err) {
    return errorResponse(err);
  }
}
