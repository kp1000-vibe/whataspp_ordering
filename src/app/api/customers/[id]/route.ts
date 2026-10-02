import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json } from '../../../../server/http';
import { eraseCustomer } from '../../../../server/crm/service';
import { requireRole } from '../../../../server/tenancy';

export const runtime = 'nodejs';

/** GDPR/CCPA erasure. Managers only; audited by the consent change it records. */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    requireRole(scope, 'MANAGER');
    const { id } = await context.params;
    await eraseCustomer(scope, id);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
