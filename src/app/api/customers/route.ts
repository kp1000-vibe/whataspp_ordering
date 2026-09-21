import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../server/http';
import { listCustomers } from '../../../server/crm/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    const url = new URL(request.url);
    const customers = await listCustomers(scope, {
      search: url.searchParams.get('q') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
    });
    return json({ customers });
  } catch (err) {
    return errorResponse(err);
  }
}
