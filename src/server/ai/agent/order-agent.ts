/**
 * The ordering assistant.
 *
 * Control flow, deliberately:
 *   1. Hard-coded compliance checks (opt-out) — never delegated to a model.
 *   2. The model interprets the message into phrases + intent (no ids, no money).
 *   3. The backend RESOLVES phrases against the live menu and scores each match.
 *   4. The backend prices, checks availability and allocates a real pickup slot.
 *   5. The backend composes the reply from templates.
 *
 * At confirmation everything is checked AGAIN under a per-location lock: an
 * item can sell out, a price can change, or a slot can fill while the customer
 * is typing "yes". The customer only ever confirms what they were last shown.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../../db/client';
import { restaurants, restaurantSettings, aiInteractions, customers, orders } from '../../../db/schema';
import { newId } from '../../../lib/ids';
import { formatCents } from '../../../lib/money';
import { whenLabel } from '../../../lib/time';
import { now as clockNow } from '../../../lib/clock';
import type { TenantScope } from '../../tenancy';
import { aiProvider, fallbackProvider, withFallback } from '../provider/registry';
import { INTERPRETATION_SCHEMA, normaliseInterpretation, type Interpretation } from '../interpretation';
import { questionProbe } from '../provider/deterministic';
import { makeTools, type ToolContext } from '../tools/registry';
import { searchMenu, matchModifier, getMenu, scoreItem, type ResolvedItem } from '../../menu/service';
import { openState } from '../../prep/engine';
import { allocateSlot, parseRequestedTime, getCapacity, earliestPickup, type SlotAllocation } from '../../capacity/slots';
import { describeIssue, type LineSpec, type PricedOrder } from '../../pricing/engine';
import {
  getOrder, createDraftOrder, updateDraftOrder, withLocationLock, type OrderView,
} from '../../orders/service';
import { detectConsentIntent, setMarketingConsent, getProfile } from '../../crm/service';
import { recordOutbound, setActiveDraft, setState, getConversation } from '../../conversations/service';

/** Below this match score the assistant asks instead of assuming. */
const ACCEPT_THRESHOLD = 0.62;
/** Two candidates this close are treated as ambiguous. */
const AMBIGUITY_GAP = 0.12;
const DRAFT_STATES = ['DRAFT', 'CLARIFICATION_REQUIRED', 'READY_FOR_CONFIRMATION'];
const LIVE_STATES = ['CONFIRMED', 'RECEIVED', 'ACCEPTED', 'PREPARING', 'READY'];

export type AgentInput = {
  scope: TenantScope;
  customerId: string;
  locationId: string;
  conversationId: string;
  text: string;
  channel?: 'WHATSAPP_TEXT' | 'WHATSAPP_VOICE' | 'SIMULATOR';
  /** Transcription confidence when the message came from a voice note. */
  transcriptionConfidence?: number;
  now?: Date;
};

export type AgentOutput = {
  replies: string[];
  intent: string;
  escalated: boolean;
  orderId: string | null;
  orderStatus: string | null;
  confidence: number;
  usedFallback: boolean;
  toolCalls: Array<{ name: string; ms: number }>;
};

type ConvState = {
  pendingSpecs?: LineSpec[] | null;
  pendingPickupAt?: string | null;
  offeredPickupAt?: string | null;
  promoCode?: string | null;
  suggestion?: { menuItemId: string; quantity: number } | null;
};

const SYSTEM_PROMPT = `You convert a restaurant customer's WhatsApp message into structured data.
You do NOT know the menu, prices, availability, taxes or wait times, and you must never state them.
Report only what the customer said: their intent, the item phrases they used, quantities, modifier
phrases, and for questions the subject being asked about ("probe"). Quantities default to 1 when
unstated. Never cap or round a quantity. Return JSON only.`;

