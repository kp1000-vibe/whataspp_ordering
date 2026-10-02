import { NextResponse } from 'next/server';
import { requireScope, errorResponse, json, readJson } from '../../../../server/http';
import { importMenuCsv } from '../../../../server/menu/admin';

export const runtime = 'nodejs';

/** Validates the whole file first; a file with any bad row publishes nothing. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { scope, user } = await requireScope();
    const body = await readJson<{ csv?: string; dryRun?: boolean }>(request);
    const result = await importMenuCsv(scope, String(body.csv ?? ''), { dryRun: !!body.dryRun, userId: user.userId });
    return json(result, result.valid ? 200 : 422);
  } catch (err) {
    return errorResponse(err);
  }
}
