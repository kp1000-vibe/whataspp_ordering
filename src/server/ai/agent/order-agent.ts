/**
 * The ordering assistant.
 *
 * Control flow, deliberately:
 *   1. Hard-coded compliance checks (opt-out) — never delegated to a model.
 *   2. Model interprets the utterance into phrases + intent (no ids, no money).
 *   3. Backend RESOLVES phrases against the live menu and scores the match.
 *   4. Backend prices, checks availability, computes prep time.
 *   5. Backend composes the reply from templates.
 *
 * The model never sees a price it can repeat incorrectly, and never decides
 * whether an item exists. Steps 3-5 are pure functions of the database.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../db/client';
import { restaurants, restaurantSettings, aiInteractions, customers } from '../../../db/schema';
import { newId } from '../../../lib/ids';
import { formatCents } from '../../../lib/money';
import { formatLocalTime } from '../../../lib/time';
import { log } from '../../../lib/log';
import type { TenantScope } from '../../tenancy';
import { aiProvider, fallbackProvider, withFallback } from '../provider/registry';
import { INTERPRETATION_SCHEMA, normaliseInterpretation, type Interpretation } from '../interpretation';
import { interpret as deterministicInterpret } from '../provider/deterministic';
import { makeTools, type ToolContext } from '../tools/registry';
import { searchMenu, matchModifier, type ResolvedItem } from '../../menu/service';
import { getMenu } from '../../menu/service';
import { openState } from '../../prep/engine';
import { allocateSlot, parseRequestedTime, getCapacity, type SlotAllocation } from '../../capacity/slots';
import { detectLanguage, type Language } from '../language';
import type { LineSpec, PricedOrder } from '../../pricing/engine';
import { describeIssue } from '../../pricing/engine';
import { getOrder, type OrderView } from '../../orders/service';
import { detectConsentIntent, setMarketingConsent, getProfile } from '../../crm/service';
import {
  findOrCreateConversation, recordOutbound, setActiveDraft, setState, getConversation,
} from '../../conversations/service';

/** Below this the assistant asks instead of assuming. Section 34. */
const ACCEPT_THRESHOLD = 0.62;
/** Two candidates within this gap are treated as ambiguous. */
const AMBIGUITY_GAP = 0.12;

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

const SYSTEM_PROMPT = `You convert a restaurant customer's WhatsApp message into structured data.
You do NOT know the menu, prices, availability, taxes or wait times, and you must never state them.
Report only what the customer said: their intent, the item phrases they used, quantities, and any
modifier phrases. Quantities default to 1 when unstated. If the message is a question, set the
matching question intent and copy the question. Return JSON only.`;

