/**
 * Usage metering. Every billable unit — especially outbound WhatsApp messages,
 * which are what Meta charges for — increments a per-month counter.
 */
import { getDb } from '../db/client';

export async function bumpUsage(restaurantId: string | null, metric: string, delta = 1): Promise<void> {
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
}
