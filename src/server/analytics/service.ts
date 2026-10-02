/**
 * Analytics. Every number here is computed from the database — nothing is
 * estimated, inferred by a model, or cached into staleness.
 *
 * The headline operational metric is AI CONTAINMENT: the share of customer
 * conversations the assistant handled with no staff involvement. That is the
 * number that says whether the product is doing its job.
 */
import { getDb } from '../../db/client';
import type { TenantScope } from '../tenancy';
import { now as clockNow } from '../../lib/clock';

export type DashboardStats = {
  ordersToday: number;
  revenueTodayCents: number;
  averageOrderCents: number;
  activeOrders: number;
  readyForPickup: number;
  cancelledToday: number;
  newCustomersToday: number;
  repeatCustomerShare: number;
  averagePrepMinutes: number;
  averagePickupDelayMinutes: number;
  aiContainmentRate: number;
  humanHandoffRate: number;
  clarificationRate: number;
  voiceOrderShare: number;
  staffInteractionsAvoided: number;
};

export async function dashboardStats(scope: TenantScope, timezone: string): Promise<DashboardStats> {
  const db = await getDb();
  const r = scope.restaurantId;

  /**
   * "Orders today" = orders customers confirmed today that were not cancelled —
   * including the ones still in the kitchen. Revenue counts only orders handed
   * over, because pay-at-pickup money is not real until pickup (eval B23).
   */
  const { rows: today } = await db.execute(
    `SELECT
       count(*) FILTER (WHERE confirmed_at IS NOT NULL AND status NOT IN ('CANCELLED','REJECTED','EXPIRED'))::int AS orders_today,
       count(*) FILTER (WHERE status IN ('PICKED_UP','COMPLETED'))::int AS completed_today,
       COALESCE(sum(total_cents) FILTER (WHERE status IN ('PICKED_UP','COMPLETED')),0)::int AS revenue_today,
       count(*) FILTER (WHERE status IN ('CANCELLED','REJECTED'))::int AS cancelled_today,
       count(*) FILTER (WHERE status IN ('RECEIVED','ACCEPTED','PREPARING'))::int AS active_orders,
       count(*) FILTER (WHERE status = 'READY')::int AS ready_orders,
       count(*) FILTER (WHERE channel = 'WHATSAPP_VOICE' AND confirmed_at IS NOT NULL
                         AND status NOT IN ('CANCELLED','REJECTED','EXPIRED'))::int AS voice_orders
     FROM orders
     WHERE restaurant_id = $1
       AND (COALESCE(confirmed_at, created_at) AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date;`,
    [r, timezone, clockNow().toISOString()],
  );
  const t = today[0] ?? {};

  const { rows: prep } = await db.execute(
    `SELECT
       COALESCE(avg(EXTRACT(EPOCH FROM (h_ready.created_at - h_start.created_at)) / 60), 0)::float AS avg_prep,
       COALESCE(avg(EXTRACT(EPOCH FROM (h_ready.created_at - o.promised_ready_at)) / 60), 0)::float AS avg_delay
     FROM orders o
     JOIN order_status_history h_start ON h_start.order_id = o.id AND h_start.to_status = 'PREPARING'
     JOIN order_status_history h_ready ON h_ready.order_id = o.id AND h_ready.to_status = 'READY'
     WHERE o.restaurant_id = $1 AND o.created_at > now() - interval '30 days';`,
    [r],
  );

  const { rows: customersRows } = await db.execute(
    `SELECT
       count(*) FILTER (WHERE (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date)::int AS new_today,
       count(*) FILTER (WHERE total_orders > 1)::int AS repeat_customers,
       count(*)::int AS total_customers
     FROM customers WHERE restaurant_id = $1;`,
    [r, timezone],
  );
  const c = customersRows[0] ?? {};

  /* AI containment: chats the assistant finished with NO human involvement.
     A chat counts as handed off if staff wrote in it, staff currently hold it,
     or the assistant escalated it — even if nobody has replied yet (eval B21). */
  const { rows: containment } = await db.execute(
    `WITH conv AS (
       SELECT c.id, c.handled_by,
              count(m.id) FILTER (WHERE m.author_type = 'AI')::int    AS ai_msgs,
              count(m.id) FILTER (WHERE m.author_type = 'STAFF')::int AS staff_msgs,
              EXISTS (SELECT 1 FROM domain_events e
                      WHERE e.restaurant_id = c.restaurant_id AND e.name = 'conversation.escalated'
                        AND e.payload->>'conversationId' = c.id) AS escalated
       FROM conversations c
       LEFT JOIN conversation_messages m ON m.conversation_id = c.id
       WHERE c.restaurant_id = $1 AND c.created_at > now() - interval '30 days'
       GROUP BY c.id, c.handled_by, c.restaurant_id
     )
     SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE ai_msgs > 0 AND staff_msgs = 0 AND handled_by = 'AI' AND NOT escalated)::int AS contained,
       count(*) FILTER (WHERE staff_msgs > 0 OR handled_by = 'STAFF' OR escalated)::int AS handed_off
     FROM conv;`,
    [r],
  );
  const cm = containment[0] ?? { total: 0, contained: 0, handed_off: 0 };

  const { rows: clarif } = await db.execute(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE status = 'CLARIFICATION_REQUIRED' OR ai_confidence < 0.62)::int AS clarified
     FROM orders WHERE restaurant_id = $1 AND created_at > now() - interval '30 days';`,
    [r],
  );
  const cl = clarif[0] ?? { total: 0, clarified: 0 };

  /* Staff interactions avoided: inbound customer messages the AI answered.
     Each one is a phone call or counter conversation that did not happen. */
  const { rows: avoided } = await db.execute(
    `SELECT count(*)::int AS n FROM conversation_messages
     WHERE restaurant_id = $1 AND direction = 'INBOUND'
       AND conversation_id IN (SELECT id FROM conversations WHERE restaurant_id = $1 AND handled_by = 'AI');`,
    [r],
  );

  const ordersToday = Number(t.orders_today ?? 0);
  const completedToday = Number(t.completed_today ?? 0);
  const revenueToday = Number(t.revenue_today ?? 0);

  return {
    ordersToday,
    revenueTodayCents: revenueToday,
    averageOrderCents: completedToday ? Math.round(revenueToday / completedToday) : 0,
    activeOrders: Number(t.active_orders ?? 0),
    readyForPickup: Number(t.ready_orders ?? 0),
    cancelledToday: Number(t.cancelled_today ?? 0),
    newCustomersToday: Number(c.new_today ?? 0),
    repeatCustomerShare: Number(c.total_customers) ? Number(c.repeat_customers) / Number(c.total_customers) : 0,
    averagePrepMinutes: Math.round(Number(prep[0]?.avg_prep ?? 0)),
    averagePickupDelayMinutes: Math.round(Number(prep[0]?.avg_delay ?? 0)),
    aiContainmentRate: Number(cm.total) ? Number(cm.contained) / Number(cm.total) : 0,
    humanHandoffRate: Number(cm.total) ? Number(cm.handed_off) / Number(cm.total) : 0,
    clarificationRate: Number(cl.total) ? Number(cl.clarified) / Number(cl.total) : 0,
    voiceOrderShare: ordersToday ? Number(t.voice_orders ?? 0) / ordersToday : 0,
    staffInteractionsAvoided: Number(avoided[0]?.n ?? 0),
  };
}

export async function topItems(scope: TenantScope, days = 30, limit = 10) {
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT oi.name_snapshot AS name, sum(oi.quantity)::int AS units,
            sum(oi.line_total_cents)::int AS revenue_cents
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1 AND o.status IN ('PICKED_UP','COMPLETED')
       AND o.created_at > now() - ($2 || ' days')::interval
     GROUP BY oi.name_snapshot ORDER BY units DESC LIMIT ${Math.min(50, limit)};`,
    [scope.restaurantId, String(days)],
  );
  return rows as Array<{ name: string; units: number; revenue_cents: number }>;
}