export async function runOrderAgent(input: AgentInput): Promise<AgentOutput> {
  const now = input.now ?? new Date();
  const db = await getDb();
  const started = Date.now();

  const [restaurant] = await db.drizzle.select().from(restaurants)
    .where(eq(restaurants.id, input.scope.restaurantId)).limit(1);
  const [settings] = await db.drizzle.select().from(restaurantSettings)
    .where(eq(restaurantSettings.restaurantId, input.scope.restaurantId)).limit(1);

  const timezone = restaurant?.timezone ?? 'UTC';
  const currency = restaurant?.currency ?? 'USD';

  const ctx: ToolContext = {
    scope: input.scope, locationId: input.locationId, customerId: input.customerId,
    conversationId: input.conversationId, timezone, currency, now,
  };
  const { tools, calls } = makeTools(ctx);

  const replies: string[] = [];
  let escalated = false;
  let usedFallback = false;
  let providerName = 'deterministic';
  let modelName = 'rules-v1';
  let promptTokens = 0, completionTokens = 0, costMicroUsd = 0;

  /* ── 1. compliance first, always ── */
  const consentIntent = detectConsentIntent(input.text);
  if (consentIntent === 'OPT_OUT') {
    await setMarketingConsent(input.scope, input.customerId, 'OPTED_OUT', 'customer_message');
    const reply = `You're unsubscribed from our offers. You'll still get updates about orders you place. Reply START any time to opt back in.`;
    await deliver(input, reply, replies);
    await logInteraction(input, { purpose: 'order_agent', intent: 'OPT_OUT', confidence: 1, calls, providerName, modelName, promptTokens, completionTokens, costMicroUsd, latencyMs: Date.now() - started });
    return done(replies, 'OPT_OUT', false, null, null, 1, false, calls);
  }
  if (consentIntent === 'OPT_IN') {
    await setMarketingConsent(input.scope, input.customerId, 'OPTED_IN', 'customer_message');
    const reply = `You're subscribed. We'll let you know about new dishes and offers.`;
    await deliver(input, reply, replies);
    return done(replies, 'OPT_IN', false, null, null, 1, false, calls);
  }

  /* ── 2. interpret ── */
  const provider = aiProvider();
  providerName = provider.name;

  const result = await withFallback<{ value: Interpretation; usage: any }>(
    'order interpretation',
    async () => {
      const r = await provider.structuredOutput<Interpretation>(
        [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: input.text }],
        INTERPRETATION_SCHEMA,
        { tier: 'fast', temperature: 0 },
      );
      return { value: normaliseInterpretation(r.value), usage: r.usage };
    },
    async () => {
      const r = await fallbackProvider.structuredOutput<Interpretation>(
        [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: input.text }],
        INTERPRETATION_SCHEMA,
      );
      return { value: normaliseInterpretation(r.value), usage: r.usage };
    },
  );

  const interpretation = result.value.value;
  usedFallback = result.usedFallback;
  modelName = result.value.usage?.model ?? modelName;
  promptTokens = result.value.usage?.promptTokens ?? 0;
  completionTokens = result.value.usage?.completionTokens ?? 0;
  costMicroUsd = result.value.usage?.costMicroUsd ?? 0;

  // A shaky transcription drags overall confidence down — voice is not text.
  const confidence = input.transcriptionConfidence != null
    ? Math.min(interpretation.confidence, input.transcriptionConfidence)
    : interpretation.confidence;

  // Remember the customer's language so notifications match how they talk to us.
  if (interpretation.language && interpretation.language !== 'en') {
    await db.drizzle.update(customers)
      .set({ language: interpretation.language, updatedAt: new Date() })
      .where(and(eq(customers.restaurantId, input.scope.restaurantId), eq(customers.id, input.customerId)));
  }

  const conversation = await getConversation(input.scope, input.conversationId);
  let draftOrderId = conversation?.activeDraftOrderId ?? null;
  let draft: OrderView | null = draftOrderId ? await getOrder(input.scope, draftOrderId) : null;
  if (draft && !['DRAFT', 'CLARIFICATION_REQUIRED', 'READY_FOR_CONFIRMATION'].includes(draft.status)) {
    draft = null; draftOrderId = null;
    await setActiveDraft(input.scope, input.conversationId, null);
  }

  const emitReply = (text: string) => deliver(input, text, replies);
  const finish = async (intent: string) => {
    await logInteraction(input, {
      purpose: 'order_agent', intent, confidence, calls,
      providerName, modelName, promptTokens, completionTokens, costMicroUsd,
      latencyMs: Date.now() - started, escalated, orderId: draftOrderId,
    });
    return done(replies, intent, escalated, draftOrderId, draft?.status ?? null, confidence, usedFallback, calls);
  };

  /* ── 3. is this the answer to the question we just asked? ── */
  const pendingSpecs = ((conversation?.state as any)?.pendingSpecs ?? null) as LineSpec[] | null;
  if (pendingSpecs?.length && ['ORDER_ADD', 'UNKNOWN', 'MENU_QUESTION'].includes(interpretation.intent)) {
    const answered = await applyClarificationAnswer(ctx, pendingSpecs, input.text, interpretation);

    if (answered) {
      const outcome = await upsertDraft(ctx, draftOrderId, answered, input);
      draft = outcome.order; draftOrderId = outcome.orderId;
      await emitReply(await presentOrder(ctx, tools, outcome.order, currency, timezone, outcome.allocation, outcome.pricing));
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
      const text = await answerAllergen(ctx, tools, input.text);
      if (text.escalate) {
        await tools.escalate_to_human({ reason: 'unverified allergen question', orderId: draftOrderId });
        escalated = true;
      }
      await emitReply(text.reply);
      return finish('ALLERGEN_QUESTION');
    }

    case 'GREETING': {
      const info = await tools.get_restaurant_info();
      const profile = await getProfile(input.scope, input.customerId);
      const who = profile?.name ? ` ${profile.name}` : '';
      const greeting = settings?.greeting || `What can I get started for you today?`;
      await emitReply(info.isOpen
        ? `Hi${who}! Welcome to ${info.name}. ${greeting}`
        : `Hi${who}! Welcome to ${info.name}. ${info.hoursMessage}${info.nextOpen ? ` We're open ${info.nextOpen}.` : ''}`);
      return finish('GREETING');
    }

    case 'HOURS_QUESTION': {
      const info = await tools.get_restaurant_info();
      await emitReply(info.isOpen
        ? `We're open right now — ${info.hoursMessage}`
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
      const ids = draft?.items.map((i) => i.menuItemId) ?? [];
      const est = await tools.estimate_pickup_time(ids);
      await emitReply(est.atCapacity
        ? `The kitchen is very busy — right now it's about ${est.text}.`
        : `Right now it's about ${est.text} from when an order is confirmed.`);
      return finish('PREP_TIME_QUESTION');
    }

    case 'MENU_QUESTION':
    case 'PRICE_QUESTION': {
      const reply = await answerMenuQuestion(ctx, input.text, interpretation);
      await emitReply(reply);
      return finish(interpretation.intent);
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
        menuItemId: i.menuItemId, quantity: i.quantity,
        modifierIds: i.modifierIds, notes: i.notes, aiConfidence: 0.95,
      }));
      const outcome = await upsertDraft(ctx, draftOrderId, specs, input);
      draftOrderId = outcome.orderId; draft = outcome.order;
      await emitReply(`Your usual is:\n${summariseLines(outcome.order, currency)}\n\n${outcome.allocation.text}\nWant me to place that?`);
      return finish('REPEAT_LAST_ORDER');
    }

    case 'ORDER_STATUS': {
      const num = input.text.match(/#?\s*(\d{3,6})/)?.[1];
      const status = num
        ? await tools.get_order_status({ orderNumber: Number(num) })
        : await latestLiveOrder(ctx, tools);
      await emitReply(status
        ? `Order #${status.orderNumber} is ${humanStatus(status.status)}${status.readyAtIso ? `, ready around ${formatLocalTime(new Date(status.readyAtIso), timezone)}` : ''}.`
        : `I couldn't find an active order for you. Do you have an order number?`);
      return finish('ORDER_STATUS');
    }

    case 'CANCEL_ORDER': {
      const target = draftOrderId ?? (await latestLiveOrderId(ctx));
      if (!target) {
        await emitReply(`I don't see an order to cancel.`);
        return finish('CANCEL_ORDER');
      }
      const res = await tools.cancel_order({ orderId: target, reason: 'customer requested cancellation' });
      if (res.cancelled) {
        await setActiveDraft(input.scope, input.conversationId, null);
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
        await emitReply(`I don't have an order ready to confirm yet. What would you like?`);
        return finish('CONFIRM');
      }
      if (draft.status !== 'READY_FOR_CONFIRMATION') {
        const reply = await clarificationFor(ctx, draft);
        await emitReply(reply);
        return finish('CONFIRM');
      }
      const capacityNow = await getCapacity(input.scope, input.locationId);
      if (capacityNow.state === 'PAUSED') {
        await emitReply(capacityNow.note || `We've just paused new orders while the kitchen catches up — please try again in a few minutes.`);
        return finish('CONFIRM_PAUSED');
      }
      const open = await openState(input.scope, input.locationId, timezone, now);
      if ((!open.isOpen || capacityNow.state === 'CLOSED') && !settings?.allowScheduledOrders) {
        await emitReply(`${open.message}${open.nextOpenText ? ` We're open ${open.nextOpenText}.` : ''} I can't place the order until we reopen.`);
        return finish('CONFIRM');
      }
      // The slot may have filled while the customer was typing. Re-check before committing.
      const recheck = await allocateSlot(input.scope, {
        locationId: input.locationId,
        menuItemIds: draft.items.map((i) => i.menuItemId),
        requestedAt: draft.customerRequestedTime ? draft.promisedReadyAt : null,
        at: now,
      });
      if (!recheck.ok) {
        await emitReply(recheck.text);
        return finish('CONFIRM_NO_SLOT');
      }
      await tools.confirm_order(draft.id);
      await setActiveDraft(input.scope, input.conversationId, null);
      /**
       * Deliberately silent here. Confirmation is an ORDER LIFECYCLE event, and
       * the notification layer owns every one of those (confirmed / preparing /
       * ready / delayed). If the agent also replied, a customer confirming by
       * WhatsApp would get two near-identical messages — twice the cost and a
       * sloppy read — while a staff-side confirmation would get only one.
       * One owner, one message, whoever triggers it.
       */
      draft = await getOrder(input.scope, draft.id);
      return finish('CONFIRM');
    }

    case 'DENY': {
      if (draft) {
        await emitReply(`No problem — tell me what to change and I'll fix it.`);
      } else {
        await emitReply(`No problem. What would you like?`);
      }
      return finish('DENY');
    }

    case 'ORDER_REMOVE': {
      if (!draft || draft.items.length === 0) {
        await emitReply(`There's nothing in your order yet.`);
        return finish('ORDER_REMOVE');
      }
      const remaining = removeFromDraft(draft, interpretation.removeItems.map((r) => r.phrase));
      if (remaining.length === draft.items.length) {
        await emitReply(`I couldn't tell which item to remove. Your order is:\n${summariseLines(draft, currency)}`);
        return finish('ORDER_REMOVE');
      }
      if (remaining.length === 0) {
        const res = await tools.cancel_order({ orderId: draft.id, reason: 'all items removed' });
        if (res.cancelled) await setActiveDraft(input.scope, input.conversationId, null);
        draftOrderId = null; draft = null;
        await emitReply(`Your order is empty now. What would you like instead?`);
        return finish('ORDER_REMOVE');
      }
      const outcome = await upsertDraft(ctx, draft.id, remaining, input);
      draft = outcome.order; draftOrderId = outcome.orderId;
      await emitReply(`Updated.\n\n${await presentOrder(ctx, tools, outcome.order, currency, timezone, outcome.allocation, outcome.pricing)}`);
      return finish('ORDER_REMOVE');
    }

    case 'ORDER_ADD': {
      const capacity = await getCapacity(input.scope, input.locationId);
      if (capacity.state === 'PAUSED') {
        await emitReply(capacity.note || `We've paused new orders for a few minutes while the kitchen catches up. Please try again shortly.`);
        return finish('ORDER_ADD_PAUSED');
      }
      const open = await openState(input.scope, input.locationId, timezone, now);
      if ((!open.isOpen || capacity.state === 'CLOSED') && !settings?.allowScheduledOrders) {
        await emitReply(`${open.message}${open.nextOpenText ? ` We're open ${open.nextOpenText}.` : ''}`);
        return finish('ORDER_ADD_CLOSED');
      }

      const resolution = await resolvePhrases(ctx, interpretation);

      if (resolution.specs.length === 0) {
        await emitReply(resolution.problems[0] ?? `I'm not sure which item you mean — could you tell me the name as it appears on our menu?`);
        return finish('ORDER_ADD_UNRESOLVED');
      }

      // "I'll pick it up around 8" — honoured, or refused with the next real slot.
      const requestedPickupAt = parseRequestedTime(input.text, now, timezone);

      const merged = draft ? [...existingSpecs(draft), ...resolution.specs] : resolution.specs;
      const outcome = await upsertDraft(ctx, draftOrderId, merged, input, requestedPickupAt);
      draft = outcome.order; draftOrderId = outcome.orderId;

      const notes: string[] = [];
      if (resolution.problems.length) notes.push(resolution.problems.join(' '));
      if (input.transcriptionConfidence != null && input.transcriptionConfidence < 0.75) {
        notes.push(`I heard: "${input.text}". Did I get that right?`);
      }
      // A rejected slot request is the customer's most important piece of news.
      if (!outcome.allocation.ok) notes.push(outcome.allocation.text);

      const presentation = await presentOrder(ctx, tools, outcome.order, currency, timezone, outcome.allocation, outcome.pricing);
      await emitReply([notes.join(' '), presentation].filter(Boolean).join('\n\n'));
      return finish('ORDER_ADD');
    }

    default: {
      // Low-confidence catch-all: never guess an order into existence.
      const matches = await searchMenu(input.scope, input.locationId, input.text, 3);
      if (matches.length && matches[0].score >= ACCEPT_THRESHOLD) {
        await emitReply(`Did you mean ${matches.map((m) => m.item.name).join(' or ')}?`);
      } else {
        await emitReply(`Sorry, I didn't catch that. You can tell me what you'd like, ask about the menu, or say "talk to a person".`);
      }
      return finish('UNKNOWN');
    }
  }
}

/**
 * When the last turn ended in a question ("regular or spicy?"), a bare reply
 * like "spicy" is an ANSWER, not a new dish. This tries to read the message as
 * a selection within the pending items' modifier groups and returns updated
 * specs, or null when it clearly is not an answer (so normal ordering runs).
 */
async function applyClarificationAnswer(
  ctx: ToolContext, pending: LineSpec[], rawText: string, interpretation: Interpretation,
): Promise<LineSpec[] | null> {
  const menu = await getMenu(ctx.scope, ctx.locationId);
  const byId = new Map(menu.map((i) => [i.id, i]));

  // Candidate phrases: the whole message, plus whatever the interpreter pulled out.
  const candidates = [rawText, ...interpretation.items.map((i) => i.phrase), ...interpretation.items.flatMap((i) => i.modifierPhrases)]
    .map((c) => c.trim())
    .filter(Boolean);

  const updated = pending.map((spec) => ({ ...spec, modifierIds: [...spec.modifierIds] }));
  let matched = false;

  for (const spec of updated) {
    const item = byId.get(spec.menuItemId);
    if (!item) continue;

    for (const group of item.modifierGroups) {
      const already = spec.modifierIds.some((id) => group.modifiers.some((m) => m.id === id));
      if (already) continue;

      for (const phrase of candidates) {
        const hit = matchModifier(group, phrase);
        if (hit && hit.availability === 'AVAILABLE') {
          spec.modifierIds.push(hit.id);
          matched = true;
          break;
        }
      }
    }
  }

  return matched ? updated : null;
}

/* ────────────────── phrase resolution ────────────────── */

export type Resolution = { specs: LineSpec[]; problems: string[] };

async function resolvePhrases(ctx: ToolContext, interpretation: Interpretation): Promise<Resolution> {
  const menu = await getMenu(ctx.scope, ctx.locationId);
  const specs: LineSpec[] = [];
  const problems: string[] = [];

  for (const phrase of interpretation.items) {
    const matches = await searchMenu(ctx.scope, ctx.locationId, phrase.phrase, 3);

    if (matches.length === 0) {
      problems.push(`I couldn't find "${phrase.phrase}" on our menu.`);
      continue;
    }
    const top = matches[0];
    const runnerUp = matches[1];

    if (top.score < ACCEPT_THRESHOLD) {
      problems.push(`Did you mean ${matches.slice(0, 3).map((m) => m.item.name).join(' or ')}?`);
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
      problems.push(
        subs.length
          ? `${item.name} is ${item.availability === 'SOLD_OUT' ? 'sold out' : 'unavailable'} today. Would you like ${subs.map((s) => s.name).join(' or ')} instead?`
          : `${item.name} is ${item.availability === 'SOLD_OUT' ? 'sold out' : 'unavailable'} today.`);
      continue;
    }

    const { modifierIds, unmatched } = resolveModifiers(item, phrase.modifierPhrases);
    const notes = [phrase.notes, ...unmatched].filter(Boolean).join('; ');

    specs.push({
      menuItemId: item.id,
      quantity: phrase.quantity,
      modifierIds,
      notes,
      aiConfidence: Number(Math.min(top.score, interpretation.confidence).toFixed(3)),
    });
  }

  applyPartialSignalDefaults(specs, menu);
  return { specs, problems };
}

/**
 * Required-choice policy, derived from the two worked examples in the spec:
 *
 *   "One chicken biryani."            -> ASK  ("regular or spicy?")
 *   "2 chicken biryani, one spicy."   -> DEFAULT the other one to Regular
 *
 * The difference is whether the customer showed they already know the options.
 * If ANY line of the same dish specifies a choice in a required group, sibling
 * lines take that group's configured default instead of triggering another
 * question. If nobody specified anything, we ask — we never silently guess.
 */
function applyPartialSignalDefaults(specs: LineSpec[], menu: ResolvedItem[]): void {
  const byId = new Map(menu.map((i) => [i.id, i]));

  for (const spec of specs) {
    const item = byId.get(spec.menuItemId);
    if (!item) continue;

    for (const group of item.modifierGroups) {
      if (!group.isRequired) continue;
      const ids = new Set(group.modifiers.map((m) => m.id));
      if (spec.modifierIds.some((id) => ids.has(id))) continue;   // already chosen

      const siblingChose = specs.some((other) =>
        other !== spec &&
        other.menuItemId === spec.menuItemId &&
        other.modifierIds.some((id) => ids.has(id)));
      if (!siblingChose) continue;                                 // no signal -> ask

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
        if (!modifierIds.includes(m.id)) modifierIds.push(m.id);
        hit = true;
        break;
      }
    }
    // Unmatched phrases become kitchen notes rather than silently vanishing.
    if (!hit) unmatched.push(phrase);
  }
  return { modifierIds, unmatched };
}

