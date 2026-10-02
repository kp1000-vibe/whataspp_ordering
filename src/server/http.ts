/**
 * HTTP plumbing shared by every route: session resolution, tenant scoping,
 * rate limiting, JSON parsing and a single error funnel.
 *
 * Route handlers call `requireScope` and receive a TenantScope they cannot forge.
 */
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { resolveSession, scopeForUser, AuthError, type SessionUser } from './auth/service';
import { ForbiddenError, TenantViolationError, type TenantScope } from './tenancy';
import { IllegalTransitionError } from './orders/state-machine';
import { ValidationError, ConflictError, NotFoundError } from './errors';
import { correlationId } from '../lib/ids';
import { log } from '../lib/log';

export const SESSION_COOKIE = 'tt_session';
export const ACTIVE_RESTAURANT_COOKIE = 'tt_restaurant';

export function json(data: unknown, init?: number | ResponseInit): NextResponse {
  return NextResponse.json(data as any, typeof init === 'number' ? { status: init } : init);
}

/** Parses a JSON body; a malformed body is the client's mistake (400), never a 500. */
export async function readJson<T = any>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) return {} as T;
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object') throw new Error('not an object');
    return value as T;
  } catch {
    throw new ValidationError('Request body must be a JSON object.');
  }
}

export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

export async function activeRestaurantId(user: SessionUser): Promise<string | null> {
  const store = await cookies();
  const pinned = store.get(ACTIVE_RESTAURANT_COOKIE)?.value;
  // The cookie only SELECTS among restaurants this user is staff at; it never grants access.
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

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ValidationError) return json({ error: err.message, details: err.details }, 400);
  if (err instanceof AuthError) return json({ error: err.message }, 401);
  if (err instanceof ForbiddenError) return json({ error: err.message }, 403);
  if (err instanceof NotFoundError) return json({ error: err.message }, 404);
  // Another tenant's id looks exactly like a missing id — never confirm it exists.
  if (err instanceof TenantViolationError) return json({ error: 'Not found.' }, 404);
  if (err instanceof ConflictError) return json({ error: err.message }, 409);
  if (err instanceof IllegalTransitionError) return json({ error: err.message }, 409);

  const message = err instanceof Error ? err.message : String(err);
  log.error('unhandled route error', { error: message });
  return json({ error: 'Something went wrong.' }, 500);   // never leak internals
}

/* ─────────────── rate limiting ─────────────── */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

/**
 * Fixed-window limiter, in-process. Correct for a single instance; move the Map
 * to Redis before running several web instances. Returns true when allowed.
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

/**
 * The client identity used for IP-based limits. X-Forwarded-For is written by
 * the CLIENT unless a trusted proxy overwrites it, so it is only believed when
 * we know one does (Vercel, or TRUST_PROXY=true). Trusting it blindly let a
 * brute-force script rotate the header to dodge the limit (eval HL01).
 */
export function clientKey(request: Request, prefix: string): string {
  const trust = process.env.TRUST_PROXY === 'true' || !!process.env.VERCEL;
  const forwarded = trust ? (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() : '';
  return `${prefix}:${forwarded || 'direct'}`;
}
