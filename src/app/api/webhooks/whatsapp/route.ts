/**
 * WhatsApp Business Platform webhook.
 *
 * GET  — Meta's subscription handshake (hub.challenge).
 * POST — inbound messages and delivery statuses.
 *
 * Contract we must honour:
 *  1. Verify X-Hub-Signature-256 over the RAW body before parsing anything.
 *  2. Answer 200 fast. Meta retries on timeout, which would duplicate orders.
 *  3. Be idempotent — the unique index on provider_message_id is the backstop.
 */
import { NextResponse } from 'next/server';
import { verifyWhatsappSignature } from '../../../../lib/crypto';
import { log } from '../../../../lib/log';
import { parseMetaWebhook } from '../../../../server/messaging/meta-cloud';
import { ingestInbound, restaurantForBusinessNumber } from '../../../../server/messaging/inbound';
import { appSecretFor } from '../../../../server/messaging/registry';
import { drain } from '../../../../server/queue/queue';
import { bootstrap } from '../../../../server/bootstrap';
import { getDb } from '../../../../db/client';
import { rateLimit, clientKey } from '../../../../server/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected) {
    return new NextResponse(challenge ?? '', { status: 200 });
  }
  log.warn('whatsapp webhook verification failed', { mode });
  return new NextResponse('Forbidden', { status: 403 });
}

export async function POST(request: Request): Promise<NextResponse> {
  bootstrap();

  if (!rateLimit(clientKey(request, 'wa-webhook'), 600, 60_000)) {
    return new NextResponse('Too Many Requests', { status: 429 });
  }

  // Read the RAW body — the signature is over these exact bytes.
  const raw = await request.text();

  let parsedBody: any;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const displayPhone: string =
    parsedBody?.entry?.[0]?.changes?.[0]?.value?.metadata?.display_phone_number ?? '';
  const restaurantId = await restaurantForBusinessNumber(`+${displayPhone.replace(/\D/g, '')}`);

  if (!restaurantId) {
    // Unknown number: acknowledge so Meta stops retrying, but do nothing.
    log.warn('webhook for unknown business number', { displayPhone });
    return new NextResponse('OK', { status: 200 });
  }

  const appSecret = await appSecretFor(restaurantId);
  const signature = request.headers.get('x-hub-signature-256');

  // A configured secret means the signature is mandatory. No secret configured
  // (local/demo) means we accept, and we say so loudly in the log.
  if (appSecret) {
    if (!verifyWhatsappSignature(raw, signature, appSecret)) {
      log.error('whatsapp webhook signature rejected', { restaurantId });
      return new NextResponse('Unauthorized', { status: 401 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    log.error('refusing unsigned webhook in production', { restaurantId });
    return new NextResponse('Unauthorized', { status: 401 });
  } else {
    log.warn('accepting unsigned webhook (no app secret configured)', { restaurantId });
  }

  const { messages, statuses } = parseMetaWebhook(parsedBody);

  try {
    if (messages.length) await ingestInbound(restaurantId, messages);
    if (statuses.length) await recordStatuses(restaurantId, statuses);
  } catch (err: any) {
    // Still return 200: the message is persisted or it is not, and a retry storm
    // helps nobody. The error is logged with the restaurant for triage.
    log.error('webhook ingest failed', { restaurantId, error: err?.message });
  }

  // In a single-process deployment the worker runs inline; with a separate
  // worker process (WORKER_MODE=external) this returns immediately instead.
  if (process.env.WORKER_MODE !== 'external') {
    void drain().catch((err) => log.error('inline drain failed', { error: err?.message }));
  }

  return new NextResponse('OK', { status: 200 });
}

async function recordStatuses(
  restaurantId: string,
  statuses: Array<{ providerMessageId: string; status: string; timestamp: Date; error?: string }>,
): Promise<void> {
  const db = await getDb();
  for (const s of statuses) {
    await db.execute(
      `UPDATE campaign_messages
       SET status = $1,
           delivered_at = CASE WHEN $1 = 'DELIVERED' THEN $2 ELSE delivered_at END,
           read_at      = CASE WHEN $1 = 'READ'      THEN $2 ELSE read_at END,
           error = $3
       WHERE restaurant_id = $4 AND provider_message_id = $5;`,
      [s.status.toUpperCase(), s.timestamp.toISOString(), s.error ?? '', restaurantId, s.providerMessageId],
    );
  }
}
