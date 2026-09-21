/**
 * WhatsApp simulator.
 *
 * Lets a restaurant (or a developer) drive the entire ordering pipeline from the
 * console without a connected WhatsApp number — same webhook shape, same
 * ingestion, same agent, same order records. This is what makes step 8 of
 * onboarding ("test order") real rather than a demo animation.
 */
import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../server/http';
import { MockProvider } from '../../../server/messaging/mock';
import { mockProviderFor } from '../../../server/messaging/registry';
import { ingestInbound } from '../../../server/messaging/inbound';
import { setVoiceFixture } from '../../../server/stt/registry';
import { drain } from '../../../server/queue/queue';
import { bootstrap } from '../../../server/bootstrap';
import { getDb } from '../../../db/client';
import { conversations, conversationMessages, customers } from '../../../db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { toE164 } from '../../../lib/phone';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  bootstrap();
  try {
    const { scope } = await requireScope();
    const body = await request.json();

    const { phone } = toE164(String(body.phone ?? '+919000000001'));
    const text = String(body.text ?? '').trim();
    const asVoice = !!body.voice;
    if (!text) return json({ error: 'Say something.' }, 400);

    const mock = mockProviderFor(scope.restaurantId);
    mock.clear();

    let webhookBody: unknown;
    if (asVoice) {
      // The simulator plays the role of speech-to-text: the typed text IS the
      // transcript, so the voice path is exercised end to end.
      const mediaId = `sim_${Date.now()}`;
      setVoiceFixture(mediaId, text, { confidence: Number(body.confidence ?? 0.85) });
      webhookBody = MockProvider.inboundAudioBody({ from: phone, to: '+919999000001', mediaId });
    } else {
      webhookBody = MockProvider.inboundTextBody({
        from: phone, to: '+919999000001', text, name: String(body.name ?? 'Simulator'),
      });
    }

    const parsed = mock.parseWebhook(webhookBody);
    await ingestInbound(scope.restaurantId, parsed.messages);
    await drain();

    const db = await getDb();
    const [customer] = await db.drizzle.select().from(customers).where(and(
      eq(customers.restaurantId, scope.restaurantId), eq(customers.phoneE164, phone))).limit(1);

    const [conversation] = customer
      ? await db.drizzle.select().from(conversations).where(and(
          eq(conversations.restaurantId, scope.restaurantId),
          eq(conversations.customerId, customer.id))).orderBy(desc(conversations.updatedAt)).limit(1)
      : [];

    const history = conversation
      ? (await db.drizzle.select().from(conversationMessages)
          .where(eq(conversationMessages.conversationId, conversation.id))
          .orderBy(desc(conversationMessages.createdAt)).limit(20)).reverse()
      : [];

    return json({
      replies: mock.bodies(),
      conversationId: conversation?.id ?? null,
      activeDraftOrderId: conversation?.activeDraftOrderId ?? null,
      history: history.map((m: any) => ({
        direction: m.direction, authorType: m.authorType, body: m.body, at: m.createdAt,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
