import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../server/http';
import { listOrders, expireStaleDrafts } from '../../../server/orders/service';

const sweeps = new Map<string, number>();
import type { OrderStatus } from '../../../server/orders/state-machine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    // The dashboard polls this every few seconds, so it doubles as the expiry
    // sweep for abandoned drafts (throttled to once a minute per restaurant).
    const last = sweeps.get(scope.restaurantId) ?? 0;
    if (Date.now() - last > 60_000) {
      sweeps.set(scope.restaurantId, Date.now());
      await expireStaleDrafts(scope, { olderThanMinutes: 60 }).catch(() => {});
    }
    const url = new URL(request.url);
    const statuses = url.searchParams.get('status')?.split(',').filter(Boolean) as OrderStatus[] | undefined;
    const limit = Number(url.searchParams.get('limit') ?? 100);

    const orders = await listOrders(scope, { statuses: statuses?.length ? statuses : undefined, limit });
    return json({ orders });
  } catch (err) {
    return errorResponse(err);
  }
}
