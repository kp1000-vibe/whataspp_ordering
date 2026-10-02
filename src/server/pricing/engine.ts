/**
 * THE PRICING AUTHORITY.
 *
 * Input from the AI is only: menu item ids, quantities, modifier ids, notes.
 * Prices, taxes and discounts are re-read from the database every single time.
 * If the model supplies a price it is ignored — see `priceOrder` which accepts
 * no price field at all. That is the structural guarantee, not a convention.
 */
import { getMenu, type ResolvedItem } from '../menu/service';
import { applyBps, formatCents } from '../../lib/money';
import { evaluateBestPromotion, type PricedLine, type PromotionRow } from '../promotions/engine';
import type { TenantScope } from '../tenancy';

/** What the AI is allowed to say. Note the deliberate absence of any price field. */
export type LineSpec = {
  menuItemId: string;
  quantity: number;
  modifierIds: string[];
  notes?: string;
  aiConfidence?: number;
};

export type PricedModifier = { modifierId: string; name: string; priceDeltaCents: number };

export type PricedOrderLine = PricedLine & {
  name: string;
  notes: string;
  aiConfidence: number | null;
  modifiers: PricedModifier[];
};

export type PricingIssue =
  | { kind: 'UNKNOWN_ITEM'; menuItemId: string }
  | { kind: 'ITEM_UNAVAILABLE'; menuItemId: string; name: string; status: string }
  | { kind: 'UNKNOWN_MODIFIER'; menuItemId: string; modifierId: string }
  | { kind: 'MODIFIER_UNAVAILABLE'; modifierId: string; name: string }
  | { kind: 'MISSING_REQUIRED_CHOICE'; menuItemId: string; itemName: string; groupId: string; groupName: string; options: string[] }
  | { kind: 'TOO_MANY_SELECTIONS'; menuItemId: string; groupName: string; maxSelect: number }
  | { kind: 'INVALID_QUANTITY'; menuItemId: string; quantity: number }
  | { kind: 'BELOW_MINIMUM'; minOrderCents: number }
  | { kind: 'ABOVE_MAXIMUM'; maxOrderCents: number };

