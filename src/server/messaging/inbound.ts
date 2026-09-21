/**
 * Inbound message pipeline.
 *
 * The webhook route does the minimum (verify signature, persist, enqueue) and
 * returns 200 fast — Meta retries anything slow, which would duplicate orders.
 * All real work happens in the `handle_inbound_message` job below.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { restaurants, integrations, locations, voiceMessages, conversationMessages } from '../../db/schema';
import { newId, correlationId as newCorrelationId } from '../../lib/ids';
import { log } from '../../lib/log';
import { systemScope, type TenantScope } from '../tenancy';
import { findOrCreateCustomer, touchInteraction } from '../crm/service';
import { findOrCreateConversation, recordInbound, recordOutbound, getConversation } from '../conversations/service';
import { runOrderAgent } from '../ai/agent/order-agent';
import { messagingFor } from './registry';
import { register, enqueue } from '../queue/queue';
import { transcribeVoice } from '../stt/registry';
import { emit } from '../events/bus';
import type { InboundMessage } from './provider';

/** Resolves which restaurant a WhatsApp business number belongs to. */
export async function restaurantForBusinessNumber(toPhone: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db.drizzle.select().from(integrations).where(eq(integrations.kind, 'whatsapp'));
  const normalised = toPhone.replace(/\D/g, '');
  for (const row of rows) {
    const cfg = (row.publicConfig ?? {}) as any;
    if (String(cfg.displayPhoneNumber ?? '').replace(/\D/g, '') === normalised) return row.restaurantId;
    if (String(cfg.phoneNumberId ?? '') === toPhone) return row.restaurantId;
  }
  return null;
}

export async function defaultLocation(restaurantId: string): Promise<string> {
  const db = await getDb();
  const [loc] = await db.drizzle.select().from(locations)
    .where(and(eq(locations.restaurantId, restaurantId), eq(locations.isActive, true)))
    .limit(1);
  if (!loc) throw new Error(`restaurant ${restaurantId} has no active location`);
  return loc.id;
}

export type IngestResult = {
  accepted: number;
  duplicates: number;
  correlationIds: string[];
};

/**
 * Step 1 (fast path, runs inside the webhook): persist and enqueue.
 * Returns without calling the AI so the webhook can answer in milliseconds.
 */
export async function ingestInbound(
  restaurantId: string, messages: InboundMessage[],
): Promise<IngestResult> {
  const result: IngestResult = { accepted: 0, duplicates: 0, correlationIds: [] };

  for (const message of messages) {
    const correlationId = newCorrelationId();
    const scope = systemScope(restaurantId, correlationId);
    const locationId = await defaultLocation(restaurantId);

    const { id: customerId } = await findOrCreateCustomer(scope, message.from, message.profileName ?? null);
    const conversation = await findOrCreateConversation(scope, { customerId, locationId });

    const { messageId, duplicate } = await recordInbound(scope, {
      conversationId: conversation.id,
      body: message.kind === 'TEXT' || message.kind === 'INTERACTIVE' ? (message.text ?? '') : '',
      providerMessageId: message.providerMessageId,
      kind: message.kind === 'AUDIO' ? 'AUDIO' : message.kind === 'IMAGE' ? 'IMAGE' : 'TEXT',
    });

    if (duplicate) {
      result.duplicates++;
      log.info('duplicate inbound ignored', { providerMessageId: message.providerMessageId, restaurantId });
      continue;
    }

    if (message.kind === 'AUDIO' && message.mediaId) {
      const db = await getDb();
      await db.drizzle.insert(voiceMessages).values({
        id: newId('voi'), restaurantId, conversationMessageId: messageId,
        providerMediaId: message.mediaId, status: 'PENDING',
      });
      await emit({
        name: 'customer.voice.received', restaurantId,
        payload: { conversationId: conversation.id, messageId, mediaId: message.mediaId },
        correlationId,
      });
    } else {
      await emit({
        name: 'customer.message.received', restaurantId,
        payload: { conversationId: conversation.id, messageId, text: message.text ?? '' },
        correlationId,
      });
    }

    await enqueue('handle_inbound_message', {
      restaurantId, locationId, customerId,
      conversationId: conversation.id, messageId,
      kind: message.kind, mediaId: message.mediaId ?? null,
      text: message.text ?? '',
    }, { correlationId });

    result.accepted++;
    result.correlationIds.push(correlationId);
  }
  return result;
}