function existingSpecs(order: OrderView): LineSpec[] {
  return order.items.map((i) => ({
    menuItemId: i.menuItemId, quantity: i.quantity,
    modifierIds: i.modifiers.map((m) => m.modifierId),
    notes: i.notes, aiConfidence: i.aiConfidence ?? undefined,
  }));
}

function removeFromDraft(order: OrderView, phrases: string[]): LineSpec[] {
  const keep = order.items.filter((item) =>
    !phrases.some((p) => {
      const needle = p.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      const hay = item.name.toLowerCase();
      return needle.length > 2 && (hay.includes(needle) || needle.includes(hay));
    }));
  return keep.map((i) => ({
    menuItemId: i.menuItemId, quantity: i.quantity,
    modifierIds: i.modifiers.map((m) => m.modifierId),
    notes: i.notes, aiConfidence: i.aiConfidence ?? undefined,
  }));
}

async function upsertDraft(
  ctx: ToolContext, draftOrderId: string | null, specs: LineSpec[], input: AgentInput,
  requestedPickupAt: Date | null = null,
): Promise<{ orderId: string; order: OrderView; allocation: SlotAllocation; pricing: PricedOrder }> {
  const { createDraftOrder, updateDraftOrder } = await import('../../orders/service');

  const result = draftOrderId
    ? await updateDraftOrder(ctx.scope, { orderId: draftOrderId, specs, at: ctx.now, requestedPickupAt })
    : await createDraftOrder(ctx.scope, {
        locationId: ctx.locationId, customerId: ctx.customerId,
        conversationId: input.conversationId, specs,
        channel: input.channel === 'WHATSAPP_VOICE' ? 'WHATSAPP_VOICE' : input.channel === 'SIMULATOR' ? 'SIMULATOR' : 'WHATSAPP_TEXT',
        at: ctx.now, requestedPickupAt,
      });

  if (!draftOrderId) await setActiveDraft(ctx.scope, input.conversationId, result.order.id);

  /**
   * A line that cannot be priced yet — "one veg biryani" before we know the
   * spice level — is NOT written to order_items, because there is no honest
   * price for it. That means the question it raises cannot be re-derived from
   * the order later. So the requested specs live in conversation memory until
   * they resolve. Without this, the assistant answers "Anything else?" to a
   * customer it has not actually understood.
   */
  await setState(ctx.scope, input.conversationId, {
    pendingSpecs: result.pricing.priceable ? null : specs,
  });

  return { orderId: result.order.id, order: result.order, allocation: result.allocation, pricing: result.pricing };
}

