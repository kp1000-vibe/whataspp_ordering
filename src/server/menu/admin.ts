/**
 * Menu management: add and edit items, and CSV import.
 *
 * Import rule (spec §40): validate the WHOLE file before publishing ANY of it.
 * A file with one bad row publishes nothing and reports every problem with its
 * line number, so a restaurant never ends up with half a menu live.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client';
import { menuCategories, menuItems, locations, auditLogs } from '../../db/schema';
import { newId } from '../../lib/ids';
import { parsePriceToCents } from '../../lib/money';
import { ValidationError, ConflictError, NotFoundError } from '../errors';
import { requireRole, type TenantScope } from '../tenancy';
import { setAvailability } from './service';

const ItemInput = z.object({
  categoryName: z.string().trim().min(1, 'category is required').max(60),
  name: z.string().trim().min(1, 'name is required').max(80),
  price: z.union([z.string(), z.number()]).optional(),
  priceCents: z.number().int().min(0).max(10_000_000).optional(),
  description: z.string().max(500).optional(),
  prepMinutes: z.number().int().min(0).max(240).optional(),
  isVegetarian: z.boolean().optional(),
  isVegan: z.boolean().optional(),
  aliases: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});

function priceOf(input: { price?: string | number; priceCents?: number }): number {
  if (input.priceCents != null) return input.priceCents;
  const cents = input.price == null ? null : parsePriceToCents(String(input.price));
  if (cents == null) throw new ValidationError('price must look like 12.99');
  return cents;
}

async function categoryId(scope: TenantScope, name: string): Promise<string> {
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT id FROM menu_categories WHERE restaurant_id = $1 AND lower(name) = lower($2) LIMIT 1;`, [scope.restaurantId, name]);
  if (rows[0]) return rows[0].id;
  const id = newId('cat');
  const { rows: max } = await db.execute(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM menu_categories WHERE restaurant_id = $1;`, [scope.restaurantId]);
  await db.drizzle.insert(menuCategories).values({ id, restaurantId: scope.restaurantId, name, sortOrder: Number(max[0].n) });
  return id;
}

async function nameTaken(scope: TenantScope, name: string, exceptId?: string): Promise<boolean> {
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT id FROM menu_items WHERE restaurant_id = $1 AND lower(name) = lower($2) AND is_active = true AND id <> $3 LIMIT 1;`,
    [scope.restaurantId, name, exceptId ?? '']);
  return rows.length > 0;
}

export async function createMenuItem(scope: TenantScope, body: unknown, userId: string | null) {
  requireRole(scope, 'MANAGER');
  const parsed = ItemInput.safeParse(body);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid item.', parsed.error.issues.map((i) => i.message));
  const input = parsed.data;
  const cents = priceOf(input);
  if (await nameTaken(scope, input.name)) throw new ConflictError(`"${input.name}" is already on the menu.`);

  const db = await getDb();
  const id = newId('itm');
  await db.drizzle.insert(menuItems).values({
    id, restaurantId: scope.restaurantId, categoryId: await categoryId(scope, input.categoryName),
    name: input.name, description: input.description ?? '', priceCents: cents, prepMinutes: input.prepMinutes ?? 0,
    isVegetarian: !!input.isVegetarian, isVegan: !!input.isVegan, aliases: input.aliases ?? [],
    // Allergens start UNVERIFIED (null): the assistant refuses allergen questions until staff fill them in.
    allergens: null,
  });
  await db.drizzle.insert(auditLogs).values({
    id: newId('aud'), restaurantId: scope.restaurantId, actorType: 'USER', actorId: userId,
    action: 'menu.item_created', entityType: 'menu_item', entityId: id,
    after: { ...input, priceCents: cents } as any, correlationId: scope.correlationId,
  });
  const [item] = await db.drizzle.select().from(menuItems).where(eq(menuItems.id, id)).limit(1);
  return item;
}

const ItemPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  price: z.union([z.string(), z.number()]).optional(),
  priceCents: z.number().int().min(0).max(10_000_000).optional(),
  description: z.string().max(500).optional(),
  prepMinutes: z.number().int().min(0).max(240).optional(),
  isActive: z.boolean().optional(),
  isVegetarian: z.boolean().optional(),
  isVegan: z.boolean().optional(),
  allergens: z.array(z.string().trim().min(1).max(40)).max(20).nullable().optional(),
}).strict();

export async function updateMenuItem(scope: TenantScope, id: string, body: unknown, userId: string | null) {
  requireRole(scope, 'MANAGER');
  const db = await getDb();
  const [existing] = await db.drizzle.select().from(menuItems)
    .where(and(eq(menuItems.restaurantId, scope.restaurantId), eq(menuItems.id, id))).limit(1);
  if (!existing) throw new NotFoundError('Menu item not found.');
  const parsed = ItemPatch.safeParse(body);
  if (!parsed.success) throw new ValidationError('Invalid item update.', parsed.error.issues.map((i) => i.message));
  const p = parsed.data;
  if (p.name && (await nameTaken(scope, p.name, id))) throw new ConflictError(`"${p.name}" is already on the menu.`);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['name', 'description', 'prepMinutes', 'isActive', 'isVegetarian', 'isVegan', 'allergens'] as const) {
    if (p[k] !== undefined) patch[k] = p[k];
  }
  if (p.price !== undefined || p.priceCents !== undefined) patch.priceCents = priceOf(p);
  await db.drizzle.update(menuItems).set(patch).where(eq(menuItems.id, id));
  await db.drizzle.insert(auditLogs).values({
    id: newId('aud'), restaurantId: scope.restaurantId, actorType: 'USER', actorId: userId,
    action: 'menu.item_updated', entityType: 'menu_item', entityId: id,
    before: existing as any, after: patch as any, correlationId: scope.correlationId,
  });
  const [item] = await db.drizzle.select().from(menuItems).where(eq(menuItems.id, id)).limit(1);
  return item;
}

/* ─────────────── CSV import ─────────────── */

