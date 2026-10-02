/**
 * Menu reads. Every function is tenant-scoped and resolves availability from
 * inventory_status per location. This module is the ONLY source of menu truth —
 * the AI reads it through tools, it never holds its own copy.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { menuCategories, menuItems, modifierGroups, modifiers, inventoryStatus } from '../../db/schema';
import type { TenantScope } from '../tenancy';

export type Availability = 'AVAILABLE' | 'SOLD_OUT' | 'TEMP_UNAVAILABLE';

export type ResolvedModifier = {
  id: string; name: string; priceDeltaCents: number;
  isDefault: boolean; aliases: string[]; availability: Availability;
};
export type ResolvedModifierGroup = {
  id: string; name: string; minSelect: number; maxSelect: number;
  isRequired: boolean; modifiers: ResolvedModifier[];
};
export type ResolvedItem = {
  id: string; categoryId: string; categoryName: string;
  name: string; description: string; priceCents: number; prepMinutes: number;
  isVegetarian: boolean; isVegan: boolean;
  /** null means NOT VERIFIED. The AI must refuse to answer allergen questions. */
  allergens: string[] | null;
  aliases: string[]; substituteItemIds: string[];
  availability: Availability;
  modifierGroups: ResolvedModifierGroup[];
};

export async function getMenu(scope: TenantScope, locationId: string): Promise<ResolvedItem[]> {
  const db = await getDb();

  const [cats, items, groups, mods, inv] = await Promise.all([
    db.drizzle.select().from(menuCategories).where(
      and(eq(menuCategories.restaurantId, scope.restaurantId), eq(menuCategories.isActive, true))),
    db.drizzle.select().from(menuItems).where(
      and(eq(menuItems.restaurantId, scope.restaurantId), eq(menuItems.isActive, true))),
    db.drizzle.select().from(modifierGroups).where(eq(modifierGroups.restaurantId, scope.restaurantId)),
    db.drizzle.select().from(modifiers).where(eq(modifiers.restaurantId, scope.restaurantId)),
    db.drizzle.select().from(inventoryStatus).where(
      and(eq(inventoryStatus.restaurantId, scope.restaurantId), eq(inventoryStatus.locationId, locationId))),
  ]);

  const catName = new Map<string, string>(cats.map((c: any) => [c.id, c.name]));
  const catOrder = new Map<string, number>(cats.map((c: any) => [c.id, c.sortOrder]));
  const itemAvail = new Map<string, Availability>();
  const modAvail = new Map<string, Availability>();
  for (const row of inv) {
    if (row.menuItemId) itemAvail.set(row.menuItemId, row.status);
    if (row.modifierId) modAvail.set(row.modifierId, row.status);
  }

  const modsByGroup = new Map<string, ResolvedModifier[]>();
  for (const m of mods) {
    const list = modsByGroup.get(m.modifierGroupId) ?? [];
    list.push({
      id: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents,
      isDefault: m.isDefault, aliases: m.aliases ?? [],
      availability: modAvail.get(m.id) ?? 'AVAILABLE',
    });
    modsByGroup.set(m.modifierGroupId, list);
  }
  for (const list of modsByGroup.values()) list.sort((a, b) => a.name.localeCompare(b.name));

  const groupsByItem = new Map<string, ResolvedModifierGroup[]>();
  for (const g of ([...groups] as any[]).sort((a, b) => a.sortOrder - b.sortOrder)) {
    const list = groupsByItem.get(g.menuItemId) ?? [];
    list.push({
      id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect,
      isRequired: g.isRequired, modifiers: modsByGroup.get(g.id) ?? [],
    });
    groupsByItem.set(g.menuItemId, list);
  }

  const resolved: ResolvedItem[] = (items as any[])
    .filter((i: any) => catName.has(i.categoryId))
    .map((i: any): ResolvedItem => ({
      id: i.id, categoryId: i.categoryId, categoryName: catName.get(i.categoryId) ?? '',
      name: i.name, description: i.description, priceCents: i.priceCents, prepMinutes: i.prepMinutes,
      isVegetarian: i.isVegetarian, isVegan: i.isVegan,
      allergens: i.allergens ?? null,
      aliases: i.aliases ?? [], substituteItemIds: i.substituteItemIds ?? [],
      availability: itemAvail.get(i.id) ?? 'AVAILABLE',
      modifierGroups: groupsByItem.get(i.id) ?? [],
    }));

  return resolved.sort((a, b) =>
    ((catOrder.get(a.categoryId) ?? 0) - (catOrder.get(b.categoryId) ?? 0)) || a.name.localeCompare(b.name));
}

