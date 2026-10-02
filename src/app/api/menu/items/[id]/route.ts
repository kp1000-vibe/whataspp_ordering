import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json, readJson } from '../../../../../server/http';
import { updateMenuItem } from '../../../../../server/menu/admin';

export const runtime = 'nodejs';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { scope, user } = await requireScope();
    const { id } = await context.params;
    return json({ item: await updateMenuItem(scope, id, await readJson(request), user.userId) });
  } catch (err) {
    return errorResponse(err);
  }
}