/* ────────────────── reply composition ────────────────── */

function summariseLines(order: OrderView, currency: string): string {
  return order.items.map((i) => {
    const mods = i.modifiers.map((m) => m.name);
    if (i.notes) mods.push(i.notes);
    return `• ${i.quantity} x ${i.name}${mods.length ? ` (${mods.join(', ')})` : ''} — ${formatCents(i.lineTotalCents, currency)}`;
  }).join('\n');
}

async function presentOrder(
  ctx: ToolContext, tools: ReturnType<typeof makeTools>['tools'],
  order: OrderView, currency: string, timezone: string,
  allocation?: SlotAllocation, pricing?: PricedOrder,
): Promise<string> {
  if (order.status === 'CLARIFICATION_REQUIRED' || order.status === 'DRAFT') {
    // Use the issues from THIS turn's pricing when we have them; they include
    // lines that were dropped for being unpriceable.
    if (pricing?.issues.length) {
      return pricing.issues.slice(0, 2).map(describeIssue).join(' ');
    }
    return clarificationFor(ctx, order);
  }
  const lines = [
    `Here's your order:`,
    summariseLines(order, currency),
    ``,
    `Subtotal: ${formatCents(order.subtotalCents, currency)}`,
  ];
  if (order.discountCents > 0) lines.push(`Discount: -${formatCents(order.discountCents, currency)}`);
  if (order.taxCents > 0) lines.push(`Tax: ${formatCents(order.taxCents, currency)}`);
  lines.push(`Total: ${formatCents(order.totalCents, currency)}`);
  lines.push(``);

  // The pickup line comes from the SLOT ENGINE, never from a prep-time guess.
  if (allocation && !allocation.ok) {
    lines.push(allocation.text);
    return lines.join('\n');
  }
  const slotText = allocation && allocation.ok
    ? allocation.text
    : order.promisedReadyAt
      ? `The earliest pickup for this order is ${formatLocalTime(order.promisedReadyAt, timezone)}.`
      : `I'll confirm a pickup time in a moment.`;

  lines.push(slotText);
  lines.push(`Shall I confirm?`);
  return lines.join('\n');
}

