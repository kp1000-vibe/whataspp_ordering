import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json, readJson } from '../../../../server/http';
import { setAvailability } from '../../../../server/menu/service';
import { requireRole } from '../../../../server/tenancy';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    requireRole(scope, 'STAFF');   // kitchen staff must not silently change the menu
    const body = await readJson(request);
    if (!['AVAILABLE', 'SOLD_OUT', 'TEMP_UNAVAILABLE'].includes(body.status)) {
      return json({ error: 'status must be AVAILABLE, SOLD_OUT or TEMP_UNAVAILABLE.' }, 400);
    }

    await setAvailability(
      scope,
      String(body.locationId),
      body.menuItemId ? { menuItemId: String(body.menuItemId) } : { modifierId: String(body.modifierId) },
      body.status,
      String(body.reason ?? ''),
    );
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
