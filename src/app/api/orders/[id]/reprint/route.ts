import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../../../server/http';
import { getOrder } from '../../../../../server/orders/service';
import { reprint } from '../../../../../server/printing/service';
import { NotFoundError } from '../../../../../server/errors';

export const runtime = 'nodejs';

/** Any staff member, including the kitchen, can reprint — they are the ones at the printer. */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    const { id } = await context.params;
    if (!(await getOrder(scope, id))) throw new NotFoundError('Order not found.');
    const jobIds = await reprint(scope, id);
    return json({ ok: true, jobIds, note: jobIds.length ? 'Sent to printer.' : 'No printer is configured — the order is visible on screen.' });
  } catch (err) {
    return errorResponse(err);
  }
}
