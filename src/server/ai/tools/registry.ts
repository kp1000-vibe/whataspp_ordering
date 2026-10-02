/**
 * The AI tool surface.
 *
 * These are the ONLY operations the ordering assistant can perform. Notice what
 * is absent: no tool sets a price, edits the menu, changes inventory, creates a
 * promotion, alters consent, or touches restaurant settings. Sections 32 and 7
 * of the spec are enforced by this file's export list, not by prompt text.
 *
 * Every call is recorded so a support engineer can replay a conversation.
 */
import type { TenantScope } from '../../tenancy';
import { getDb } from '../../../db/client';
import { restaurants, restaurantSettings, faqEntries, locations } from '../../../db/schema';
import { and, eq } from 'drizzle-orm';
import {
  getMenu, getItem, searchMenu, availableSubstitutes, type ResolvedItem,
} from '../../menu/service';
import { priceOrder, type LineSpec } from '../../pricing/engine';
import { estimatePrep, openState } from '../../prep/engine';
import { activePromotions } from '../../promotions/engine';
import {
  createDraftOrder, updateDraftOrder, confirmOrder, cancelOrder,
  getOrder, getOrderByNumber, lastCompletedOrder, markNeedsHuman, type OrderView,
} from '../../orders/service';
import { getProfile } from '../../crm/service';
import { formatCents } from '../../../lib/money';

export type ToolContext = {
  scope: TenantScope;
  locationId: string;
  customerId: string;
  conversationId: string | null;
  timezone: string;
  currency: string;
  now: Date;
};

export type ToolCall = { name: string; args: unknown; result: unknown; ms: number };

