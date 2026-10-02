import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json, readJson } from '../../../../server/http';
import { createMenuItem } from '../../../../server/menu/admin';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { scope, user } = await requireScope();
    return json({ item: await createMenuItem(scope, await readJson(request), user.userId) }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
