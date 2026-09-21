import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../../server/http';
import { setAvailability } from '../../../../server/menu/service';
import { requireRole } from '../../../../server/tenancy';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    requireRole(scope, 'STAFF');   // kitchen staff must not silently change the menu
    const body = await request.json();

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