/** Wraps every tool so the call log is automatic and uniform. */
export function makeTools(ctx: ToolContext) {
  const calls: ToolCall[] = [];

  function traced<A extends any[], R>(name: string, fn: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      const started = Date.now();
      const result = await fn(...args);
      calls.push({ name, args: args.length === 1 ? args[0] : args, result, ms: Date.now() - started });
      return result;
    };
  }

  const tools = {
    /* ── restaurant knowledge ── */

    get_restaurant_info: traced('get_restaurant_info', async () => {
      const db = await getDb();
      const [r] = await db.drizzle.select().from(restaurants).where(eq(restaurants.id, ctx.scope.restaurantId)).limit(1);
      const [s] = await db.drizzle.select().from(restaurantSettings)
        .where(eq(restaurantSettings.restaurantId, ctx.scope.restaurantId)).limit(1);
      const [loc] = await db.drizzle.select().from(locations).where(eq(locations.id, ctx.locationId)).limit(1);
      const open = await openState(ctx.scope, ctx.locationId, ctx.timezone, ctx.now);

      return {
        name: r?.name ?? '', currency: r?.currency ?? 'USD', timezone: r?.timezone ?? 'UTC',
        address: loc ? `${loc.addressLine1}, ${loc.city} ${loc.region} ${loc.postalCode}`.trim() : '',
        phone: loc?.phone ?? '',
        isOpen: open.isOpen, hoursMessage: open.message, nextOpen: open.nextOpenText,
        pickupInstructions: s?.pickupInstructions ?? '',
        parkingInfo: s?.parkingInfo ?? '',
        cancellationPolicy: s?.cancellationPolicy ?? '',
        allergenPolicy: s?.allergenPolicy ?? '',
        minOrder: s?.minOrderCents ? formatCents(s.minOrderCents, ctx.currency) : null,
        allowScheduledOrders: s?.allowScheduledOrders ?? false,
      };
    }),

    get_faq: traced('get_faq', async (query: string) => {
      const db = await getDb();
      const rows = await db.drizzle.select().from(faqEntries)
        .where(eq(faqEntries.restaurantId, ctx.scope.restaurantId));
      /**
       * Whole-word matching on MEANINGFUL words only. The old version matched any
       * shared 4-letter substring, so "do you have pizza?" returned the parking
       * answer because both contain "have" (eval Q13).
       */
      const FAQ_STOP = new Set(['have', 'your', 'what', 'does', 'with', 'there', 'when', 'where', 'this',
        'that', 'from', 'about', 'they', 'will', 'would', 'could', 'should', 'which', 'some', 'any', 'you']);
      const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 3 && !FAQ_STOP.has(w)));
      const qWords = words(query);
      const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');
      const qStems = new Set([...qWords].map(stem));
      return rows
        .map((f: any) => {
          const kw = (f.keywords ?? []).map((k: string) => k.toLowerCase());
          const hits = kw.filter((k: string) => qWords.has(k) || qStems.has(stem(k))).length * 2
            + [...words(f.question)].filter((w) => qStems.has(stem(w))).length;
          return { f, hits };
        })
        .filter((x: any) => x.hits > 0)
        .sort((a: any, b: any) => b.hits - a.hits)
        .slice(0, 3)
        .map(({ f }: any) => ({ question: f.question, answer: f.answer }));
    }),

    /* ── menu ── */

    get_menu: traced('get_menu', async () => {
      const menu = await getMenu(ctx.scope, ctx.locationId);
      return menu.map(publicItem);
    }),

    search_menu: traced('search_menu', async (query: string) => {
      const matches = await searchMenu(ctx.scope, ctx.locationId, query, 5);
      return matches.map((m) => ({ ...publicItem(m.item), score: Number(m.score.toFixed(3)) }));
    }),

    get_item_details: traced('get_item_details', async (menuItemId: string) => {
      const item = await getItem(ctx.scope, ctx.locationId, menuItemId);
      return item ? publicItemFull(item) : null;
    }),

    check_item_availability: traced('check_item_availability', async (menuItemId: string) => {
      const item = await getItem(ctx.scope, ctx.locationId, menuItemId);
      if (!item) return { found: false as const };
      const substitutes = item.availability === 'AVAILABLE'
        ? []
        : (await availableSubstitutes(ctx.scope, ctx.locationId, menuItemId)).map((s) => ({ id: s.id, name: s.name }));
      return { found: true as const, name: item.name, availability: item.availability, substitutes };
    }),

    check_modifier_availability: traced('check_modifier_availability', async (args: { menuItemId: string; modifierId: string }) => {
      const item = await getItem(ctx.scope, ctx.locationId, args.menuItemId);
      if (!item) return { found: false as const };
      for (const g of item.modifierGroups) {
        const m = g.modifiers.find((x) => x.id === args.modifierId);
        if (m) return { found: true as const, name: m.name, availability: m.availability, group: g.name };
      }
      return { found: false as const };
    }),

    /**
     * Pricing preview. Accepts item ids and quantities ONLY — the LineSpec type
     * has no price field, so a hallucinated price cannot even be expressed.
     */
    calculate_order: traced('calculate_order', async (specs: LineSpec[]) => {
      const db = await getDb();
      const [r] = await db.drizzle.select().from(restaurants).where(eq(restaurants.id, ctx.scope.restaurantId)).limit(1);
      const [s] = await db.drizzle.select().from(restaurantSettings)
        .where(eq(restaurantSettings.restaurantId, ctx.scope.restaurantId)).limit(1);

      const priced = await priceOrder(ctx.scope, specs, {
        locationId: ctx.locationId, customerId: ctx.customerId,
        taxRateBps: r?.taxRateBps ?? 0, timezone: ctx.timezone, at: ctx.now,
        minOrderCents: s?.minOrderCents ?? 0, maxOrderCents: s?.maxOrderCents ?? 0,
      });
      return {
        lines: priced.lines.map((l) => ({
          name: l.name, quantity: l.quantity,
          unitPrice: formatCents(l.unitPriceCents, ctx.currency),
          lineTotal: formatCents(l.lineTotalCents, ctx.currency),
          modifiers: l.modifiers.map((m) => m.name),
        })),
        subtotal: formatCents(priced.subtotalCents, ctx.currency),
        discount: formatCents(priced.discountCents, ctx.currency),
        tax: formatCents(priced.taxCents, ctx.currency),
        total: formatCents(priced.totalCents, ctx.currency),
        promotion: priced.promotion?.name ?? null,
        issues: priced.issues,
        priceable: priced.priceable,
      };
    }),

    estimate_pickup_time: traced('estimate_pickup_time', async (menuItemIds: string[]) => {
      const est = await estimatePrep(ctx.scope, {
        locationId: ctx.locationId, timezone: ctx.timezone, menuItemIds, at: ctx.now,
      });
      return {
        text: est.text, minMinutes: est.minMinutes, maxMinutes: est.maxMinutes,
        queueDepth: est.queueDepth, atCapacity: est.atCapacity,
        readyAtIso: est.promisedReadyAt.toISOString(),
      };
    }),

    get_current_promotions: traced('get_current_promotions', async () => {
      const promos = await activePromotions(ctx.scope, ctx.now, ctx.timezone);
      return promos.filter((p) => !p.code).map((p) => ({
        name: p.name, type: p.type,
        value: p.type === 'PERCENT_OFF' ? `${p.value / 100}%` : formatCents(p.value, ctx.currency),
        minimum: p.minSubtotalCents ? formatCents(p.minSubtotalCents, ctx.currency) : null,
      }));
    }),

    /* ── customer ── */

    get_customer_history: traced('get_customer_history', async () => {
      const profile = await getProfile(ctx.scope, ctx.customerId);
      if (!profile) return null;
      return {
        name: profile.name, totalOrders: profile.totalOrders,
        lastOrderDaysAgo: profile.daysSinceLastOrder,
        favourites: profile.favouriteItems.map((f) => f.name),
      };
    }),

    get_customer_preferences: traced('get_customer_preferences', async () => {
      const profile = await getProfile(ctx.scope, ctx.customerId);
      return profile
        ? { favourites: profile.favouriteItems, tags: profile.tags, preferredLocationId: profile.preferredLocationId }
        : { favourites: [], tags: [], preferredLocationId: null };
    }),

    get_previous_order: traced('get_previous_order', async () => {
      const order = await lastCompletedOrder(ctx.scope, ctx.customerId);
      if (!order) return null;
      return {
        orderNumber: order.orderNumber,
        items: order.items.map((i) => ({
          menuItemId: i.menuItemId, name: i.name, quantity: i.quantity,
          modifierIds: i.modifiers.map((m) => m.modifierId),
          modifierNames: i.modifiers.map((m) => m.name),
          notes: i.notes,
        })),
        total: formatCents(order.totalCents, ctx.currency),
      };
    }),

    /* ── orders (write) ── */

    create_draft_order: traced('create_draft_order', async (specs: LineSpec[]) => {
      const { order, pricing } = await createDraftOrder(ctx.scope, {
        locationId: ctx.locationId, customerId: ctx.customerId,
        conversationId: ctx.conversationId, specs, at: ctx.now,
      });
      return { orderId: order.id, orderNumber: order.orderNumber, status: order.status, issues: pricing.issues };
    }),

    update_draft_order: traced('update_draft_order', async (args: { orderId: string; specs: LineSpec[] }) => {
      const { order, pricing } = await updateDraftOrder(ctx.scope, {
        orderId: args.orderId, specs: args.specs, at: ctx.now,
      });
      return { orderId: order.id, status: order.status, issues: pricing.issues };
    }),

    confirm_order: traced('confirm_order', async (orderId: string) => {
      const order = await confirmOrder(ctx.scope, orderId, { type: 'CUSTOMER', id: ctx.customerId });
      return {
        orderNumber: order.orderNumber, status: order.status,
        total: formatCents(order.totalCents, ctx.currency),
        readyAtIso: order.promisedReadyAt?.toISOString() ?? null,
      };
    }),

    cancel_order: traced('cancel_order', async (args: { orderId: string; reason: string }) => {
      const res = await cancelOrder(ctx.scope, args.orderId, { type: 'CUSTOMER', id: ctx.customerId }, args.reason);
      return res.ok
        ? { cancelled: true as const, orderNumber: res.order.orderNumber }
        : { cancelled: false as const, reason: res.reason, orderNumber: res.order.orderNumber, status: res.order.status };
    }),

    get_order_status: traced('get_order_status', async (args: { orderId?: string; orderNumber?: number }) => {
      const order: OrderView | null = args.orderId
        ? await getOrder(ctx.scope, args.orderId)
        : args.orderNumber != null ? await getOrderByNumber(ctx.scope, args.orderNumber) : null;
      // A customer may only ever learn about THEIR OWN orders (eval CV15).
      if (!order || order.customerId !== ctx.customerId) return null;
      return {
        orderNumber: order.orderNumber, status: order.status,
        total: formatCents(order.totalCents, ctx.currency),
        readyAtIso: order.promisedReadyAt?.toISOString() ?? null,
      };
    }),

    escalate_to_human: traced('escalate_to_human', async (args: { reason: string; orderId?: string | null }) => {
      const db = await getDb();
      const { conversations } = await import('../../../db/schema');
      if (ctx.conversationId) {
        await db.drizzle.update(conversations)
          .set({ handledBy: 'STAFF', updatedAt: new Date() })
          .where(and(eq(conversations.restaurantId, ctx.scope.restaurantId), eq(conversations.id, ctx.conversationId)));
      }
      if (args.orderId) await markNeedsHuman(ctx.scope, args.orderId, true);

      const { emit } = await import('../../events/bus');
      await emit({
        name: 'conversation.escalated', restaurantId: ctx.scope.restaurantId,
        payload: { conversationId: ctx.conversationId, reason: args.reason, orderId: args.orderId ?? null },
        correlationId: ctx.scope.correlationId,
      });
      return { escalated: true as const };
    }),
  };

  return { tools, calls };
}

export type Tools = ReturnType<typeof makeTools>['tools'];

/* ── projections: what the model is allowed to see ── */

function publicItem(item: ResolvedItem) {
  return {
    id: item.id, name: item.name, category: item.categoryName,
    price: item.priceCents, description: item.description,
    availability: item.availability,
    isVegetarian: item.isVegetarian, isVegan: item.isVegan,
  };
}

function publicItemFull(item: ResolvedItem) {
  return {
    ...publicItem(item),
    /** null means the restaurant has NOT verified allergens — see allergen rules. */
    allergens: item.allergens,
    modifierGroups: item.modifierGroups.map((g) => ({
      id: g.id, name: g.name, isRequired: g.isRequired,
      minSelect: g.minSelect, maxSelect: g.maxSelect,
      modifiers: g.modifiers.map((m) => ({
        id: m.id, name: m.name, priceDelta: m.priceDeltaCents, availability: m.availability,
      })),
    })),
  };
}
