/**
 * One place that wires the event handlers and job handlers.
 * Called by the Next.js instrumentation hook, by scripts and by tests.
 * Idempotent: calling it twice does not double-register.
 */
import { resetHandlers, on } from './events/bus';
import { register } from './queue/queue';
import { registerNotificationHandlers } from './notifications/customer';
import { registerPrintHandlers } from './printing/service';
import { registerInboundHandlers } from './messaging/inbound';
import { recomputeCustomerRollups } from './crm/service';
import { systemScope } from './tenancy';
import { getDb } from '../db/client';
import { log } from '../lib/log';

let booted = false;

export function bootstrap(opts: { force?: boolean } = {}): void {
  if (booted && !opts.force) return;
  if (opts.force) resetHandlers();

  registerNotificationHandlers();
  registerPrintHandlers();
  registerInboundHandlers();
  registerCrmHandlers();
  registerUsageHandlers();

  booted = true;
  log.info('bootstrap complete');
}

/** CRM rollups are recomputed from orders whenever an order reaches a terminal state. */
function registerCrmHandlers(): void {
  const recompute = async (e: any) => {
    const db = await getDb();
    const { rows } = await db.execute(`SELECT customer_id FROM orders WHERE id = $1;`, [e.payload.orderId]);
    const customerId = rows[0]?.customer_id;
    if (customerId) {
      await recomputeCustomerRollups(systemScope(e.restaurantId, e.correlationId), customerId);
    }
  };
  on('order.picked_up', recompute, 'crm:rollup');
  on('order.completed', recompute, 'crm:rollup');
  on('order.cancelled', recompute, 'crm:rollup');
  on('order.rejected', recompute, 'crm:rollup');
}

/**
 * Usage metering from day one (spec section 32) — an unmetered plan is an
 * unbounded cost. Every billable event increments a counter for the period.
 */
function registerUsageHandlers(): void {
  const bump = async (restaurantId: string | null, metric: string, delta = 1) => {
    if (!restaurantId) return;
    const db = await getDb();
    const period = new Date().toISOString().slice(0, 7);
    await db.execute(
      `INSERT INTO usage_records (id, organization_id, restaurant_id, period, metric, value)
       SELECT $1, r.organization_id, r.id, $2, $3, $4 FROM restaurants r WHERE r.id = $5
       ON CONFLICT (organization_id, restaurant_id, period, metric)
       DO UPDATE SET value = usage_records.value + EXCLUDED.value;`,
      [`usg_${restaurantId}_${period}_${metric}`, period, metric, delta, restaurantId],
    );
  };

  on('order.confirmed', (e) => bump(e.restaurantId, 'orders'), 'usage:orders');
  on('customer.message.received', (e) => bump(e.restaurantId, 'wa_messages_in'), 'usage:messages');
  on('customer.voice.received', (e) => bump(e.restaurantId, 'voice_messages'), 'usage:voice');
  on('campaign.sent', (e) => bump(e.restaurantId, 'campaigns'), 'usage:campaigns');
}
