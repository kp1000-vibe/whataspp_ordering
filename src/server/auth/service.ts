/**
 * Authentication and RBAC.
 *
 * Sessions are opaque random tokens; only their SHA-256 is stored, so a database
 * leak does not hand out live sessions. Passwords are scrypt. There is no way to
 * read a password back.
 */
import { and, eq, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, sessions, staff, restaurants, organizations, restaurantSettings, auditLogs } from '../../db/schema';
import { newId, correlationId } from '../../lib/ids';
import { hashPassword, verifyPassword, newSessionToken, sha256 } from '../../lib/crypto';
import type { Role, TenantScope } from '../tenancy';

const SESSION_DAYS = 30;

export type SessionUser = {
  userId: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  memberships: Array<{ restaurantId: string; restaurantName: string; role: Role; locationId: string | null }>;
};

export class AuthError extends Error {
  constructor(message: string) { super(message); this.name = 'AuthError'; }
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validatePassword(password: string): void {
  if (password.length < 10) throw new AuthError('Password must be at least 10 characters.');
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new AuthError('Password must contain a letter and a number.');
  }
}

/** Creates org + restaurant + owner in one transaction-shaped flow. */
export async function signUp(args: {
  email: string; password: string; name: string;
  organizationName: string; restaurantName: string;
  timezone?: string; currency?: string; taxRateBps?: number;
}): Promise<{ userId: string; restaurantId: string; organizationId: string; locationId: string }> {
  const db = await getDb();
  const email = normaliseEmail(args.email);
  validatePassword(args.password);

  const existing = await db.drizzle.select().from(users).limit(200);
  if (existing.some((u: any) => normaliseEmail(u.email) === email)) {
    throw new AuthError('An account with that email already exists.');
  }

  const userId = newId('usr');
  const organizationId = newId('org');
  const restaurantId = newId('rst');
  const locationId = newId('loc');

  await db.drizzle.insert(users).values({
    id: userId, email, passwordHash: hashPassword(args.password), name: args.name,
  });
  await db.drizzle.insert(organizations).values({ id: organizationId, name: args.organizationName });

  const slug = slugify(args.restaurantName, restaurantId);
  await db.drizzle.insert(restaurants).values({
    id: restaurantId, organizationId, name: args.restaurantName, slug,
    timezone: args.timezone ?? 'Asia/Kolkata',
    currency: args.currency ?? 'INR',
    taxRateBps: args.taxRateBps ?? 500,
  });
  await db.drizzle.insert(restaurantSettings).values({ restaurantId });

  const { locations } = await import('../../db/schema');
  await db.drizzle.insert(locations).values({
    id: locationId, restaurantId, name: args.restaurantName, isDefault: true,
    timezone: args.timezone ?? 'Asia/Kolkata',
  });

  await db.drizzle.insert(staff).values({
    id: newId('stf'), userId, restaurantId, locationId, role: 'OWNER',
  });

  await db.drizzle.insert(auditLogs).values({
    id: newId('aud'), restaurantId, actorType: 'USER', actorId: userId,
    action: 'auth.signup', entityType: 'restaurant', entityId: restaurantId,
    correlationId: correlationId(),
  });

  return { userId, restaurantId, organizationId, locationId };
}

function slugify(name: string, fallbackId: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base ? `${base}-${fallbackId.slice(-6)}` : fallbackId;
}

export async function signIn(email: string, password: string): Promise<{ token: string; user: SessionUser }> {
  const db = await getDb();
  const all = await db.drizzle.select().from(users).limit(500);
  const user = all.find((u: any) => normaliseEmail(u.email) === normaliseEmail(email));

  // Constant-ish work whether or not the user exists, to avoid enumeration.
  const ok = user ? verifyPassword(password, user.passwordHash) : verifyPassword(password, hashPassword('decoy-value'));
  if (!user || !ok) throw new AuthError('Invalid email or password.');

  const { token, id } = newSessionToken();
  await db.drizzle.insert(sessions).values({
    id, userId: user.id, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000),
  });

  return { token, user: await loadSessionUser(user.id) };
}

export async function signOut(token: string): Promise<void> {
  const db = await getDb();
  await db.drizzle.delete(sessions).where(eq(sessions.id, sha256(token)));
}

export async function resolveSession(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null;
  const db = await getDb();
  const [row] = await db.drizzle.select().from(sessions).where(eq(sessions.id, sha256(token))).limit(1);
  if (!row) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) {
    await db.drizzle.delete(sessions).where(eq(sessions.id, row.id));
    return null;
  }
  return loadSessionUser(row.userId);
}

async function loadSessionUser(userId: string): Promise<SessionUser> {
  const db = await getDb();
  const [user] = await db.drizzle.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new AuthError('User no longer exists.');

  const memberships = await db.drizzle.select().from(staff).where(eq(staff.userId, userId));
  const restaurantRows = await db.drizzle.select().from(restaurants);
  const nameById = new Map(restaurantRows.map((r: any) => [r.id, r.name]));

  return {
    userId: user.id, email: user.email, name: user.name, isPlatformAdmin: user.isPlatformAdmin,
    memberships: memberships.map((m: any) => ({
      restaurantId: m.restaurantId,
      restaurantName: (nameById.get(m.restaurantId) as string) ?? '',
      role: m.role as Role,
      locationId: m.locationId,
    })),
  };
}

/**
 * Builds the TenantScope for a request. THIS is the function that stops
 * restaurant A reading restaurant B: if the user has no staff row for the
 * requested restaurant, it throws before any query runs.
 */
export async function scopeForUser(
  user: SessionUser, restaurantId: string, corrId = correlationId(),
): Promise<TenantScope> {
  const membership = user.memberships.find((m) => m.restaurantId === restaurantId);
  if (!membership) {
    throw new AuthError('You do not have access to this restaurant.');
  }
  return {
    restaurantId,
    locationId: membership.role === 'OWNER' || membership.role === 'MANAGER' ? null : membership.locationId,
    userId: user.userId,
    role: membership.role,
    correlationId: corrId,
  };
}

export async function addStaff(
  scope: TenantScope,
  args: { email: string; password: string; name: string; role: Role; locationId?: string | null },
): Promise<{ userId: string }> {
  const db = await getDb();
  const { requireRole } = await import('../tenancy');
  requireRole(scope, 'MANAGER');
  validatePassword(args.password);

  const email = normaliseEmail(args.email);
  const all = await db.drizzle.select().from(users).limit(500);
  let user = all.find((u: any) => normaliseEmail(u.email) === email);

  if (!user) {
    const userId = newId('usr');
    await db.drizzle.insert(users).values({
      id: userId, email, passwordHash: hashPassword(args.password), name: args.name,
    });
    user = { id: userId };
  }

  await db.drizzle.insert(staff).values({
    id: newId('stf'), userId: user.id, restaurantId: scope.restaurantId,
    locationId: args.locationId ?? null, role: args.role,
  }).onConflictDoNothing();

  await db.drizzle.insert(auditLogs).values({
    id: newId('aud'), restaurantId: scope.restaurantId, actorType: 'USER', actorId: scope.userId,
    action: 'staff.added', entityType: 'user', entityId: user.id,
    after: { email, role: args.role }, correlationId: scope.correlationId,
  });

  return { userId: user.id };
}

export async function purgeExpiredSessions(): Promise<number> {
  const db = await getDb();
  const { rows } = await db.execute(`DELETE FROM sessions WHERE expires_at < now() RETURNING id;`);
  return rows.length;
}
