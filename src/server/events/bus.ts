/**
 * Append-only domain event log + in-process subscriber fan-out.
 *
 * Every event is persisted BEFORE handlers run, so a crash in a handler never
 * loses the fact that the thing happened. Handler failures are logged and
 * isolated — one bad subscriber cannot break order confirmation.
 */
import { getDb } from '../../db/client';
import { domainEvents } from '../../db/schema';
import { newId } from '../../lib/ids';
import { log } from '../../lib/log';

export type EventName =
  | 'customer.message.received'
  | 'customer.voice.received'
  | 'customer.created'
  | 'customer.consent.changed'
  | 'customer.segment.changed'
  | 'order.created'
  | 'order.confirmed'
  | 'order.received'
  | 'order.accepted'
  | 'order.started'
  | 'order.ready'
  | 'order.picked_up'
  | 'order.completed'
  | 'order.cancelled'
  | 'order.rejected'
  | 'conversation.escalated'
  | 'campaign.created'
  | 'campaign.approved'
  | 'campaign.sent'
  | 'printer.job.created'
  | 'printer.job.failed'
  | 'printer.job.printed'
  | 'ai.low_confidence';

export type DomainEvent<T = Record<string, unknown>> = {
  name: EventName;
  restaurantId: string | null;
  payload: T;
  correlationId: string;
};

type Handler = (e: DomainEvent) => Promise<void> | void;

/**
 * Keyed so registration is IDEMPOTENT. Registering the same key twice replaces
 * rather than appends. Without this, anything that re-runs bootstrap — a dev
 * hot-reload, a re-entrant import, a retried serverless cold start — silently
 * doubles every customer notification. We hit exactly that in testing.
 */
const handlers = new Map<EventName, Map<string, Handler>>();

export function on(name: EventName, handler: Handler, key?: string): void {
  const map = handlers.get(name) ?? new Map<string, Handler>();
  map.set(key ?? handler.name ?? `anon:${map.size}`, handler);
  handlers.set(name, map);
}

export function handlerCount(name: EventName): number {
  return handlers.get(name)?.size ?? 0;
}

/** Test/bootstrap helper — clears all subscribers. */
export function resetHandlers(): void {
  handlers.clear();
}

export async function emit(event: DomainEvent): Promise<void> {
  const db = await getDb();
  await db.drizzle.insert(domainEvents).values({
    id: newId('evt'),
    restaurantId: event.restaurantId,
    name: event.name,
    payload: event.payload as Record<string, unknown>,
    correlationId: event.correlationId,
  });

  for (const handler of handlers.get(event.name)?.values() ?? []) {
    try {
      await handler(event);
    } catch (err: any) {
      log.error('event handler failed', {
        event: event.name, correlationId: event.correlationId, error: err?.message,
      });
    }
  }
}