/** Orders per hour of the local day — this is what drives capacity planning. */
export async function peakHours(scope: TenantScope, timezone: string, days = 30) {
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE $2)::int AS hour, count(*)::int AS orders
     FROM orders
     WHERE restaurant_id = $1 AND status IN ('PICKED_UP','COMPLETED')
       AND created_at > now() - ($3 || ' days')::interval
     GROUP BY hour ORDER BY hour;`,
    [scope.restaurantId, timezone, String(days)],
  );
  return rows as Array<{ hour: number; orders: number }>;
}

export async function aiCostSummary(scope: TenantScope, days = 30) {
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT provider, model,
            count(*)::int AS calls,
            COALESCE(sum(prompt_tokens),0)::int AS prompt_tokens,
            COALESCE(sum(completion_tokens),0)::int AS completion_tokens,
            COALESCE(sum(cost_micro_usd),0)::int AS cost_micro_usd,
            COALESCE(avg(latency_ms),0)::int AS avg_latency_ms,
            count(*) FILTER (WHERE escalated)::int AS escalations
     FROM ai_interactions
     WHERE restaurant_id = $1 AND created_at > now() - ($2 || ' days')::interval
     GROUP BY provider, model;`,
    [scope.restaurantId, String(days)],
  );
  return rows;
}

export async function usageForPeriod(scope: TenantScope, period = new Date().toISOString().slice(0, 7)) {
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT metric, value FROM usage_records WHERE restaurant_id = $1 AND period = $2;`,
    [scope.restaurantId, period],
  );
  return Object.fromEntries(rows.map((r: any) => [r.metric, r.value])) as Record<string, number>;
}