/**
 * Turns the pricing engine's structured issues into the question a person
 * would actually ask. Re-prices so the issue list is current.
 */
async function clarificationFor(ctx: ToolContext, order: OrderView): Promise<string> {
  // Persisted lines first, then anything still pending from the last turn.
  const pending = ctx.conversationId
    ? ((await getConversation(ctx.scope, ctx.conversationId))?.state as any)?.pendingSpecs as LineSpec[] | null
    : null;

  const specs = pending?.length ? pending : existingSpecs(order);
  if (specs.length === 0) return `What would you like?`;

  const preview = await makeTools(ctx).tools.calculate_order(specs);
  const issues = preview.issues;
  if (issues.length === 0) return `Anything else, or shall I place that?`;
  return issues.slice(0, 2).map(describeIssue).join(' ');
}

async function answerMenuQuestion(ctx: ToolContext, text: string, interpretation: Interpretation): Promise<string> {
  const menu = await getMenu(ctx.scope, ctx.locationId);
  const lower = text.toLowerCase();

  if (/\bvegan\b/.test(lower)) {
    const vegan = menu.filter((i) => i.isVegan && i.availability === 'AVAILABLE');
    return vegan.length ? `Our vegan options: ${vegan.map((i) => i.name).join(', ')}.` : `We don't have vegan items marked on the menu right now.`;
  }
  if (/\bvegetarian|veggie\b/.test(lower)) {
    const veg = menu.filter((i) => i.isVegetarian && i.availability === 'AVAILABLE');
    return veg.length ? `Our vegetarian options: ${veg.map((i) => i.name).join(', ')}.` : `We don't have vegetarian items marked on the menu right now.`;
  }

  // "how much is X" / "do you have X"
  const probe = interpretation.items[0]?.phrase ?? text;
  const matches = await searchMenu(ctx.scope, ctx.locationId, probe, 3);
  if (matches.length && matches[0].score >= 0.5) {
    const item = matches[0].item;
    if (item.availability !== 'AVAILABLE') {
      const subs = menu.filter((m) => item.substituteItemIds.includes(m.id) && m.availability === 'AVAILABLE');
      return subs.length
        ? `${item.name} is unavailable today. ${subs.map((s) => s.name).join(' or ')} instead?`
        : `${item.name} is unavailable today.`;
    }
    return `Yes — ${item.name} is ${formatCents(item.priceCents, ctx.currency)}. Want me to add one?`;
  }

  const categories = [...new Set(menu.map((i) => i.categoryName))];
  return `We have ${categories.join(', ')}. What sounds good?`;
}