/** RFC-4180-ish: quoted fields, escaped quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export type ImportResult = {
  valid: boolean;
  rows: number;
  errors: Array<{ line: number; message: string }>;
  created: number;
  updated: number;
  dryRun: boolean;
};

export async function importMenuCsv(scope: TenantScope, csv: string, opts: { dryRun?: boolean; userId?: string | null } = {}): Promise<ImportResult> {
  requireRole(scope, 'MANAGER');
  if (typeof csv !== 'string' || !csv.trim()) throw new ValidationError('Paste or upload a CSV file.');
  if (csv.length > 1_000_000) throw new ValidationError('CSV is too large (1 MB max).');

  const table = parseCsv(csv).filter((r) => r.some((c) => c.trim() !== ''));
  if (table.length === 0) throw new ValidationError('The file is empty.');
  const header = table[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const errors: ImportResult['errors'] = [];
  for (const required of ['category', 'item', 'price']) {
    if (col(required) === -1) errors.push({ line: 1, message: `Missing required column "${required}". Expected: Category,Item,Price,Description,Available` });
  }
  if (errors.length) return { valid: false, rows: 0, errors, created: 0, updated: 0, dryRun: !!opts.dryRun };

  type Row = { line: number; category: string; name: string; cents: number; description: string; available: boolean };
  const parsed: Row[] = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (name: string) => (col(name) === -1 ? '' : (cells[col(name)] ?? '').trim());
    const category = get('category'), name = get('item'), priceRaw = get('price');
    const availableRaw = get('available').toLowerCase();
    const cents = parsePriceToCents(priceRaw);
    if (!category) errors.push({ line, message: 'Category is empty.' });
    if (!name) errors.push({ line, message: 'Item name is empty.' });
    if (cents == null) errors.push({ line, message: `Price "${priceRaw}" is not a valid amount (e.g. 12.99).` });
    if (availableRaw && !['true', 'false', 'yes', 'no', '1', '0'].includes(availableRaw)) {
      errors.push({ line, message: `Available must be true or false, got "${availableRaw}".` });
    }
    if (name) {
      const key = name.toLowerCase();
      if (seen.has(key)) errors.push({ line, message: `"${name}" also appears on line ${seen.get(key)}.` });
      else seen.set(key, line);
    }
    if (category && name && cents != null) {
      parsed.push({ line, category, name, cents, description: get('description'), available: !['false', 'no', '0'].includes(availableRaw) });
    }
  });

  const result: ImportResult = { valid: errors.length === 0, rows: table.length - 1, errors, created: 0, updated: 0, dryRun: !!opts.dryRun };
  if (!result.valid || opts.dryRun) return result;

  const db = await getDb();
  const [loc] = await db.drizzle.select().from(locations).where(eq(locations.restaurantId, scope.restaurantId)).limit(1);
  for (const r of parsed) {
    const { rows } = await db.execute(
      `SELECT id FROM menu_items WHERE restaurant_id = $1 AND lower(name) = lower($2) AND is_active = true LIMIT 1;`, [scope.restaurantId, r.name]);
    let id: string;
    if (rows[0]) {
      id = rows[0].id;
      await db.drizzle.update(menuItems).set({
        priceCents: r.cents, description: r.description, categoryId: await categoryId(scope, r.category), updatedAt: new Date(),
      }).where(eq(menuItems.id, id));
      result.updated++;
    } else {
      id = newId('itm');
      await db.drizzle.insert(menuItems).values({
        id, restaurantId: scope.restaurantId, categoryId: await categoryId(scope, r.category), name: r.name,
        description: r.description, priceCents: r.cents, allergens: null,
      });
      result.created++;
    }
    if (loc && !r.available) await setAvailability(scope, loc.id, { menuItemId: id }, 'SOLD_OUT', 'imported as unavailable');
  }
  await db.drizzle.insert(auditLogs).values({
    id: newId('aud'), restaurantId: scope.restaurantId, actorType: 'USER', actorId: opts.userId ?? null,
    action: 'menu.imported', entityType: 'restaurant', entityId: scope.restaurantId,
    after: { created: result.created, updated: result.updated } as any, correlationId: scope.correlationId,
  });
  void sql;
  return result;
}