export type PricedOrder = {
  lines: PricedOrderLine[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  promotion: PromotionRow | null;
  promotionReason: string;
  issues: PricingIssue[];
  /** true only when there are zero blocking issues. */
  priceable: boolean;
};

export type PricingContext = {
  locationId: string;
  customerId: string;
  taxRateBps: number;
  timezone: string;
  at: Date;
  minOrderCents: number;
  maxOrderCents: number;
  promoCode?: string | null;
};

export const MAX_QTY_PER_LINE = 50;

export async function priceOrder(
  scope: TenantScope, specs: LineSpec[], ctx: PricingContext,
): Promise<PricedOrder> {
  const menu = await getMenu(scope, ctx.locationId);
  const byItemId = new Map<string, ResolvedItem>(menu.map((i) => [i.id, i]));

  const issues: PricingIssue[] = [];
  const lines: PricedOrderLine[] = [];

  for (const spec of specs) {
    const item = byItemId.get(spec.menuItemId);
    if (!item) {
      issues.push({ kind: 'UNKNOWN_ITEM', menuItemId: spec.menuItemId });
      continue;
    }
    if (item.availability !== 'AVAILABLE') {
      issues.push({ kind: 'ITEM_UNAVAILABLE', menuItemId: item.id, name: item.name, status: item.availability });
      continue;
    }
    if (!Number.isInteger(spec.quantity) || spec.quantity < 1 || spec.quantity > MAX_QTY_PER_LINE) {
      issues.push({ kind: 'INVALID_QUANTITY', menuItemId: item.id, quantity: spec.quantity });
      continue;
    }

    // Resolve modifiers strictly against this item's own groups.
    const allowed = new Map<string, { mod: any; group: any }>();
    for (const g of item.modifierGroups) for (const m of g.modifiers) allowed.set(m.id, { mod: m, group: g });

    const chosen: PricedModifier[] = [];
    const perGroupCount = new Map<string, number>();
    let modifierProblem = false;

    for (const modId of spec.modifierIds ?? []) {
      const entry = allowed.get(modId);
      if (!entry) {
        issues.push({ kind: 'UNKNOWN_MODIFIER', menuItemId: item.id, modifierId: modId });
        modifierProblem = true;
        continue;
      }
      if (entry.mod.availability !== 'AVAILABLE') {
        issues.push({ kind: 'MODIFIER_UNAVAILABLE', modifierId: modId, name: entry.mod.name });
        modifierProblem = true;
        continue;
      }
      chosen.push({ modifierId: modId, name: entry.mod.name, priceDeltaCents: entry.mod.priceDeltaCents });
      perGroupCount.set(entry.group.id, (perGroupCount.get(entry.group.id) ?? 0) + 1);
    }

    for (const g of item.modifierGroups) {
      const count = perGroupCount.get(g.id) ?? 0;
      if (g.isRequired && count < Math.max(1, g.minSelect)) {
        issues.push({
          kind: 'MISSING_REQUIRED_CHOICE',
          menuItemId: item.id, itemName: item.name, groupId: g.id, groupName: g.name,
          options: g.modifiers.filter((m) => m.availability === 'AVAILABLE').map((m) => m.name),
        });
        modifierProblem = true;
      }
      if (count > g.maxSelect) {
        issues.push({ kind: 'TOO_MANY_SELECTIONS', menuItemId: item.id, groupName: g.name, maxSelect: g.maxSelect });
        modifierProblem = true;
      }
    }
    if (modifierProblem) continue;

    const modsPerUnit = chosen.reduce((s, m) => s + m.priceDeltaCents, 0);
    const modifiersTotalCents = modsPerUnit * spec.quantity;
    const lineTotalCents = (item.priceCents + modsPerUnit) * spec.quantity;

    lines.push({
      menuItemId: item.id,
      name: item.name,
      quantity: spec.quantity,
      unitPriceCents: item.priceCents,      // <- from the DB, always
      modifiersTotalCents,
      lineTotalCents,
      notes: spec.notes ?? '',
      aiConfidence: spec.aiConfidence ?? null,
      modifiers: chosen,
    });
  }

  const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);

  let discountCents = 0;
  let promotion: PromotionRow | null = null;
  let promotionReason = '';
  if (lines.length > 0) {
    const evaluation = await evaluateBestPromotion(scope, {
      customerId: ctx.customerId, lines, subtotalCents,
      at: ctx.at, timezone: ctx.timezone, requestedCode: ctx.promoCode ?? null,
    });
    discountCents = evaluation.discountCents;
    promotion = evaluation.promotion;
    promotionReason = evaluation.reason;
  }

  const taxable = Math.max(0, subtotalCents - discountCents);
  const taxCents = applyBps(taxable, ctx.taxRateBps);
  const totalCents = taxable + taxCents;

  if (lines.length > 0 && ctx.minOrderCents > 0 && subtotalCents < ctx.minOrderCents) {
    issues.push({ kind: 'BELOW_MINIMUM', minOrderCents: ctx.minOrderCents });
  }
  if (ctx.maxOrderCents > 0 && totalCents > ctx.maxOrderCents) {
    issues.push({ kind: 'ABOVE_MAXIMUM', maxOrderCents: ctx.maxOrderCents });
  }

  return {
    lines, subtotalCents, discountCents, taxCents, totalCents,
    promotion, promotionReason, issues,
    priceable: issues.length === 0 && lines.length > 0,
  };
}

/** Human-readable issue text used in WhatsApp replies and the console. */
export function describeIssue(issue: PricingIssue, currency = 'USD'): string {
  switch (issue.kind) {
    case 'UNKNOWN_ITEM': return `I could not find that item on the menu.`;
    case 'ITEM_UNAVAILABLE':
      return issue.status === 'SOLD_OUT'
        ? `${issue.name} is sold out right now.`
        : `${issue.name} is temporarily unavailable.`;
    case 'UNKNOWN_MODIFIER': return `That option is not available for this item.`;
    case 'MODIFIER_UNAVAILABLE': return `${issue.name} is unavailable right now.`;
    case 'MISSING_REQUIRED_CHOICE':
      return `For the ${issue.itemName}, which ${issue.groupName.toLowerCase()} would you like? ${issue.options.join(' or ')}.`;
    case 'TOO_MANY_SELECTIONS': return `You can pick at most ${issue.maxSelect} for ${issue.groupName}.`;
    case 'INVALID_QUANTITY':
      return `We can take up to ${MAX_QTY_PER_LINE} of one item per order — for more, please contact the restaurant directly.`;
    case 'BELOW_MINIMUM': return `Our minimum order is ${formatCents(issue.minOrderCents, currency)} — would you like to add something?`;
    case 'ABOVE_MAXIMUM': return `That order is above our online maximum. Please call the restaurant.`;
  }
}
