/**
 * Local print agent endpoint. The agent long-polls this with its bearer token;
 * the cloud never initiates a connection into the restaurant network.
 */
import { NextResponse } from 'next/server';
import { claimJobs } from '../../../../server/printing/service';
import { json, rateLimit, clientKey } from '../../../../server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<NextResponse> {
  if (!rateLimit(clientKey(request, 'print-poll'), 240, 60_000)) {
    return json({ error: 'Slow down.' }, 429);
  }
  const url = new URL(request.url);
  const printerId = url.searchParams.get('printerId') ?? '';
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');

  if (!printerId || !token) return json({ error: 'printerId and bearer token required.' }, 400);

  try {
    return json({ jobs: await claimJobs(printerId, token, 5) });
  } catch {
    // Deliberately opaque: a wrong token must not reveal whether the printer exists.
    return json({ error: 'Authentication failed.' }, 401);
  }
}
