import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../server/http';
import { getCapacity, setCapacityState, listSlots } from '../../../server/capacity/slots';
import { requireRole } from '../../../server/tenancy';
import { getDb } from '../../../db/client';
import { locations } from '../../../db/schema';
import { and, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function defaultLocationId(restaurantId: string): Promise<string | null> {
  const db = await getDb();
  const [loc] = await db.drizzle.select().from(locations)
    .where(and(eq(locations.restaurantId, restaurantId), eq(locations.isActive, true))).limit(1);
  return loc?.id ?? null;
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    const url = new URL(request.url);
    const locationId = url.searchParams.get('locationId') ?? (await defaultLocationId(scope.restaurantId));
    if (!locationId) return json({ error: 'No location configured.' }, 404);

    const capacity = await getCapacity(scope, locationId);
    const { slots } = await listSlots(scope, { locationId, menuItemIds: [] });
    return json({ capacity, slots: slots.slice(0, 16) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** The emergency controls: pause, +15, +30, close, reopen. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    requireRole(scope, 'STAFF');
    const body = await request.json();

    const locationId = body.locationId ?? (await defaultLocationId(scope.restaurantId));
    if (!locationId) return json({ error: 'No location configured.' }, 404);

    const capacity = await setCapacityState(scope, String(locationId), {
      state: body.state,
      etaOffsetMinutes: body.etaOffsetMinutes != null ? Number(body.etaOffsetMinutes) : undefined,
      note: body.note != null ? String(body.note) : undefined,
    });
    return json({ ok: true, capacity });
  } catch (err) {
    return errorResponse(err);
  }
}
