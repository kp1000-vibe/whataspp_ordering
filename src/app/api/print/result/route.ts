import { NextResponse } from 'next/server';
import { reportJobResult } from '../../../../server/printing/service';
import { json } from '../../../../server/http';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<NextResponse> {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  try {
    const body = await request.json();
    await reportJobResult(
      String(body.printerId), token, String(body.jobId),
      !!body.ok, String(body.error ?? ''),
    );
    return json({ ok: true });
  } catch {
    return json({ error: 'Authentication failed.' }, 401);
  }
}