export async function getItem(scope: TenantScope, locationId: string, itemId: string): Promise<ResolvedItem | null> {
  const menu = await getMenu(scope, locationId);
  return menu.find((i) => i.id === itemId) ?? null;
}

/* ───────────────────────── search ───────────────────────── */

/** Words that never identify a dish. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'i', 'want', 'get', 'me', 'please', 'some', 'order',
  'would', 'like', 'can', 'could', 'have', 'do', 'you', 'is', 'are', 'my', 'for', 'to', 'it',
]);

/**
 * Words that describe how a dish is made, not which dish it is. They are
 * ignored when judging precision, so "chicken biryani spicy" is still an exact
 * match for Chicken Biryani — while "mango lassi" is NOT an exact match for
 * Sweet Lassi, because "mango" is an identifying word that dish doesn't have.
 */
const NON_IDENTIFYING = new Set([
  'spicy', 'regular', 'mild', 'hot', 'normal', 'medium', 'plain', 'extra', 'very', 'double', 'less',
  'more', 'large', 'small', 'big', 'cold', 'chilled', 'fresh', 'both', 'all', 'one', 'portion',
  'plate', 'plates', 'full', 'half', 'piece', 'pieces', 'pcs', 'nos',
]);

export function normalise(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s: string): string[] {
  return normalise(s).split(' ').filter((t) => t && !STOPWORDS.has(t));
}

/** Optimal-string-alignment distance (Damerau-Levenshtein with adjacent transpositions). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * 1 = same word (incl. plural), 0.85 = a plausible typo, 0 = different.
 * Typos are only accepted for words of 5+ letters that share the first letter,
 * so "cake" can never quietly become "coke".
 */
function tokenCredit(q: string, c: string): number {
  if (q === c) return 1;
  if (c.length > 2 && (q === `${c}s` || q === `${c}es`)) return 1;
  if (q.length > 2 && (c === `${q}s` || c === `${q}es`)) return 1;
  if (q.length >= 5 && c.length >= 4 && q[0] === c[0]) {
    const allowed = Math.max(q.length, c.length) >= 8 ? 2 : 1;
    if (editDistance(q, c) <= allowed) return 0.85;
  }
  return 0;
}

export type MenuMatch = { item: ResolvedItem; score: number };

/**
 * Deterministic match score in [0,1] = coverage × precision.
 *   coverage  — how much of the dish's name the customer said
 *   precision — how much of what the customer said belongs to this dish
 * The score, not the language model, decides whether we ask a clarifying
 * question. Anything below the agent's threshold becomes "did you mean …?".
 */
export function scoreItem(query: string, item: ResolvedItem): number {
  const q = tokens(query).filter((t) => !NON_IDENTIFYING.has(t));
  if (q.length === 0) return 0;
  const descTokens = tokens(item.description);

  let best = 0;
  for (const cand of [item.name, ...item.aliases]) {
    const c = tokens(cand);
    if (c.length === 0) continue;
    if (normalise(cand) === normalise(q.join(' '))) return 1;

    const coverage = c.reduce((sum, ct) => sum + Math.max(0, ...q.map((qt) => tokenCredit(qt, ct))), 0) / c.length;
    const precision = q.reduce((sum, qt) => {
      const inName = Math.max(0, ...c.map((ct) => tokenCredit(qt, ct)));
      if (inName > 0) return sum + inName;
      // A word from the dish's own description is weak evidence, not none.
      return sum + (descTokens.some((dt) => tokenCredit(qt, dt) === 1) ? 0.5 : 0);
    }, 0) / q.length;

    best = Math.max(best, coverage * precision);
  }
  return Math.min(1, best);
}

