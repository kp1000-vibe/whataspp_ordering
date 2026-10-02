import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json, readJson } from '../../../server/http';
import { getSettings, updateSettings } from '../../../server/settings/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const { scope } = await requireScope();
    return json(await getSettings(scope));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request): Promise<NextResponse> {
  try {
    const { scope, user } = await requireScope();
    return json(await updateSettings(scope, await readJson(request), user.userId));
  } catch (err) {
    return errorResponse(err);
  }
}
