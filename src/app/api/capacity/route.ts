import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json, readJson } from '../../../server/http';
import { getCapacity, setCapacityState, listSlots, type CapacityState } from '../../../server/capacity/slots';
import { requireRole, type TenantScope } from '../../../server/tenancy';
import { ValidationError, NotFoundError } from '../../../server/errors';
import { getDb } from '../../../db/client';
import { locations } from '../../../db/schema';
import { and, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATES: CapacityState[] = ['OPEN', 'BUSY', 'VERY_BUSY', 'PAUSED', 'CLOSED'];

/** A location id from the client is only accepted if it belongs to THIS restaurant. */
async function locationFor(scope: TenantScope, requested?: string | null): Promise<string> {
  const db = await getDb();
  const where = requested
    ? and(eq(locations.restaurantId, scope.restaurantId), eq(locations.id, requested))
    : and(eq(locations.restaurantId, scope.restaurantId), eq(locations.isActive, true));
  const [loc] = await db.drizzle.select().from(locations).where(where).limit(1);
  if (!loc) throw new NotFoundError('Location not found.');
  return loc.id;
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    const locationId = await locationFor(scope, new URL(request.url).searchParams.get('locationId'));
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
    const body = await readJson(request);
    const locationId = await locationFor(scope, body.locationId ?? null);
    if (body.state !== undefined && !STATES.includes(body.state)) throw new ValidationError(`Unknown state "${body.state}".`);
    const offset = body.etaOffsetMinutes;
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0 || offset > 180)) {
      throw new ValidationError('etaOffsetMinutes must be 0-180.');
    }
    const capacity = await setCapacityState(scope, locationId, {
      state: body.state, etaOffsetMinutes: offset, note: body.note != null ? String(body.note).slice(0, 300) : undefined,
    });
    return json({ ok: true, capacity });
  } catch (err) {
    return errorResponse(err);
  }
}
