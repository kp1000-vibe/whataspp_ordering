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

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'with', 'i', 'want', 'get', 'me', 'please',
  'some', 'one', 'two', 'three', 'order', 'would', 'like', 'can', 'could', 'have',
]);

export function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokens(s: string): string[] {
  return normalise(s).split(' ').filter((t) => t && !STOPWORDS.has(t));
}

/** Singular/plural-tolerant token equality. */
function tokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length > 3 && b === `${a}s`) return true;
  if (b.length > 3 && a === `${b}s`) return true;
  if (a.length > 4 && b.length > 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

export type MenuMatch = { item: ResolvedItem; score: number };

/**
 * Deterministic lexical match over name + aliases + description.
 * Score is in [0,1] and is what drives the clarification threshold —
 * the LLM does not get to declare its own confidence about item identity.
 */
export function scoreItem(query: string, item: ResolvedItem): number {
  const q = tokens(query);
  if (q.length === 0) return 0;

  const candidates = [item.name, ...item.aliases];
  let best = 0;

  for (const cand of candidates) {
    const c = tokens(cand);
    if (c.length === 0) continue;
    if (normalise(cand) === normalise(query)) return 1;

    let hits = 0;
    for (const ct of c) if (q.some((qt) => tokenMatch(qt, ct))) hits++;
    // coverage of the candidate name, lightly penalised by unmatched query noise
    const coverage = hits / c.length;
    const precision = hits / q.length;
    best = Math.max(best, coverage * 0.75 + precision * 0.25);
  }

  if (best < 0.4) {
    const d = tokens(item.description);
    let hits = 0;
    for (const qt of q) if (d.some((dt) => tokenMatch(qt, dt))) hits++;
    if (hits) best = Math.max(best, (hits / q.length) * 0.35);
  }
  return Math.min(1, best);
}

export async function searchMenu(
  scope: TenantScope, locationId: string, query: string, limit = 5,
): Promise<MenuMatch[]> {
  const menu = await getMenu(scope, locationId);
  return menu
    .map((item) => ({ item, score: scoreItem(query, item) }))
    .filter((m) => m.score > 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function matchModifier(group: ResolvedModifierGroup, phrase: string): ResolvedModifier | null {
  const p = normalise(phrase);
  for (const m of group.modifiers) {
    if (normalise(m.name) === p) return m;
    if (m.aliases.some((a) => normalise(a) === p)) return m;
  }
  for (const m of group.modifiers) {
    const t = tokens(m.name);
    if (t.length && t.every((mt) => tokens(phrase).some((pt) => tokenMatch(pt, mt)))) return m;
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

  const where = target.menuItemId
    ? and(eq(inventoryStatus.locationId, locationId), eq(inventoryStatus.menuItemId, target.menuItemId))
    : and(eq(inventoryStatus.locationId, locationId), eq(inventoryStatus.modifierId, target.modifierId!));

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
