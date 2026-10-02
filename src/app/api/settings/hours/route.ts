import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json, readJson } from '../../../../server/http';
import { setHours } from '../../../../server/settings/service';

export const runtime = 'nodejs';

export async function PUT(request: Request): Promise<NextResponse> {
  try {
    const { scope, user } = await requireScope();
    return json(await setHours(scope, await readJson(request), user.userId));
  } catch (err) {
    return errorResponse(err);
  }
}
