/**
 * In-process eval world: a fresh in-memory Postgres, the SpiceBox demo seed,
 * the real ingestion pipeline and the real agent. Only the WhatsApp transport
 * (MockProvider) and speech-to-text (fixtures) are stand-ins.
 *
 * Fixture decisions (test SETUP, not product behaviour):
 *  - Hours are set to 11:00-23:00 every day so ordinary cases are not
 *    accidentally testing Monday closure. Closed-hours cases set their own.
 *  - The clock is pinned to 19:00 IST on the current IST date. Time still
 *    advances from there.
 */
process.env.DATABASE_URL = 'pglite://memory';
process.env.AI_PROVIDER = 'deterministic';
process.env.MESSAGING_PROVIDER = 'mock';
process.env.STT_PROVIDER = 'mock';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

import { getDb, resetDbCache } from '../src/db/client';
import { seed } from '../scripts/seed';
import { bootstrap } from '../src/server/bootstrap';
import { systemScope, type TenantScope } from '../src/server/tenancy';
import { correlationId } from '../src/lib/ids';
import { setClock } from '../src/lib/clock';
import { MockProvider } from '../src/server/messaging/mock';
import { mockProviderFor, resetMocks } from '../src/server/messaging/registry';
import { ingestInbound } from '../src/server/messaging/inbound';
import { drain } from '../src/server/queue/queue';
import { setVoiceFixture, clearVoiceFixtures } from '../src/server/stt/registry';
import { getOrder, transition, type OrderView } from '../src/server/orders/service';
import { getMenu, type ResolvedItem } from '../src/server/menu/service';
import type { T } from './harness';

export { TZ, istAt, daysUntil } from './time';
import { istAt } from './time';
export const BUSINESS = '+919999000001';

export type Line = { item: string; qty: number; mods: string[] };

export type World = Awaited<ReturnType<typeof freshWorld>>;

let phoneCounter = 0;
export function newPhone(): string {
  phoneCounter++;
  return `+9198700${String(10000 + phoneCounter).slice(-5)}`;
}