export async function runOrderAgent(input: AgentInput): Promise<AgentOutput> {
  const now = input.now ?? clockNow();
  const db = await getDb();
  const started = Date.now();

  const [restaurant] = await db.drizzle.select().from(restaurants).where(eq(restaurants.id, input.scope.restaurantId)).limit(1);
  const [settings] = await db.drizzle.select().from(restaurantSettings)
    .where(eq(restaurantSettings.restaurantId, input.scope.restaurantId)).limit(1);
  const timezone: string = restaurant?.timezone ?? 'UTC';
  const currency: string = restaurant?.currency ?? 'USD';

  const ctx: ToolContext = {
    scope: input.scope, locationId: input.locationId, customerId: input.customerId,
    conversationId: input.conversationId, timezone, currency, now,
  };
  const { tools, calls } = makeTools(ctx);
  const money = (c: number) => formatCents(c, currency);

  const replies: string[] = [];
  let escalated = false;
  let providerName = 'deterministic';
  let modelName = 'rules-v2';
  let promptTokens = 0, completionTokens = 0, costMicroUsd = 0;

  /* ── 1. compliance first, always ── */
  const consentIntent = detectConsentIntent(input.text);
  if (consentIntent) {
    await setMarketingConsent(input.scope, input.customerId, consentIntent === 'OPT_OUT' ? 'OPTED_OUT' : 'OPTED_IN', 'customer_message');
    const reply = consentIntent === 'OPT_OUT'
      ? `You're unsubscribed from our offers. You'll still get updates about orders you place. Reply START any time to opt back in.`
      : `You're subscribed. We'll let you know about new dishes and offers.`;
    await deliver(input, reply, replies);
    return done(replies, consentIntent, false, null, null, 1, false, calls);
  }

  /* ── 2. interpret ── */
  const provider = aiProvider();
  providerName = provider.name;
  const result = await withFallback<{ value: Interpretation; usage: any }>(
    'order interpretation',
    async () => {
      const r = await provider.structuredOutput<Interpretation>(
        [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: input.text }],
        INTERPRETATION_SCHEMA, { tier: 'fast', temperature: 0 });
      return { value: normaliseInterpretation(r.value), usage: r.usage };
    },
    async () => {
      const r = await fallbackProvider.structuredOutput<Interpretation>(
        [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: input.text }], INTERPRETATION_SCHEMA);
      return { value: normaliseInterpretation(r.value), usage: r.usage };
    },
  );
  const interpretation = result.value.value;
  const usedFallback = result.usedFallback;
  modelName = result.value.usage?.model ?? modelName;
  promptTokens = result.value.usage?.promptTokens ?? 0;
  completionTokens = result.value.usage?.completionTokens ?? 0;
  costMicroUsd = result.value.usage?.costMicroUsd ?? 0;

  const confidence = input.transcriptionConfidence != null
    ? Math.min(interpretation.confidence, input.transcriptionConfidence)
    : interpretation.confidence;

  // Remember the customer's language so later notifications match how they write.
  if (interpretation.language && interpretation.language !== 'en') {
    await db.drizzle.update(customers).set({ language: interpretation.language, updatedAt: new Date() })
      .where(and(eq(customers.restaurantId, input.scope.restaurantId), eq(customers.id, input.customerId)));
  }

  const conversation = await getConversation(input.scope, input.conversationId);
  const state: ConvState = (conversation?.state ?? {}) as ConvState;
  let draftOrderId: string | null = conversation?.activeDraftOrderId ?? null;
  let draft: OrderView | null = draftOrderId ? await getOrder(input.scope, draftOrderId) : null;
  if (draft && !DRAFT_STATES.includes(draft.status)) {
    draft = null; draftOrderId = null;
    await setActiveDraft(input.scope, input.conversationId, null);
  }

  const emitReply = (text: string) => deliver(input, text, replies);
  const saveState = (patch: Partial<ConvState>) => setState(input.scope, input.conversationId, patch);
  const finish = async (intent: string) => {
    await logInteraction(input, {
      intent, confidence, calls, providerName, modelName, promptTokens, completionTokens, costMicroUsd,
      latencyMs: Date.now() - started, escalated, orderId: draftOrderId,
    });
    return done(replies, intent, escalated, draftOrderId, draft?.status ?? null, confidence, usedFallback, calls);
  };

  /** Creates or updates the draft, and keeps conversation memory in step with it. */
  const upsert = async (specs: LineSpec[], requestedPickupAt: Date | null = null, customerRequested?: boolean) => {
    const promoCode = interpretation.promoCode ?? state.promoCode ?? null;
    const res = draftOrderId
      ? await updateDraftOrder(input.scope, { orderId: draftOrderId, specs, at: now, requestedPickupAt, promoCode, customerRequested })
      : await createDraftOrder(input.scope, {
          locationId: input.locationId, customerId: input.customerId, conversationId: input.conversationId,
          specs, at: now, requestedPickupAt, promoCode,
          channel: input.channel === 'WHATSAPP_VOICE' ? 'WHATSAPP_VOICE' : input.channel === 'SIMULATOR' ? 'SIMULATOR' : 'WHATSAPP_TEXT',
        });
    if (!draftOrderId) await setActiveDraft(input.scope, input.conversationId, res.order.id);
    draftOrderId = res.order.id;
    draft = res.order;
    /**
     * A line that cannot be priced yet ("one veg biryani" before the spice level
     * is known) is not written to order_items — there is no honest price for it.
     * The requested specs stay in conversation memory until they resolve.
     */
    const offered = !res.allocation.ok && res.allocation.alternatives[0] ? res.allocation.alternatives[0].end.toISOString() : null;
    await saveState({
      pendingSpecs: res.pricing.priceable ? null : specs,
      offeredPickupAt: offered,
      pendingPickupAt: null,
      promoCode,
    });
    state.pendingSpecs = res.pricing.priceable ? null : specs;
    state.offeredPickupAt = offered;
    return res;
  };

  const present = async (order: OrderView, allocation?: SlotAllocation, pricing?: PricedOrder) =>
    presentOrder(ctx, order, money, allocation, pricing);

  const liveOrder = async (): Promise<OrderView | null> => {
    const [row] = await db.drizzle.select().from(orders).where(and(
      eq(orders.restaurantId, input.scope.restaurantId), eq(orders.customerId, input.customerId),
      inArray(orders.status, LIVE_STATES as any),
    )).orderBy(desc(orders.createdAt)).limit(1);
    return row ? getOrder(input.scope, row.id) : null;
  };

  /* ── 3. is this the answer to the question we just asked? ── */
  if (state.pendingSpecs?.length && ['ORDER_ADD', 'ORDER_MODIFY', 'UNKNOWN', 'MENU_QUESTION', 'FAQ_QUESTION'].includes(interpretation.intent)) {
    const answered = await applyClarificationAnswer(ctx, state.pendingSpecs, input.text, interpretation);
    if (answered) {
      const res = await upsert(answered);
      await emitReply(await present(res.order, res.allocation, res.pricing));
      return finish('CLARIFICATION_ANSWERED');
    }
  }

  /* ── 4. dispatch ── */
  switch (interpretation.intent) {
    case 'HUMAN_REQUEST': {
      await tools.escalate_to_human({ reason: 'customer asked for a person', orderId: draftOrderId });
      escalated = true;
      await emitReply(`Let me connect you with someone at the restaurant — one moment.`);
      return finish('HUMAN_REQUEST');
    }

    case 'ALLERGEN_QUESTION': {
      const a = await answerAllergen(ctx, tools, interpretation.probe ?? questionProbe(input.text));
      if (a.escalate) {
        await tools.escalate_to_human({ reason: 'unverified allergen question', orderId: draftOrderId });
        escalated = true;
      }
      await emitReply(a.reply);
      return finish('ALLERGEN_QUESTION');
    }

    case 'DIETARY_QUESTION': {
      await emitReply(await answerDietary(ctx, interpretation.probe ?? '', input.text, money));
      return finish('DIETARY_QUESTION');
    }

    case 'GREETING': {
      const info = await tools.get_restaurant_info();
      const profile = await getProfile(input.scope, input.customerId);
      const who = profile?.name ? ` ${profile.name.split(' ')[0]}` : '';
      const greeting = settings?.greeting || `What can I get started for you today?`;
      await emitReply(info.isOpen
        ? `Hi${who}! Welcome to ${info.name}. ${greeting}`
        : `Hi${who}! Welcome to ${info.name}. ${info.hoursMessage}${info.nextOpen ? ` We're open ${info.nextOpen}.` : ''}`);
      return finish('GREETING');
    }

    case 'SMALL_TALK': {
      const live = await liveOrder();
      await emitReply(live ? `You're welcome! See you at pickup.` : `You're welcome! Anything else I can get you?`);
      return finish('SMALL_TALK');
    }

    case 'HOURS_QUESTION': {
      const info = await tools.get_restaurant_info();
      await emitReply(info.isOpen
        ? `Yes, we're open — ${info.hoursMessage}`
        : `${info.hoursMessage}${info.nextOpen ? ` We're open ${info.nextOpen}.` : ''}`);
      return finish('HOURS_QUESTION');
    }

    case 'PROMO_QUESTION': {
      const promos = await tools.get_current_promotions();
      await emitReply(promos.length
        ? `Right now: ${promos.map((p) => `${p.name}${p.minimum ? ` (on orders over ${p.minimum})` : ''}`).join(', ')}.`
        : `No special offers running right now — but I can take your order any time.`);
      return finish('PROMO_QUESTION');
    }

    case 'PREP_TIME_QUESTION': {
      // The same engine that makes the promise answers the question — so a
      // "+30 min" or "very busy" click changes this answer immediately.
      const e = await earliestPickup(input.scope, {
        locationId: input.locationId, menuItemIds: draft?.items.map((i) => i.menuItemId) ?? [], at: now,
      });
      if (e.slot) {
        const mins = Math.max(1, Math.round((e.slot.end.getTime() - now.getTime()) / 60_000));
        const busy = e.capacity.state === 'BUSY' || e.capacity.state === 'VERY_BUSY' ? `We're busy right now. ` : '';
        await emitReply(`${busy}The earliest pickup is ${e.slot.when} — about ${mins} minutes from now.`);
      } else {
        const alloc = await allocateSlot(input.scope, { locationId: input.locationId, menuItemIds: [], at: now });
        await emitReply(alloc.text);
      }
      return finish('PREP_TIME_QUESTION');
    }

    case 'MENU_QUESTION':
    case 'PRICE_QUESTION':
    case 'FAQ_QUESTION': {
      const a = await answerQuestion(ctx, tools, interpretation, input.text, money);
      if (a.suggestion) await saveState({ suggestion: a.suggestion });
      await emitReply(a.reply);
      return finish(interpretation.intent);
    }

    case 'GROUP_ORDER': {
      const menu = (await getMenu(input.scope, input.locationId)).filter((i) => i.availability === 'AVAILABLE');
      const picks = [...new Map(menu.map((i) => [i.categoryName, i])).values()].slice(0, 3);
      await emitReply(
        `Happy to help with a group order! Popular picks: ${picks.map((p) => `${p.name} (${money(p.priceCents)})`).join(', ')}. ` +
        `Tell me what you'd like and how many of each — or say "talk to a person" and I'll connect you with the team for a large order.`);
      return finish('GROUP_ORDER');
    }

    case 'ORDER_HISTORY_QUESTION': {
      const prev = await tools.get_previous_order();
      await emitReply(prev
        ? `Last time you ordered: ${prev.items.map((i) => `${i.quantity} x ${i.name}`).join(', ')} (${prev.total}). Want the same again?`
        : `I don't have a previous order on file for you yet.`);
      return finish('ORDER_HISTORY_QUESTION');
    }

    case 'REPEAT_LAST_ORDER': {
      const prev = await tools.get_previous_order();
      if (!prev) {
        await emitReply(`I don't see a previous order for you yet — what would you like today?`);
        return finish('REPEAT_LAST_ORDER');
      }
      const specs: LineSpec[] = prev.items.map((i) => ({
        menuItemId: i.menuItemId, quantity: i.quantity, modifierIds: i.modifierIds, notes: i.notes, aiConfidence: 1,
      }));
      const res = await upsert(specs);
      // Always show what the usual WAS — even the parts that can't be priced right now.
      const usual = prev.items.map((i) =>
        `• ${i.quantity} x ${i.name}${i.modifierNames.length ? ` (${i.modifierNames.join(', ')})` : ''}`).join('\n');
      const tail = res.pricing.priceable
        ? `${await present(res.order, res.allocation, res.pricing)}`
        : res.pricing.issues.slice(0, 2).map((x) => describeIssue(x, currency)).join(' ');
      await emitReply(`Your usual is:\n${usual}\n\n${tail}`);
      return finish('REPEAT_LAST_ORDER');
    }

    case 'ORDER_STATUS': {
      const num = input.text.match(/#?\s*\b(\d{3,6})\b/)?.[1];
      const status = num
        ? await tools.get_order_status({ orderNumber: Number(num) })
        : (await liveOrder()) ? await tools.get_order_status({ orderId: (await liveOrder())!.id }) : null;
      await emitReply(status
        ? `Order #${status.orderNumber} is ${humanStatus(status.status)}${status.readyAtIso ? `, ready around ${whenLabel(new Date(status.readyAtIso), now, timezone)}` : ''}.`
        : num
          ? `I couldn't find an order #${num} on your number. Could you check the number?`
          : `I couldn't find an active order for you. Do you have an order number?`);
      return finish('ORDER_STATUS');
    }

    case 'CANCEL_ORDER': {
      const target = draftOrderId ?? (await liveOrder())?.id ?? null;
      if (!target) {
        await emitReply(`I don't see an order to cancel.`);
        return finish('CANCEL_ORDER');
      }
      const res = await tools.cancel_order({ orderId: target, reason: 'customer requested cancellation' });
      if (res.cancelled) {
        await setActiveDraft(input.scope, input.conversationId, null);
        await saveState({ pendingSpecs: null, offeredPickupAt: null, pendingPickupAt: null, promoCode: null });
        draftOrderId = null; draft = null;
        await emitReply(`Cancelled — nothing has been charged. Let me know if you'd like to order something else.`);
      } else {
        await tools.escalate_to_human({ reason: 'cancellation after preparation started', orderId: target });
        escalated = true;
        await emitReply(`Your order is already being prepared. Let me connect you with the restaurant team to see what we can do.`);
      }
      return finish('CANCEL_ORDER');
    }

    case 'CONFIRM': {
      if (!draft) {
        if (state.suggestion) {
          const res = await upsert([{ menuItemId: state.suggestion.menuItemId, quantity: state.suggestion.quantity, modifierIds: [], aiConfidence: 1 }]);
          await saveState({ suggestion: null });
          await emitReply(await present(res.order, res.allocation, res.pricing));
          return finish('CONFIRM_SUGGESTION');
        }
        const live = await liveOrder();
        await emitReply(live
          ? `You're all set — order #${live.orderNumber} will be ready around ${live.promisedReadyAt ? whenLabel(live.promisedReadyAt, now, timezone) : 'soon'}.`
          : `I don't have an order ready to confirm yet. What would you like?`);
        return finish('CONFIRM');
      }
      if (draft.status !== 'READY_FOR_CONFIRMATION') {
        await emitReply(await clarificationFor(ctx, draft, currency));
        return finish('CONFIRM');
      }
      const cap = await getCapacity(input.scope, input.locationId);
      if (cap.state === 'PAUSED') {
        await emitReply(cap.note || `We've just paused new orders while the kitchen catches up — please try again in a few minutes.`);
        return finish('CONFIRM_PAUSED');
      }
      const open = await openState(input.scope, input.locationId, timezone, now);
      if ((!open.isOpen || cap.state === 'CLOSED') && !settings?.allowScheduledOrders) {
        await emitReply(`${open.message}${open.nextOpenText ? ` We're open ${open.nextOpenText}.` : ''} I can't place the order until we reopen.`);
        return finish('CONFIRM');
      }

      const quoted = state.offeredPickupAt ? new Date(state.offeredPickupAt) : draft.promisedReadyAt;
      const quotedTotal = draft.totalCents;
      const specs = state.pendingSpecs?.length ? state.pendingSpecs : existingSpecs(draft);

      const outcome = await withLocationLock(input.locationId, async () => {
        // Re-price, re-check availability and re-allocate against the CURRENT state.
        // Hold the quoted slot; whether it was the customer's request is unchanged.
        const res = await upsert(specs, quoted, state.offeredPickupAt ? true : draft!.customerRequestedTime);
        if (!res.pricing.priceable) return { kind: 'issues' as const, res };
        if (res.order.totalCents !== quotedTotal) return { kind: 'price' as const, res };
        if (!res.allocation.ok) return { kind: 'slot' as const, res };
        if (!quoted || res.allocation.promisedReadyAt.getTime() !== quoted.getTime()) return { kind: 'time' as const, res };
        await tools.confirm_order(res.order.id);
        return { kind: 'confirmed' as const, res };
      });

      if (outcome.kind === 'confirmed') {
        await setActiveDraft(input.scope, input.conversationId, null);
        await saveState({ pendingSpecs: null, offeredPickupAt: null, pendingPickupAt: null, promoCode: null, suggestion: null });
        draft = await getOrder(input.scope, outcome.res.order.id);
        // Deliberately silent: the notification layer owns the "Confirmed!" message,
        // so a customer never gets two (verified by CV01 / CV32).
        return finish('CONFIRM');
      }
      const r = outcome.res;
      if (outcome.kind === 'issues') {
        await emitReply(`Before I place this: ${r.pricing.issues.slice(0, 2).map((x) => describeIssue(x, currency)).join(' ')}`);
      } else if (outcome.kind === 'price') {
        await emitReply(`Prices have changed since I quoted you.\n\n${await present(r.order, r.allocation, r.pricing)}`);
      } else if (outcome.kind === 'slot') {
        await emitReply(r.allocation.text);
      } else {
        await emitReply(`Sorry — that pickup time just filled up.\n\n${await present(r.order, r.allocation, r.pricing)}`);
      }
      return finish('CONFIRM_RECHECK');
    }

    case 'DENY': {
      await emitReply(state.offeredPickupAt
        ? `No problem — what time would suit you?`
        : draft ? `No problem — tell me what to change and I'll fix it.` : `No problem. What would you like?`);
      return finish('DENY');
    }

    case 'PICKUP_TIME': {
      const requested = parseRequestedTime(input.text, now, timezone);
      if (!requested) {
        await emitReply(`What time would you like to pick it up?`);
        return finish('PICKUP_TIME');
      }
      if (draft) {
        const res = await upsert(existingSpecs(draft), requested);
        await emitReply(await present(res.order, res.allocation, res.pricing));
      } else {
        await saveState({ pendingPickupAt: requested.toISOString() });
        await emitReply(`Sure — I'll plan your pickup for around ${whenLabel(requested, now, timezone)}. What would you like to order?`);
      }
      return finish('PICKUP_TIME');
    }

    case 'ORDER_SET_QUANTITY': {
      const sets = interpretation.setQuantities ?? [];
      if (!draft) {
        // "just 2 coke" as a first message is simply an order.
        const as: Interpretation = { ...interpretation, intent: 'ORDER_ADD', items: sets.filter((s) => s.quantity > 0).map((s) => ({ phrase: s.phrase, quantity: s.quantity, modifierPhrases: [] })) };
        return orderAdd(as);
      }
      const specs = existingSpecs(draft);
      const extra: Interpretation = { ...interpretation, intent: 'ORDER_ADD', items: [] };
      for (const s of sets) {
        const idx = bestLine(draft, s.phrase);
        if (idx === -1) { if (s.quantity > 0) extra.items.push({ phrase: s.phrase, quantity: s.quantity, modifierPhrases: [] }); continue; }
        if (s.quantity === 0) specs.splice(idx, 1); else specs[idx] = { ...specs[idx], quantity: s.quantity };
      }
      if (extra.items.length) {
        const r = await resolvePhrases(ctx, extra, input.transcriptionConfidence);
        specs.push(...r.specs);
      }
      const res = await upsert(specs);
      await emitReply(`Updated.\n\n${await present(res.order, res.allocation, res.pricing)}`);
      return finish('ORDER_SET_QUANTITY');
    }

    case 'ORDER_MODIFY': {
      if (!draft) {
        await emitReply(`What would you like that on? Tell me the dish and I'll add it.`);
        return finish('ORDER_MODIFY');
      }
      const menu = await getMenu(input.scope, input.locationId);
      const specs = existingSpecs(draft);
      const phrases = interpretation.modifyPhrases ?? [input.text];
      const targetIdx = interpretation.modifyTarget ? bestLine(draft, interpretation.modifyTarget) : -1;
      let applied = false;
      for (const phrase of phrases) {
        // Prefer the named dish, else the most recent line that has a matching option.
        const order = targetIdx >= 0 ? [targetIdx] : specs.map((_, i) => specs.length - 1 - i);
        for (const i of order) {
          const item = menu.find((m) => m.id === specs[i].menuItemId);
          if (!item) continue;
          for (const group of item.modifierGroups) {
            const hit = matchModifier(group, phrase);
            if (!hit || hit.availability !== 'AVAILABLE') continue;
            const groupIds = new Set(group.modifiers.map((m) => m.id));
            const kept = group.maxSelect === 1 ? specs[i].modifierIds.filter((id) => !groupIds.has(id)) : specs[i].modifierIds;
            specs[i] = { ...specs[i], modifierIds: [...new Set([...kept, hit.id])] };
            applied = true;
            break;
          }
          if (applied) break;
        }
        if (!applied) {
          const i = targetIdx >= 0 ? targetIdx : specs.length - 1;
          specs[i] = { ...specs[i], notes: [specs[i].notes, phrase].filter(Boolean).join('; ') };
          applied = true;
        }
      }
      const res = await upsert(specs);
      await emitReply(`Updated.\n\n${await present(res.order, res.allocation, res.pricing)}`);
      return finish('ORDER_MODIFY');
    }

    case 'ORDER_REMOVE': {
      if (!draft || draft.items.length === 0) {
        await emitReply(`There's nothing in your order yet.`);
        return finish('ORDER_REMOVE');
      }
      const specs = existingSpecs(draft);
      let changed = false;
      for (const rm of interpretation.removeItems) {
        const idx = bestLine({ items: specs.map((s, i) => ({ name: draft!.items[i]?.name ?? '' })) } as any, rm.phrase);
        if (idx === -1) continue;
        if (rm.quantity && rm.quantity < specs[idx].quantity) specs[idx] = { ...specs[idx], quantity: specs[idx].quantity - rm.quantity };
        else specs.splice(idx, 1);
        changed = true;
      }
      if (!changed) {
        await emitReply(`I couldn't tell which item to remove. Your order is:\n${summariseLines(draft, money)}`);
        return finish('ORDER_REMOVE');
      }
      if (specs.length === 0) {
        const res = await tools.cancel_order({ orderId: draft.id, reason: 'all items removed' });
        if (res.cancelled) await setActiveDraft(input.scope, input.conversationId, null);
        draftOrderId = null; draft = null;
        await emitReply(`Your order is empty now. What would you like instead?`);
        return finish('ORDER_REMOVE');
      }
      const res = await upsert(specs);
      await emitReply(`Updated.\n\n${await present(res.order, res.allocation, res.pricing)}`);
      return finish('ORDER_REMOVE');
    }

    case 'ORDER_ADD':
      return orderAdd(interpretation);

    default: {
      await emitReply(`Sorry, I didn't catch that. You can tell me what you'd like, ask about the menu, or say "talk to a person".`);
      return finish('UNKNOWN');
    }
  }

  async function orderAdd(interp: Interpretation): Promise<AgentOutput> {
    const cap = await getCapacity(input.scope, input.locationId);
    if (cap.state === 'PAUSED') {
      await emitReply(cap.note || `We've paused new orders for a few minutes while the kitchen catches up. Please try again shortly.`);
      return finish('ORDER_ADD_PAUSED');
    }
    const open = await openState(input.scope, input.locationId, timezone, now);
    if ((!open.isOpen || cap.state === 'CLOSED') && !settings?.allowScheduledOrders) {
      await emitReply(cap.state === 'CLOSED' && open.isOpen
        ? `We're closed for today.${open.nextOpenText ? ` We're open ${open.nextOpenText}.` : ''}`
        : `${open.message}${open.nextOpenText ? ` We're open ${open.nextOpenText}.` : ''}`);
      return finish('ORDER_ADD_CLOSED');
    }

    const resolution = await resolvePhrases(ctx, interp, input.transcriptionConfidence);
    if (resolution.specs.length === 0) {
      if (resolution.suggestion) await saveState({ suggestion: resolution.suggestion });
      await emitReply(resolution.problems.join(' ') || `I'm not sure which item you mean — could you tell me the name as it appears on our menu?`);
      return finish('ORDER_ADD_UNRESOLVED');
    }

    const requestedPickupAt = parseRequestedTime(input.text, now, timezone)
      ?? (state.pendingPickupAt ? new Date(state.pendingPickupAt) : null);

    // A second order after the first was confirmed is a NEW order — say so.
    let prefix = '';
    if (!draft) {
      const live = await liveOrder();
      if (live) prefix = `Order #${live.orderNumber} is already with the kitchen, so I've started a separate new order for this.\n\n`;
    }

    const merged = draft ? mergeSpecs(existingSpecs(draft), resolution.specs) : resolution.specs;
    const res = await upsert(merged, requestedPickupAt ?? (draft?.customerRequestedTime ? draft.promisedReadyAt : null));

    const notes: string[] = [];
    if (resolution.problems.length) notes.push(resolution.problems.join(' '));
    if (input.transcriptionConfidence != null && input.transcriptionConfidence < 0.75) {
      notes.push(`I heard: "${input.text}". Did I get that right?`);
    }
    if (!open.isOpen && !res.allocation.ok) notes.push(open.message);

    await emitReply(prefix + [notes.join(' '), await present(res.order, res.allocation, res.pricing)].filter(Boolean).join('\n\n'));
    return finish('ORDER_ADD');
  }
}

/* ════════════════════ phrase resolution ════════════════════ */

type Resolution = { specs: LineSpec[]; problems: string[]; suggestion?: { menuItemId: string; quantity: number } };

async function resolvePhrases(ctx: ToolContext, interpretation: Interpretation, transcriptionConfidence?: number): Promise<Resolution> {
  const menu = await getMenu(ctx.scope, ctx.locationId);
  const specs: LineSpec[] = [];
  const problems: string[] = [];
  let suggestion: Resolution['suggestion'];

  for (const phrase of interpretation.items) {
    const matches = await searchMenu(ctx.scope, ctx.locationId, phrase.phrase, 3);
    if (matches.length === 0) {
      problems.push(`I couldn't find "${phrase.phrase}" on our menu.`);
      continue;
    }
    const [top, runnerUp] = matches;
    if (top.score < ACCEPT_THRESHOLD) {
      const names = matches.filter((m) => m.score >= top.score - AMBIGUITY_GAP).slice(0, 3).map((m) => m.item.name);
      problems.push(names.length > 1
        ? `For "${phrase.phrase}" — did you mean ${names.join(' or ')}?`
        : `We don't have "${phrase.phrase}" — did you mean ${names[0]}?`);
      if (names.length === 1) suggestion = { menuItemId: top.item.id, quantity: phrase.quantity };
      continue;
    }
    if (runnerUp && top.score - runnerUp.score < AMBIGUITY_GAP) {
      problems.push(`For "${phrase.phrase}" — did you want ${top.item.name} or ${runnerUp.item.name}?`);
      continue;
    }

    const item = top.item;
    if (item.availability !== 'AVAILABLE') {
      const subs = item.substituteItemIds
        .map((id) => menu.find((m) => m.id === id))
        .filter((s): s is ResolvedItem => !!s && s.availability === 'AVAILABLE');
      const word = item.availability === 'SOLD_OUT' ? 'sold out' : 'unavailable';
      problems.push(subs.length
        ? `${item.name} is ${word} today. Would you like ${subs.map((s) => s.name).join(' or ')} instead?`
        : `${item.name} is ${word} today.`);
      continue;
    }

    const { modifierIds, unmatched } = resolveModifiers(item, phrase.modifierPhrases);
    specs.push({
      menuItemId: item.id,
      quantity: phrase.quantity,
      modifierIds,
      notes: [phrase.notes, ...unmatched].filter(Boolean).join('; '),
      // Grounded confidence: how well the words matched a real dish, capped by
      // how sure the speech recogniser was. Not the model's self-assessment.
      aiConfidence: Number(Math.min(top.score, transcriptionConfidence ?? 1).toFixed(3)),
    });
  }

  applyPartialSignalDefaults(specs, menu);
  return { specs, problems, suggestion };
}

/**
 * Required-choice policy from the spec's two worked examples:
 *   "One chicken biryani."          -> ASK  ("regular or spicy?")
 *   "2 chicken biryani, one spicy." -> the other one takes the default (Regular)
 * If ANY line of the same dish chose in a required group, siblings that didn't
 * take the group's default. If nobody chose, we ask — never silently guess.
 */
function applyPartialSignalDefaults(specs: LineSpec[], menu: ResolvedItem[]): void {
  const byId = new Map(menu.map((i) => [i.id, i]));
  for (const spec of specs) {
    const item = byId.get(spec.menuItemId);
    if (!item) continue;
    for (const group of item.modifierGroups) {
      if (!group.isRequired) continue;
      const ids = new Set(group.modifiers.map((m) => m.id));
      if (spec.modifierIds.some((id) => ids.has(id))) continue;
      const siblingChose = specs.some((o) => o !== spec && o.menuItemId === spec.menuItemId && o.modifierIds.some((id) => ids.has(id)));
      if (!siblingChose) continue;
      const fallback = group.modifiers.find((m) => m.isDefault && m.availability === 'AVAILABLE')
        ?? group.modifiers.find((m) => m.availability === 'AVAILABLE');
      if (fallback) spec.modifierIds.push(fallback.id);
    }
  }
}

function resolveModifiers(item: ResolvedItem, phrases: string[]): { modifierIds: string[]; unmatched: string[] } {
  const modifierIds: string[] = [];
  const unmatched: string[] = [];
  for (const phrase of phrases) {
    let hit = false;
    for (const group of item.modifierGroups) {
      const m = matchModifier(group, phrase);
      if (m && m.availability === 'AVAILABLE') {
        // Single-choice groups: a later choice replaces an earlier one.
        if (group.maxSelect === 1) {
          const gids = new Set(group.modifiers.map((x) => x.id));
          for (let i = modifierIds.length - 1; i >= 0; i--) if (gids.has(modifierIds[i])) modifierIds.splice(i, 1);
        }
        if (!modifierIds.includes(m.id)) modifierIds.push(m.id);
        hit = true;
        break;
      }
    }
    if (!hit) unmatched.push(phrase);   // kept as a kitchen note, never dropped
  }
  return { modifierIds, unmatched };
}

/**
 * When the last turn ended in a question ("regular or spicy?"), a bare reply
 * like "spicy" is the ANSWER, not a new dish.
 */
async function applyClarificationAnswer(
  ctx: ToolContext, pending: LineSpec[], rawText: string, interpretation: Interpretation,
): Promise<LineSpec[] | null> {
  const menu = await getMenu(ctx.scope, ctx.locationId);
  const byId = new Map(menu.map((i) => [i.id, i]));
  const candidates = [
    rawText, ...interpretation.items.map((i) => i.phrase), ...interpretation.items.flatMap((i) => i.modifierPhrases),
    ...(interpretation.modifyPhrases ?? []),
  ].map((c) => c.trim()).filter(Boolean);

  const updated = pending.map((s) => ({ ...s, modifierIds: [...s.modifierIds] }));
  let matched = false;
  for (const spec of updated) {
    const item = byId.get(spec.menuItemId);
    if (!item) continue;
    for (const group of item.modifierGroups) {
      if (spec.modifierIds.some((id) => group.modifiers.some((m) => m.id === id))) continue;
      for (const phrase of candidates) {
        const hit = matchModifier(group, phrase);
        if (hit && hit.availability === 'AVAILABLE') { spec.modifierIds.push(hit.id); matched = true; break; }
      }
    }
  }
  return matched ? updated : null;
}

function existingSpecs(order: OrderView): LineSpec[] {
  return order.items.map((i) => ({
    menuItemId: i.menuItemId, quantity: i.quantity,
    modifierIds: i.modifiers.map((m) => m.modifierId), notes: i.notes, aiConfidence: i.aiConfidence ?? undefined,
  }));
}

/** Same dish + same options → one line with the quantities added. */
function mergeSpecs(a: LineSpec[], b: LineSpec[]): LineSpec[] {
  const out = a.map((s) => ({ ...s }));
  for (const s of b) {
    const key = (x: LineSpec) => `${x.menuItemId}|${[...x.modifierIds].sort().join(',')}|${x.notes ?? ''}`;
    const same = out.find((o) => key(o) === key(s));
    if (same) same.quantity += s.quantity; else out.push({ ...s });
  }
  return out;
}

/** Index of the draft line the customer is referring to, or -1. */
function bestLine(order: Pick<OrderView, 'items'>, phrase: string): number {
  let best = -1, bestScore = 0;
  order.items.forEach((line, i) => {
    const pseudo = { name: line.name, aliases: [], description: '' } as unknown as ResolvedItem;
    // Within a short draft, any identifying word overlap is enough ("the naan").
    const words = phrase.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const overlap = words.filter((w) => line.name.toLowerCase().includes(w.replace(/e?s$/, ''))).length;
    const score = Math.max(scoreItem(phrase, pseudo), words.length ? overlap / words.length : 0);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return bestScore >= 0.5 ? best : -1;
}

/* ════════════════════ replies ════════════════════ */

function summariseLines(order: OrderView, money: (c: number) => string): string {
  return order.items.map((i) => {
    const mods = i.modifiers.map((m) => m.name);
    if (i.notes) mods.push(i.notes);
    return `• ${i.quantity} x ${i.name}${mods.length ? ` (${mods.join(', ')})` : ''} — ${money(i.lineTotalCents)}`;
  }).join('\n');
}

async function presentOrder(
  ctx: ToolContext, order: OrderView, money: (c: number) => string,
  allocation?: SlotAllocation, pricing?: PricedOrder,
): Promise<string> {
  if (order.status === 'CLARIFICATION_REQUIRED' || order.status === 'DRAFT') {
    if (pricing?.issues.length) return pricing.issues.slice(0, 2).map((x) => describeIssue(x, ctx.currency)).join(' ');
    return clarificationFor(ctx, order, ctx.currency);
  }
  const lines = [`Here's your order:`, summariseLines(order, money), ``, `Subtotal: ${money(order.subtotalCents)}`];
  if (order.discountCents > 0) lines.push(`Discount: -${money(order.discountCents)}`);
  if (order.taxCents > 0) lines.push(`Tax: ${money(order.taxCents)}`);
  lines.push(`Total: ${money(order.totalCents)}`, ``);

  // The pickup line always comes from the slot engine, never a prep-time guess.
  if (allocation && !allocation.ok) {
    lines.push(allocation.text);
    return lines.join('\n');
  }
  lines.push(allocation?.ok
    ? allocation.text
    : order.promisedReadyAt ? `Pickup: ${whenLabel(order.promisedReadyAt, ctx.now, ctx.timezone)}.` : `I'll confirm a pickup time in a moment.`);
  lines.push(`Shall I confirm?`);
  return lines.join('\n');
}

async function clarificationFor(ctx: ToolContext, order: OrderView, currency: string): Promise<string> {
  const conv = ctx.conversationId ? await getConversation(ctx.scope, ctx.conversationId) : null;
  const pending = ((conv?.state as any)?.pendingSpecs ?? null) as LineSpec[] | null;
  const specs = pending?.length ? pending : existingSpecs(order);
  if (specs.length === 0) return `What would you like?`;
  const preview = await makeTools(ctx).tools.calculate_order(specs);
  if (preview.issues.length === 0) return `Anything else, or shall I place that?`;
  return preview.issues.slice(0, 2).map((x: any) => describeIssue(x, currency)).join(' ');
}

const CATEGORY_LIST = (menu: ResolvedItem[]) => {
  const cats = [...new Set(menu.map((i) => i.categoryName))];
  return cats.length > 1 ? `${cats.slice(0, -1).join(', ')} and ${cats.at(-1)}` : cats.join('');
};

async function answerQuestion(
  ctx: ToolContext, tools: ReturnType<typeof makeTools>['tools'], interp: Interpretation, text: string,
  money: (c: number) => string,
): Promise<{ reply: string; suggestion?: { menuItemId: string; quantity: number } }> {
  const menu = await getMenu(ctx.scope, ctx.locationId);
  const probe = (interp.probe ?? questionProbe(text)).trim();

  if (!probe && interp.intent === 'MENU_QUESTION') {
    return { reply: `We have ${CATEGORY_LIST(menu)}. What sounds good?` };
  }

  if (interp.intent === 'FAQ_QUESTION') {
    const faq = await tools.get_faq(`${text} ${probe}`);
    if (faq.length) return { reply: faq[0].answer };
  }

  if (probe) {
    const matches = await searchMenu(ctx.scope, ctx.locationId, probe, 3);
    const top = matches[0];
    if (top && top.score >= 0.8) {
      const item = top.item;
      if (item.availability !== 'AVAILABLE') {
        const subs = menu.filter((m) => item.substituteItemIds.includes(m.id) && m.availability === 'AVAILABLE');
        return { reply: subs.length ? `${item.name} is unavailable today. Would you like ${subs.map((s) => s.name).join(' or ')} instead?` : `${item.name} is unavailable today.` };
      }
      return interp.intent === 'PRICE_QUESTION'
        ? { reply: `${item.name} is ${money(item.priceCents)}. Want me to add one?`, suggestion: { menuItemId: item.id, quantity: 1 } }
        : { reply: `Yes — ${item.name} is ${money(item.priceCents)}. Want me to add one?`, suggestion: { menuItemId: item.id, quantity: 1 } };
    }
    if (top && top.score >= 0.3) {
      return {
        reply: `We don't have ${probe}, but we do have ${top.item.name} (${money(top.item.priceCents)}). Would you like that instead?`,
        suggestion: { menuItemId: top.item.id, quantity: 1 },
      };
    }
    const faq = await tools.get_faq(`${text} ${probe}`);
    if (faq.length) return { reply: faq[0].answer };
    if (interp.intent !== 'FAQ_QUESTION') {
      return { reply: `Sorry, we don't have ${probe}. We have ${CATEGORY_LIST(menu)} — what sounds good?` };
    }
  }
  return { reply: `I don't have an answer to that. Would you like me to connect you with the restaurant team?` };
}

async function answerDietary(ctx: ToolContext, probe: string, text: string, money: (c: number) => string): Promise<string> {
  const menu = (await getMenu(ctx.scope, ctx.locationId)).filter((i) => i.availability === 'AVAILABLE');
  const vegan = /\bvegan\b/i.test(text);
  const pool = menu.filter((i) => (vegan ? i.isVegan : i.isVegetarian));
  const listText = pool.length ? pool.map((i) => i.name).join(', ') : 'none marked on the menu right now';
  const kind = vegan ? 'vegan' : 'vegetarian';

  if (probe) {
    const matches = await searchMenu(ctx.scope, ctx.locationId, probe, 1);
    if (matches[0] && matches[0].score >= ACCEPT_THRESHOLD) {
      const item = matches[0].item;
      const yes = vegan ? item.isVegan : item.isVegetarian;
      return yes
        ? `Yes — ${item.name} is ${kind} (${money(item.priceCents)}).`
        : `No — ${item.name} is not ${kind}. Our ${kind} options: ${listText}.`;
    }
  }
  return `Our ${kind} options: ${listText}.`;
}

/** Allergens: answer ONLY from verified data, otherwise hand to a human. */
async function answerAllergen(
  ctx: ToolContext, tools: ReturnType<typeof makeTools>['tools'], probe: string,
): Promise<{ reply: string; escalate: boolean }> {
  const matches = probe ? await searchMenu(ctx.scope, ctx.locationId, probe, 1) : [];
  if (matches.length === 0 || matches[0].score < ACCEPT_THRESHOLD) {
    return { reply: `I don't have verified allergen information for that. Let me connect you with the restaurant team so you get an accurate answer.`, escalate: true };
  }
  const details = await tools.get_item_details(matches[0].item.id);
  if (!details || details.allergens === null) {
    return { reply: `I don't have verified allergen information for ${matches[0].item.name}. Let me connect you with the restaurant team.`, escalate: true };
  }
  return {
    reply: details.allergens.length
      ? `${details.name} contains: ${details.allergens.join(', ')}. If you have a serious allergy, please confirm with the restaurant before ordering.`
      : `${details.name} has no declared allergens from our list. If you have a serious allergy, please confirm with the restaurant before ordering.`,
    escalate: false,
  };
}

function humanStatus(status: string): string {
  return ({
    CONFIRMED: 'confirmed', RECEIVED: 'with the restaurant', ACCEPTED: 'accepted', PREPARING: 'being prepared',
    READY: 'ready for pickup', PICKED_UP: 'picked up', COMPLETED: 'complete', CANCELLED: 'cancelled', REJECTED: 'declined',
  } as Record<string, string>)[status] ?? status.toLowerCase().replace(/_/g, ' ');
}

async function deliver(input: AgentInput, text: string, sink: string[]): Promise<void> {
  sink.push(text);
  await recordOutbound(input.scope, { conversationId: input.conversationId, body: text, authorType: 'AI', category: 'TRANSACTIONAL' });
}

function done(
  replies: string[], intent: string, escalated: boolean, orderId: string | null,
  orderStatus: string | null, confidence: number, usedFallback: boolean, calls: Array<{ name: string; ms: number }>,
): AgentOutput {
  return { replies, intent, escalated, orderId, orderStatus, confidence, usedFallback, toolCalls: calls.map((c) => ({ name: c.name, ms: c.ms })) };
}

async function logInteraction(input: AgentInput, args: {
  intent: string; confidence: number; calls: Array<{ name: string; ms: number }>;
  providerName: string; modelName: string; promptTokens: number; completionTokens: number; costMicroUsd: number;
  latencyMs: number; escalated?: boolean; orderId?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.drizzle.insert(aiInteractions).values({
    id: newId('ai'), restaurantId: input.scope.restaurantId, conversationId: input.conversationId, orderId: args.orderId ?? null,
    purpose: 'order_agent', provider: args.providerName, model: args.modelName,
    promptTokens: args.promptTokens, completionTokens: args.completionTokens, costMicroUsd: args.costMicroUsd,
    latencyMs: args.latencyMs, toolCalls: args.calls.map((c) => ({ name: c.name, ms: c.ms })),
    confidence: args.confidence, escalated: args.escalated ?? false, correlationId: input.scope.correlationId,
  });
  if (args.confidence < 0.5) {
    const { emit } = await import('../../events/bus');
    await emit({
      name: 'ai.low_confidence', restaurantId: input.scope.restaurantId,
      payload: { conversationId: input.conversationId, intent: args.intent, confidence: args.confidence },
      correlationId: input.scope.correlationId,
    });
  }
}
