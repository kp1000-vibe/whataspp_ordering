import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../server/http';
import { getDb } from '../../../db/client';
import { restaurants } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** What the console needs to render correctly: currency and timezone come from HERE, never a hard-coded default. */
export async function GET(): Promise<NextResponse> {
  try {
    const { scope, user } = await requireScope();
    const db = await getDb();
    const [r] = await db.drizzle.select().from(restaurants).where(eq(restaurants.id, scope.restaurantId)).limit(1);
    return json({
      user: { name: user.name, email: user.email },
      role: scope.role,
      restaurant: { id: r.id, name: r.name, currency: r.currency, timezone: r.timezone, taxRateBps: r.taxRateBps },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