export async function freshWorld(opts: { clock?: Date | null; openAllWeek?: boolean } = {}) {
  await resetDbCache();
  resetMocks();
  clearVoiceFixtures();
  setClock(opts.clock === undefined ? istAt(19, 0) : opts.clock);

  const { restaurantId, locationId } = await seed();
  bootstrap({ force: true });

  const db = await getDb();
  if (opts.openAllWeek !== false) {
    await db.execute(
      `UPDATE business_hours SET is_closed = false, open_minute = 660, close_minute = 1380 WHERE restaurant_id = $1;`,
      [restaurantId],
    );
  }

  const scope: TenantScope = systemScope(restaurantId, correlationId());
  const mock: MockProvider = mockProviderFor(restaurantId);

  async function repliesDuring(phone: string, action: () => Promise<unknown>): Promise<string> {
    const before = mock.outbox.length;
    await action();
    await drain();
    // Under concurrency another caller's drain() may be the one processing THIS
    // customer's job. Wait until nothing runnable is left before reading replies.
    // (Harness fix after baseline — see integrity report.)
    for (let i = 0; i < 250; i++) {
      const { rows } = await db.execute(
        `SELECT count(*)::int AS n FROM jobs WHERE status IN ('PENDING','RUNNING') AND run_at <= now();`);
      if (rows[0].n === 0) break;
      await drain();
      await new Promise((r) => setTimeout(r, 20));
    }
    return mock.outbox.slice(before)
      .filter((m) => m.to === phone)
      .map((m) => (m.kind === 'TEXT' ? m.body : m.preview))
      .join('\n---\n');
  }

  const world = {
    db, scope, restaurantId, locationId, mock,

    /** Customer sends a WhatsApp text through the real webhook-ingestion path. */
    say(phone: string, text: string): Promise<string> {
      return repliesDuring(phone, async () => {
        const body = MockProvider.inboundTextBody({ from: phone, to: BUSINESS, text, name: 'Eval Customer' });
        await ingestInbound(restaurantId, mock.parseWebhook(body).messages);
      });
    },

    /** Customer sends a voice note whose (simulated) transcript is `transcript`. */
    voice(phone: string, transcript: string | null, confidence = 0.9): Promise<string> {
      const mediaId = `media_${Math.random().toString(36).slice(2)}`;
      if (transcript !== null) setVoiceFixture(mediaId, transcript, { confidence });
      return repliesDuring(phone, async () => {
        const body = MockProvider.inboundAudioBody({ from: phone, to: BUSINESS, mediaId });
        await ingestInbound(restaurantId, mock.parseWebhook(body).messages);
      });
    },

    /** Customer sends an image. */
    image(phone: string): Promise<string> {
      return repliesDuring(phone, async () => {
        const body: any = MockProvider.inboundTextBody({ from: phone, to: BUSINESS, text: '' });
        body.entry[0].changes[0].value.messages[0] = {
          from: phone.replace('+', ''), id: `wamid.img${Math.random().toString(36).slice(2)}`,
          timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'IMG1' },
        };
        await ingestInbound(restaurantId, mock.parseWebhook(body).messages);
      });
    },

    /** Replies sent to this phone as a side effect of `action` (e.g. a staff status change). */
    repliesDuring,

    async customerId(phone: string): Promise<string | null> {
      const { rows } = await db.execute(
        `SELECT id FROM customers WHERE restaurant_id = $1 AND phone_e164 = $2;`, [restaurantId, phone]);
      return rows[0]?.id ?? null;
    },

    /** Most recent order of any status for this customer. */
    async latestOrder(phone: string): Promise<OrderView | null> {
      const { rows } = await db.execute(
        `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
         WHERE o.restaurant_id = $1 AND c.phone_e164 = $2
         ORDER BY o.created_at DESC, o.order_number DESC LIMIT 1;`,
        [restaurantId, phone]);
      return rows[0] ? getOrder(scope, rows[0].id) : null;
    },

    async ordersFor(phone: string): Promise<OrderView[]> {
      const { rows } = await db.execute(
        `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
         WHERE o.restaurant_id = $1 AND c.phone_e164 = $2 ORDER BY o.order_number;`,
        [restaurantId, phone]);
      return Promise.all(rows.map((r: any) => getOrder(scope, r.id) as Promise<OrderView>));
    },

    async menu(): Promise<ResolvedItem[]> {
      return getMenu(scope, locationId);
    },

    async itemId(name: string): Promise<string> {
      const item = (await getMenu(scope, locationId)).find((i) => i.name === name);
      if (!item) throw new Error(`fixture: no menu item "${name}"`);
      return item.id;
    },

    async staff(orderId: string, to: any): Promise<OrderView> {
      return transition(scope, { orderId, to, actor: { type: 'STAFF', id: null } });
    },

    async conversationFor(phone: string): Promise<any> {
      const { rows } = await db.execute(
        `SELECT cv.* FROM conversations cv JOIN customers c ON c.id = cv.customer_id
         WHERE cv.restaurant_id = $1 AND c.phone_e164 = $2 ORDER BY cv.updated_at DESC LIMIT 1;`,
        [restaurantId, phone]);
      return rows[0] ?? null;
    },
  };
  return world;
}

/** Order lines as a sorted, merged multiset so comparisons ignore line order. */
export function linesOf(order: OrderView | null): Line[] {
  if (!order) return [];
  const merged = new Map<string, Line>();
  for (const i of order.items) {
    const mods = i.modifiers.map((m) => m.name).sort();
    const key = `${i.name}|${mods.join(',')}`;
    const existing = merged.get(key);
    if (existing) existing.qty += i.quantity;
    else merged.set(key, { item: i.name, qty: i.quantity, mods });
  }
  return [...merged.values()].sort((a, b) =>
    a.item.localeCompare(b.item) || a.mods.join(',').localeCompare(b.mods.join(',')));
}

export function L(item: string, qty: number, mods: string[] = []): Line {
  return { item, qty, mods: [...mods].sort() };
}

export function sortLines(lines: Line[]): Line[] {
  return [...lines].sort((a, b) =>
    a.item.localeCompare(b.item) || a.mods.join(',').localeCompare(b.mods.join(',')));
}

/** Asserts the customer's latest order is confirmable and has exactly these lines. */
export async function expectDraft(t: T, w: World, phone: string, expected: Line[]): Promise<OrderView | null> {
  const order = await w.latestOrder(phone);
  t.eq(order?.status ?? null, 'READY_FOR_CONFIRMATION', 'draft is ready for confirmation');
  t.eq(linesOf(order), sortLines(expected), 'order lines');
  return order;
}

/** Asserts no priceable order was produced for this customer. */
export async function expectNoPriceableOrder(t: T, w: World, phone: string): Promise<void> {
  const orders = await w.ordersFor(phone);
  const priceable = orders.filter((o) =>
    ['READY_FOR_CONFIRMATION', 'CONFIRMED', 'RECEIVED', 'ACCEPTED', 'PREPARING', 'READY'].includes(o.status));
  t.eq(priceable.length, 0, 'no priceable order was created');
}