/** Allergens: answer ONLY from verified data, otherwise hand to a human. Section 67. */
async function answerAllergen(
  ctx: ToolContext, tools: ReturnType<typeof makeTools>['tools'], text: string,
): Promise<{ reply: string; escalate: boolean }> {
  const matches = await searchMenu(ctx.scope, ctx.locationId, text, 1);
  if (matches.length === 0 || matches[0].score < 0.45) {
    return {
      reply: `I don't have verified allergen information for that. Let me connect you with the restaurant team so you get an accurate answer.`,
      escalate: true,
    };
  }
  const details = await tools.get_item_details(matches[0].item.id);
  if (!details || details.allergens === null) {
    return {
      reply: `I don't have verified allergen information for ${matches[0].item.name}. Let me connect you with the restaurant team.`,
      escalate: true,
    };
  }
  return {
    reply: details.allergens.length
      ? `${details.name} contains: ${details.allergens.join(', ')}. If you have a serious allergy, please confirm with the restaurant before ordering.`
      : `${details.name} has no declared allergens from our list. If you have a serious allergy, please confirm with the restaurant before ordering.`,
    escalate: false,
  };
}

/* ────────────────── helpers ────────────────── */

async function latestLiveOrder(ctx: ToolContext, tools: ReturnType<typeof makeTools>['tools']) {
  const id = await latestLiveOrderId(ctx);
  return id ? tools.get_order_status({ orderId: id }) : null;
}

