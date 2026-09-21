import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../server/http';
import { getMenu } from '../../../server/menu/service';
import { getDb } from '../../../db/client';
import { locations } from '../../../db/schema';
import { eq, and } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    const url = new URL(request.url);
    let locationId = url.searchParams.get('locationId');

    if (!locationId) {
      const db = await getDb();
      const [loc] = await db.drizzle.select().from(locations)
        .where(and(eq(locations.restaurantId, scope.restaurantId), eq(locations.isActive, true))).limit(1);
      locationId = loc?.id ?? null;
    }
    if (!locationId) return json({ menu: [] });

    return json({ menu: await getMenu(scope, locationId), locationId });
  } catch (err) {
    return errorResponse(err);
  }
}