export async function searchMenu(
  scope: TenantScope, locationId: string, query: string, limit = 5,
): Promise<MenuMatch[]> {
  const menu = await getMenu(scope, locationId);
  return menu
    .map((item) => ({ item, score: scoreItem(query, item) }))
    .filter((m) => m.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function matchModifier(group: ResolvedModifierGroup, phrase: string): ResolvedModifier | null {
  const p = normalise(phrase);
  for (const m of group.modifiers) {
    if (normalise(m.name) === p) return m;
    if (m.aliases.some((a) => normalise(a) === p)) return m;
  }
  // Longest first, so "extra spicy" wins over "spicy".
  const byLength = [...group.modifiers].sort((a, b) => b.name.length - a.name.length);
  const pt = p.split(' ');
  for (const m of byLength) {
    for (const name of [m.name, ...m.aliases]) {
      const mt = normalise(name).split(' ').filter(Boolean);
      if (mt.length && mt.every((t) => pt.some((x) => tokenCredit(x, t) === 1))) return m;
    }
  }
  return null;
}

/** Substitutes are CONFIGURED by the restaurant, and filtered to what is actually available. */
export async function availableSubstitutes(
  scope: TenantScope, locationId: string, itemId: string,
): Promise<ResolvedItem[]> {
  const menu = await getMenu(scope, locationId);
  const item = menu.find((i) => i.id === itemId);
  if (!item || item.substituteItemIds.length === 0) return [];
  const byId = new Map(menu.map((i) => [i.id, i]));
  return item.substituteItemIds
    .map((id) => byId.get(id))
    .filter((i): i is ResolvedItem => !!i && i.availability === 'AVAILABLE');
}

export async function setAvailability(
  scope: TenantScope, locationId: string,
  target: { menuItemId?: string; modifierId?: string },
  status: Availability, reason = '',
): Promise<void> {
  const db = await getDb();
  const { newId } = await import('../../lib/ids');
  const { NotFoundError } = await import('../errors');
  const { locations } = await import('../../db/schema');

  // Every id must belong to THIS restaurant. Without these checks another
  // tenant could overwrite our sold-out flag (evals B27 / HT03).
  const [loc] = await db.drizzle.select().from(locations)
    .where(and(eq(locations.restaurantId, scope.restaurantId), eq(locations.id, locationId))).limit(1);
  if (!loc) throw new NotFoundError('Location not found.');
  if (target.menuItemId) {
    const [it] = await db.drizzle.select().from(menuItems)
      .where(and(eq(menuItems.restaurantId, scope.restaurantId), eq(menuItems.id, target.menuItemId))).limit(1);
    if (!it) throw new NotFoundError('Menu item not found.');
  } else if (target.modifierId) {
    const [md] = await db.drizzle.select().from(modifiers)
      .where(and(eq(modifiers.restaurantId, scope.restaurantId), eq(modifiers.id, target.modifierId))).limit(1);
    if (!md) throw new NotFoundError('Option not found.');
  } else {
    throw new NotFoundError('Nothing to update.');
  }

  const where = target.menuItemId
    ? and(eq(inventoryStatus.restaurantId, scope.restaurantId), eq(inventoryStatus.locationId, locationId), eq(inventoryStatus.menuItemId, target.menuItemId))
    : and(eq(inventoryStatus.restaurantId, scope.restaurantId), eq(inventoryStatus.locationId, locationId), eq(inventoryStatus.modifierId, target.modifierId!));

  const existing = await db.drizzle.select().from(inventoryStatus).where(where).limit(1);
  if (existing.length) {
    await db.drizzle.update(inventoryStatus)
      .set({ status, reason, updatedAt: new Date() })
      .where(eq(inventoryStatus.id, existing[0].id));
  } else {
    await db.drizzle.insert(inventoryStatus).values({
      id: newId('inv'), restaurantId: scope.restaurantId, locationId,
      menuItemId: target.menuItemId ?? null, modifierId: target.modifierId ?? null,
      status, reason,
    });
  }
}

export async function itemsByIds(scope: TenantScope, ids: string[]) {
  if (ids.length === 0) return [];
  const db = await getDb();
  return db.drizzle.select().from(menuItems).where(
    and(eq(menuItems.restaurantId, scope.restaurantId), inArray(menuItems.id, ids)));
}
