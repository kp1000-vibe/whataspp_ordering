import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../../../server/http';
import { transition, cancelOrder } from '../../../../../server/orders/service';
import { delayOrder } from '../../../../../server/notifications/customer';
import { bootstrap } from '../../../../../server/bootstrap';
import { drain } from '../../../../../server/queue/queue';
import type { OrderStatus } from '../../../../../server/orders/state-machine';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  bootstrap();
  try {
    const { scope, user } = await requireScope();
    const { id } = await context.params;
    const body = await request.json();

    // "Running late" is a first-class action, not a silent field edit:
    // it always messages the customer.
    if (body.action === 'delay') {
      const result = await delayOrder(scope, id, Number(body.minutes ?? 15), String(body.reason ?? ''));
      await drain();
      return json({ ok: true, newReadyAt: result.newReadyAt });
    }

    if (body.status === 'CANCELLED') {
      const result = await cancelOrder(
        scope, id, { type: 'STAFF', id: user.userId }, String(body.reason ?? 'cancelled by restaurant'));
      await drain();
      return result.ok ? json({ ok: true, order: result.order }) : json({ error: result.reason }, 409);
    }

    const order = await transition(scope, {
      orderId: id,
      to: String(body.status) as OrderStatus,
      actor: { type: 'STAFF', id: user.userId },
      reason: String(body.reason ?? ''),
    });
    await drain();
    return json({ ok: true, order });
  } catch (err) {
    return errorResponse(err);
  }
}
