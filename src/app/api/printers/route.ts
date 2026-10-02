import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json, readJson } from '../../../server/http';
import { NotFoundError } from '../../../server/errors';
import { getDb } from '../../../db/client';
import { locations } from '../../../db/schema';
import { and, eq } from 'drizzle-orm';
import { printerHealth, createPrinter } from '../../../server/printing/service';
import { requireRole } from '../../../server/tenancy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    return json({ printers: await printerHealth(scope) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Creating a printer returns its agent token ONCE — only the hash is stored. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    requireRole(scope, 'MANAGER');
    const body = await readJson(request);
    const db = await getDb();
    const [loc] = await db.drizzle.select().from(locations)
      .where(and(eq(locations.restaurantId, scope.restaurantId), eq(locations.id, String(body.locationId ?? '')))).limit(1);
    if (!loc) throw new NotFoundError('Location not found.');

    const result = await createPrinter(scope, {
      locationId: String(body.locationId),
      name: String(body.name ?? 'Kitchen printer'),
      kind: body.kind, transport: body.transport,
      paperWidthChars: body.paperWidthChars != null ? Number(body.paperWidthChars) : undefined,
      copies: body.copies != null ? Number(body.copies) : undefined,
      networkHost: body.networkHost, networkPort: body.networkPort,
    });
    return json({
      ...result,
      note: 'Save this token now — it is shown once and only its hash is stored.',
    });
  } catch (err) {
    return errorResponse(err);
  }
}
