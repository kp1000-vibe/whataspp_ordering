/**
 * HTTP plumbing shared by every route: session resolution, tenant scoping,
 * rate limiting, JSON helpers and a single error funnel.
 *
 * Route handlers call `withScope` and receive a TenantScope they cannot forge.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { resolveSession, scopeForUser, AuthError, type SessionUser } from './auth/service';
import { ForbiddenError, TenantViolationError, type TenantScope } from './tenancy';
import { IllegalTransitionError } from './orders/state-machine';
import { correlationId } from '../lib/ids';
import { log } from '../lib/log';

export const SESSION_COOKIE = 'tt_session';
export const ACTIVE_RESTAURANT_COOKIE = 'tt_restaurant';

export function json(data: unknown, init?: number | ResponseInit): NextResponse {
  return NextResponse.json(data as any, typeof init === 'number' ? { status: init } : init);
}

export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

export async function activeRestaurantId(user: SessionUser): Promise<string | null> {
  const store = await cookies();
  const pinned = store.get(ACTIVE_RESTAURANT_COOKIE)?.value;
  if (pinned && user.memberships.some((m) => m.restaurantId === pinned)) return pinned;
  return user.memberships[0]?.restaurantId ?? null;
}

/**
 * The only way a route gets a TenantScope. If the signed-in user has no staff
 * row for the restaurant, this throws before any query runs.
 */
export async function requireScope(restaurantIdOverride?: string): Promise<{ scope: TenantScope; user: SessionUser }> {
  const user = await currentUser();
  if (!user) throw new AuthError('Not signed in.');

  const restaurantId = restaurantIdOverride ?? (await activeRestaurantId(user));
  if (!restaurantId) throw new AuthError('No restaurant on this account.');

  const scope = await scopeForUser(user, restaurantId, correlationId());
  return { scope, user };
}

/** Wraps a handler so every failure becomes a clean, non-leaky JSON response. */
export function route<T>(
  handler: (ctx: { scope: TenantScope; user: SessionUser }) => Promise<T>,
): () => Promise<NextResponse> {
  return async () => {
    try {
      const ctx = await requireScope();
      return json(await handler(ctx) as any);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AuthError) return json({ error: err.message }, 401);
  if (err instanceof ForbiddenError) return json({ error: err.message }, 403);
  if (err instanceof TenantViolationError) return json({ error: 'Not found.' }, 404);
  if (err instanceof IllegalTransitionError) return json({ error: err.message }, 409);

  const message = err instanceof Error ? err.message : String(err);
  log.error('unhandled route error', { error: message });
  // Never leak internals to the client.
  return json({ error: 'Something went wrong.' }, 500);
}

/* ─────────────── rate limiting ─────────────── */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/**
 * Fixed-window limiter, in-process. Good enough for a single Next.js instance;
 * swap the Map for Redis when running more than one. Returns true when allowed.
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

export function clientKey(request: Request, prefix: string): string {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const ip = forwarded.split(',')[0].trim() || 'local';
  return `${prefix}:${ip}`;
}
