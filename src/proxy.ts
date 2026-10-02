/**
 * Request proxy (Next 16's name for middleware).
 *
 * CSRF defence: a state-changing request to /api/* that carries an Origin from
 * a different site is refused. Browsers always send Origin on cross-site POSTs,
 * so a malicious page cannot ride a logged-in manager's session cookie to pause
 * the kitchen or erase a customer (eval HS02).
 *
 * Server-to-server endpoints (Meta webhook, print agent) are exempt: they carry
 * no session cookie and authenticate with signatures / bearer tokens instead.
 */
import { NextResponse, type NextRequest } from 'next/server';

const EXEMPT = ['/api/webhooks/', '/api/print/'];
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (!UNSAFE.has(request.method) || EXEMPT.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const origin = request.headers.get('origin');
  if (origin) {
    const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
    let originHost = '';
    try { originHost = new URL(origin).host; } catch { /* malformed origin is treated as foreign */ }
    if (!host || originHost !== host) {
      return NextResponse.json({ error: 'Cross-site request refused.' }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };
