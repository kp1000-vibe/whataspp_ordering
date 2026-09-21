import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../server/http';
import { dashboardStats, topItems, peakHours, usageForPeriod, aiCostSummary } from '../../../server/analytics/service';
import { getDb } from '../../../db/client';
import { restaurants } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    const db = await getDb();
    const [restaurant] = await db.drizzle.select().from(restaurants)
      .where(eq(restaurants.id, scope.restaurantId)).limit(1);
    const tz = restaurant?.timezone ?? 'UTC';

    const [stats, items, hours, usage, ai] = await Promise.all([
      dashboardStats(scope, tz),
      topItems(scope, 30, 8),
      peakHours(scope, tz, 30),
      usageForPeriod(scope),
      aiCostSummary(scope),
    ]);
    return json({ stats, topItems: items, peakHours: hours, usage, ai, currency: restaurant?.currency ?? 'USD' });
  } catch (err) {
    return errorResponse(err);
  }
}
