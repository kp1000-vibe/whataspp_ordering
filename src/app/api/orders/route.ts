import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../server/http';
import { listOrders } from '../../../server/orders/service';
import type { OrderStatus } from '../../../server/orders/state-machine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    const url = new URL(request.url);
    const statuses = url.searchParams.get('status')?.split(',').filter(Boolean) as OrderStatus[] | undefined;
    const limit = Number(url.searchParams.get('limit') ?? 100);

    const orders = await listOrders(scope, { statuses: statuses?.length ? statuses : undefined, limit });
    return json({ orders });
  } catch (err) {
    return errorResponse(err);
  }
}