async function latestLiveOrderId(ctx: ToolContext): Promise<string | null> {
  const db = await getDb();
  const { rows } = await db.execute(
    `SELECT id FROM orders
     WHERE restaurant_id = $1 AND customer_id = $2
       AND status IN ('CONFIRMED','RECEIVED','ACCEPTED','PREPARING','READY')
     ORDER BY created_at DESC LIMIT 1;`,
    [ctx.scope.restaurantId, ctx.customerId],
  );
  return rows[0]?.id ?? null;
}

function humanStatus(status: string): string {
  return {
    CONFIRMED: 'confirmed', RECEIVED: 'with the restaurant', ACCEPTED: 'accepted',
    PREPARING: 'being prepared', READY: 'ready for pickup', PICKED_UP: 'picked up',
    COMPLETED: 'complete', CANCELLED: 'cancelled', REJECTED: 'declined',
  }[status] ?? status.toLowerCase().replace(/_/g, ' ');
}

async function deliver(input: AgentInput, text: string, sink: string[]): Promise<void> {
  sink.push(text);
  await recordOutbound(input.scope, {
    conversationId: input.conversationId, body: text, authorType: 'AI', category: 'TRANSACTIONAL',
  });
}

function done(
  replies: string[], intent: string, escalated: boolean, orderId: string | null,
  orderStatus: string | null, confidence: number, usedFallback: boolean,
  calls: Array<{ name: string; ms: number }>,
): AgentOutput {
  return {
    replies, intent, escalated, orderId, orderStatus, confidence, usedFallback,
    toolCalls: calls.map((c) => ({ name: c.name, ms: c.ms })),
  };
}

async function logInteraction(input: AgentInput, args: {
  purpose: string; intent: string; confidence: number;
  calls: Array<{ name: string; args: unknown; result: unknown; ms: number }>;
  providerName: string; modelName: string;
  promptTokens: number; completionTokens: number; costMicroUsd: number;
  latencyMs: number; escalated?: boolean; orderId?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.drizzle.insert(aiInteractions).values({
    id: newId('ai'), restaurantId: input.scope.restaurantId,
    conversationId: input.conversationId, orderId: args.orderId ?? null,
    purpose: args.purpose, provider: args.providerName, model: args.modelName,
    promptTokens: args.promptTokens, completionTokens: args.completionTokens,
    costMicroUsd: args.costMicroUsd, latencyMs: args.latencyMs,
    toolCalls: args.calls.map((c) => ({ name: c.name, ms: c.ms })),
    confidence: args.confidence, escalated: args.escalated ?? false,
    correlationId: input.scope.correlationId,
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

export { findOrCreateConversation, setState };
