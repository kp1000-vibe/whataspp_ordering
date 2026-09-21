/**
 * Tenant isolation is enforced HERE, in the data layer — never in the UI.
 *
 * Rule: any function that reads or writes tenant data takes a TenantScope as its
 * first argument and must AND `restaurant_id = scope.restaurantId` into the query.
 * `assertSameTenant` is the guard for objects loaded by primary key.
 */
import { eq, and, type SQL } from 'drizzle-orm';

export type Role = 'OWNER' | 'MANAGER' | 'STAFF' | 'KITCHEN';

export type TenantScope = {
  restaurantId: string;
  /** null for owner/manager-wide access; set to pin a user to one location. */
  locationId: string | null;
  userId: string | null;
  role: Role | 'SYSTEM';
  correlationId: string;
};

export class TenantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantViolationError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Not permitted') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export function systemScope(restaurantId: string, correlationId = 'system'): TenantScope {
  return { restaurantId, locationId: null, userId: null, role: 'SYSTEM', correlationId };
}

/** Throws unless the row belongs to the scope's restaurant. */
export function assertSameTenant<T extends { restaurantId: string } | undefined | null>(
  scope: TenantScope, row: T, what = 'record',
): NonNullable<T> {
  if (!row) throw new TenantViolationError(`${what} not found in this restaurant`);
  if (row.restaurantId !== scope.restaurantId) {
    throw new TenantViolationError(`${what} belongs to a different restaurant`);
  }
  return row as NonNullable<T>;
}

/** Composes the mandatory tenant predicate with any extra conditions. */
export function scoped(column: any, scope: TenantScope, ...extra: (SQL | undefined)[]): SQL {
  return and(eq(column, scope.restaurantId), ...extra.filter(Boolean) as SQL[])!;
}

const RANK: Record<Role, number> = { KITCHEN: 1, STAFF: 2, MANAGER: 3, OWNER: 4 };

export function requireRole(scope: TenantScope, minimum: Role): void {
  if (scope.role === 'SYSTEM') return;
  if (RANK[scope.role] < RANK[minimum]) {
    throw new ForbiddenError(`Requires ${minimum} or higher; you are ${scope.role}`);
  }
}