/**
 * Step 2 (background): transcribe if needed, run the agent, send the replies.
 * Registered as a queue handler so retries and backoff come for free.
 */
export async function handleInboundMessage(
  payload: {
    restaurantId: string; locationId: string; customerId: string;
    conversationId: string; messageId: string;
    kind: string; mediaId: string | null; text: string;
  },
  ctx: { correlationId: string },
): Promise<void> {
  const db = await getDb();
  const scope = systemScope(payload.restaurantId, ctx.correlationId);

  await touchInteraction(scope, payload.customerId);

  // Staff has taken the conversation — the AI must stay out of the way.
  const conversation = await getConversation(scope, payload.conversationId);
  if (conversation?.handledBy === 'STAFF') {
    log.info('conversation handled by staff; AI standing down', {
      conversationId: payload.conversationId, correlationId: ctx.correlationId,
    });
    return;
  }

  let text = payload.text;
  let transcriptionConfidence: number | undefined;

  if (payload.kind === 'AUDIO' && payload.mediaId) {
    const provider = await messagingFor(payload.restaurantId);
    const media = await provider.downloadMedia(payload.mediaId);

    if (!media) {
      await sendReply(scope, payload, `Sorry, I couldn't open that voice note. Could you type your order instead?`);
      await db.drizzle.update(voiceMessages)
        .set({ status: 'FAILED', error: 'media download failed' })
        .where(eq(voiceMessages.providerMediaId, payload.mediaId));
      return;
    }

    const transcript = await transcribeVoice(media.bytes, media.mimeType, payload.mediaId);
    if (!transcript || !transcript.text.trim()) {
      await sendReply(scope, payload, `Sorry, I couldn't make out that voice note. Could you type your order?`);
      await db.drizzle.update(voiceMessages)
        .set({ status: 'FAILED', error: 'empty transcript' })
        .where(eq(voiceMessages.providerMediaId, payload.mediaId));
      return;
    }

    text = transcript.text;
    transcriptionConfidence = transcript.confidence;

    await db.drizzle.update(voiceMessages).set({
      transcript: transcript.text, detectedLanguage: transcript.language,
      confidence: transcript.confidence, status: 'DONE',
    }).where(eq(voiceMessages.providerMediaId, payload.mediaId));

    // Keep the transcript on the message so the console conversation reads naturally.
    await db.drizzle.update(conversationMessages)
      .set({ body: transcript.text })
      .where(eq(conversationMessages.id, payload.messageId));
  }

  const output = await runOrderAgent({
    scope,
    customerId: payload.customerId,
    locationId: payload.locationId,
    conversationId: payload.conversationId,
    text,
    channel: payload.kind === 'AUDIO' ? 'WHATSAPP_VOICE' : 'WHATSAPP_TEXT',
    transcriptionConfidence,
  });

  // runOrderAgent already persisted the outbound rows; now actually transmit them.
  const provider = await messagingFor(payload.restaurantId);
  const [customer] = await db.execute(
    `SELECT phone_e164 FROM customers WHERE id = $1;`, [payload.customerId],
  ).then((r) => r.rows);

  for (const reply of output.replies) {
    const res = await provider.send({
      to: customer.phone_e164, kind: 'TEXT', category: 'TRANSACTIONAL', body: reply,
    });
    if (!res.ok && res.retryable) {
      throw new Error(`whatsapp send failed (retryable): ${res.error}`);
    }
  }

  log.info('inbound handled', {
    intent: output.intent, confidence: output.confidence, escalated: output.escalated,
    usedFallback: output.usedFallback, correlationId: ctx.correlationId,
  });
}

async function sendReply(
  scope: TenantScope,
  payload: { restaurantId: string; conversationId: string; customerId: string },
  body: string,
): Promise<void> {
  const db = await getDb();
  const provider = await messagingFor(payload.restaurantId);
  const { rows } = await db.execute(`SELECT phone_e164 FROM customers WHERE id = $1;`, [payload.customerId]);
  const phone = rows[0]?.phone_e164;
  if (!phone) return;

  const res = await provider.send({ to: phone, kind: 'TEXT', category: 'TRANSACTIONAL', body });
  await recordOutbound(scope, {
    conversationId: payload.conversationId, body,
    providerMessageId: res.ok ? res.providerMessageId : null,
    authorType: 'SYSTEM',
  });
}

/** Called once at boot. */
export function registerInboundHandlers(): void {
  register('handle_inbound_message', handleInboundMessage as any);
}
