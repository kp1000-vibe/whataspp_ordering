/**
 * Unit + integration tests for the parts that must never silently regress:
 * money, the state machine, slot allocation, segmentation, tenancy, auth,
 * webhook parsing and the interpreter.
 *
 * These run against a real in-memory Postgres (PGlite), not stubs.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb, resetDbCache } from '../src/db/client';
import { migrate } from '../src/db/migrate';

process.env.DATABASE_URL = 'pglite://memory';
process.env.AI_PROVIDER = 'deterministic';
process.env.MESSAGING_PROVIDER = 'mock';
process.env.LOG_LEVEL = 'error';

import { formatCents, applyBps, parsePriceToCents } from '../src/lib/money';
import { toE164, maskPhone } from '../src/lib/phone';
import { localParts, minutesToClock } from '../src/lib/time';
import {
  hashPassword, verifyPassword, encryptSecret, decryptSecret,
  whatsappSignature, verifyWhatsappSignature, newSessionToken, sha256,
} from '../src/lib/crypto';
import {
  canTransition, assertTransition, TRANSITIONS, ORDER_STATUSES, IllegalTransitionError,
} from '../src/server/orders/state-machine';
import { evaluateRule, SYSTEM_SEGMENTS, type CustomerFeatures } from '../src/server/segments/engine';
import { computeDiscount } from '../src/server/promotions/engine';
import { parseMetaWebhook } from '../src/server/messaging/meta-cloud';
import { extractJson } from '../src/server/ai/provider/anthropic';
import { interpret } from '../src/server/ai/provider/deterministic';
import { detectLanguage, normaliseForMatching } from '../src/server/ai/language';
import { detectConsentIntent } from '../src/server/crm/service';
import { parseRequestedTime, slotStartFor } from '../src/server/capacity/slots';
import { scoreItem, normalise } from '../src/server/menu/service';
import { renderKot } from '../src/server/printing/service';
import { assertSameTenant, requireRole, TenantViolationError, ForbiddenError, systemScope } from '../src/server/tenancy';
import { describeIssue } from '../src/server/pricing/engine';
import { on, resetHandlers, handlerCount } from '../src/server/events/bus';

beforeAll(async () => {
  const db = await getDb('pglite://memory');
  await migrate(db);
});

/* ───────────────────────── money ───────────────────────── */

describe('money', () => {
  it('formats INR and USD', () => {
    expect(formatCents(43340, 'USD')).toBe('$433.40');
    expect(formatCents(62000, 'INR')).toBe('₹620.00');
    expect(formatCents(5, 'USD')).toBe('$0.05');
    expect(formatCents(-1250, 'USD')).toBe('-$12.50');
  });

  it('applies basis points with half-up rounding and no float drift', () => {
    expect(applyBps(10000, 850)).toBe(850);
    expect(applyBps(999, 500)).toBe(50);      // 49.95 -> 50
    expect(applyBps(0, 850)).toBe(0);
    // 0.1 + 0.2 style drift is impossible: everything is integers.
    let total = 0;
    for (let i = 0; i < 1000; i++) total += applyBps(1999, 500);
    expect(total).toBe(100000);
  });

  it('parses prices strictly', () => {
    expect(parsePriceToCents('12.99')).toBe(1299);
    expect(parsePriceToCents('$12')).toBe(1200);
    expect(parsePriceToCents('12.9')).toBe(1290);
    expect(parsePriceToCents('abc')).toBeNull();
    expect(parsePriceToCents('12.999')).toBeNull();
  });
});

/* ───────────────────────── phone ───────────────────────── */

describe('phone', () => {
  it('normalises to E.164 and flags assumptions', () => {
    expect(toE164('+919876500001')).toEqual({ phone: '+919876500001', assumedCountryCode: false });
    expect(toE164('919876500001')).toEqual({ phone: '+919876500001', assumedCountryCode: false });
    expect(toE164('(415) 555-1234').assumedCountryCode).toBe(true);
  });
  it('masks for printing', () => {
    expect(maskPhone('+919876500001')).toBe('***0001');
  });
});

/* ───────────────────────── crypto ───────────────────────── */

describe('crypto', () => {
  it('hashes and verifies passwords without storing plaintext', () => {
    const hash = hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain('correct horse battery');
    expect(verifyPassword('correct horse battery', hash)).toBe(true);
    expect(verifyPassword('wrong', hash)).toBe(false);
  });

  it('produces a different hash for the same password (salted)', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('rejects malformed stored hashes instead of throwing', () => {
    expect(verifyPassword('x', 'garbage')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });

  it('round-trips encrypted secrets and fails on tampering', () => {
    const secret = JSON.stringify({ accessToken: 'EAAG...', appSecret: 's3cr3t' });
    const sealed = encryptSecret(secret);
    expect(sealed).not.toContain('s3cr3t');
    expect(decryptSecret(sealed)).toBe(secret);
    const tampered = sealed.slice(0, -4) + 'AAAA';
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('stores only the hash of a session token', () => {
    const { token, id } = newSessionToken();
    expect(id).toBe(sha256(token));
    expect(id).not.toBe(token);
  });

  it('verifies WhatsApp webhook signatures', () => {
    const body = '{"object":"whatsapp_business_account"}';
    const sig = whatsappSignature(body, 'app-secret');
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifyWhatsappSignature(body, sig, 'app-secret')).toBe(true);
    expect(verifyWhatsappSignature(body + ' ', sig, 'app-secret')).toBe(false);
    expect(verifyWhatsappSignature(body, sig, 'other')).toBe(false);
    expect(verifyWhatsappSignature(body, null, 'app-secret')).toBe(false);
    expect(verifyWhatsappSignature(body, 'sha256=short', 'app-secret')).toBe(false);
  });
});

/* ─────────────────── order state machine ─────────────────── */

describe('order state machine', () => {
  it('allows the happy path', () => {
    const path = ['DRAFT', 'READY_FOR_CONFIRMATION', 'CONFIRMED', 'RECEIVED',
      'ACCEPTED', 'PREPARING', 'READY', 'PICKED_UP', 'COMPLETED'] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('refuses skipping confirmation', () => {
    expect(canTransition('DRAFT', 'READY')).toBe(false);
    expect(canTransition('DRAFT', 'CONFIRMED')).toBe(false);
    expect(canTransition('READY_FOR_CONFIRMATION', 'PREPARING')).toBe(false);
    expect(() => assertTransition('DRAFT', 'COMPLETED')).toThrow(IllegalTransitionError);
  });

  it('refuses resurrecting a finished order', () => {
    expect(canTransition('COMPLETED', 'PREPARING')).toBe(false);
    expect(canTransition('REFUNDED', 'COMPLETED')).toBe(false);
    expect(TRANSITIONS.REFUNDED).toHaveLength(0);
  });

  it('defines a transition list for every status', () => {
    for (const status of ORDER_STATUSES) {
      expect(TRANSITIONS[status]).toBeDefined();
    }
  });

  it('never allows a transition to a status that does not exist', () => {
    for (const [, targets] of Object.entries(TRANSITIONS)) {
      for (const target of targets) expect(ORDER_STATUSES).toContain(target);
    }
  });
});

/* ───────────────────── promotions ───────────────────── */

const line = (id: string, qty: number, unit: number) => ({
  menuItemId: id, quantity: qty, unitPriceCents: unit,
  modifiersTotalCents: 0, lineTotalCents: unit * qty,
});

function promo(over: Partial<any>): any {
  return {
    id: 'p1', restaurantId: 'r1', code: null, name: 'test', type: 'PERCENT_OFF',
    value: 0, minSubtotalCents: 0, appliesToItemIds: [], freeItemId: null,
    daysOfWeek: [], startMinute: null, endMinute: null, startsAt: null, endsAt: null,
    firstOrderOnly: false, segmentId: null, maxRedemptions: null, redemptions: 0,
    isActive: true, ...over,
  };
}

describe('promotion maths', () => {
  it('computes percentage off', () => {
    expect(computeDiscount(promo({ type: 'PERCENT_OFF', value: 2000 }), [line('a', 1, 10000)])).toBe(2000);
  });

  it('never discounts more than the eligible subtotal', () => {
    expect(computeDiscount(promo({ type: 'FIXED_OFF', value: 99999 }), [line('a', 1, 10000)])).toBe(10000);
  });

  it('restricts a targeted promotion to its items', () => {
    const p = promo({ type: 'PERCENT_OFF', value: 5000, appliesToItemIds: ['a'] });
    expect(computeDiscount(p, [line('a', 1, 10000), line('b', 1, 10000)])).toBe(5000);
  });

  it('makes the cheapest unit free on BOGO', () => {
    const p = promo({ type: 'BOGO', appliesToItemIds: ['a'] });
    // 3 units at 1000 -> 1 pair -> cheapest unit free
    expect(computeDiscount(p, [line('a', 3, 1000)])).toBe(1000);
    // 4 units -> 2 free
    expect(computeDiscount(p, [line('a', 4, 1000)])).toBe(2000);
  });

  it('returns zero when the free item is not in the order', () => {
    const p = promo({ type: 'FREE_ITEM', freeItemId: 'z' });
    expect(computeDiscount(p, [line('a', 1, 10000)])).toBe(0);
  });
});

/* ───────────────────── segmentation ───────────────────── */

function features(over: Partial<CustomerFeatures> = {}): CustomerFeatures {
  return {
    customerId: 'c1', totalOrders: 0, lifetimeSpendCents: 0, averageOrderCents: 0,
    daysSinceLastOrder: 99999, daysSinceFirstOrder: 99999, cancelledOrders: 0,
    weekendOrderShare: 0, lunchOrderShare: 0, vegetarianItemShare: 0,
    marketing: 'UNKNOWN', tags: [], itemCounts: {}, itemNames: {}, categoryOfItem: {},
    ...over,
  };
}

describe('segment rules', () => {
  const byName = (n: string) => SYSTEM_SEGMENTS.find((s) => s.name === n)!.rule;

  it('identifies loyal customers', () => {
    expect(evaluateRule(byName('Loyal Customers'), features({ totalOrders: 10 }))).toBe(true);
    expect(evaluateRule(byName('Loyal Customers'), features({ totalOrders: 9 }))).toBe(false);
  });

  it('separates At Risk from Lapsed', () => {
    const atRisk = byName('At Risk'), lapsed = byName('Lapsed');
    const f = (d: number) => features({ totalOrders: 3, daysSinceLastOrder: d });
    expect(evaluateRule(atRisk, f(35))).toBe(true);
    expect(evaluateRule(lapsed, f(35))).toBe(false);
    expect(evaluateRule(atRisk, f(70))).toBe(false);
    expect(evaluateRule(lapsed, f(70))).toBe(true);
  });

  it('excludes customers who never ordered from lapsed segments', () => {
    expect(evaluateRule(byName('Lapsed'), features({ totalOrders: 0 }))).toBe(false);
    expect(evaluateRule(byName('Inactive'), features({ totalOrders: 0 }))).toBe(false);
  });

  it('supports nested boolean logic', () => {
    const rule = {
      all: [
        { field: 'totalOrders' as const, op: 'gte' as const, value: 2 },
        { any: [{ hasTag: 'vip' }, { field: 'lifetimeSpendCents' as const, op: 'gt' as const, value: 100000 }] },
        { not: { marketing: 'OPTED_OUT' as const } },
      ],
    };
    expect(evaluateRule(rule, features({ totalOrders: 5, tags: ['vip'] }))).toBe(true);
    expect(evaluateRule(rule, features({ totalOrders: 5, tags: ['vip'], marketing: 'OPTED_OUT' }))).toBe(false);
    expect(evaluateRule(rule, features({ totalOrders: 1, tags: ['vip'] }))).toBe(false);
  });

  it('counts item purchases by name fragment', () => {
    const f = features({
      itemCounts: { i1: 4, i2: 1 },
      itemNames: { i1: 'Chicken Biryani', i2: 'Coke' },
    });
    expect(evaluateRule({ itemPurchases: { nameContains: 'biryani' }, op: 'gte', value: 4 }, f)).toBe(true);
    expect(evaluateRule({ itemPurchases: { nameContains: 'biryani' }, op: 'gte', value: 5 }, f)).toBe(false);
  });
});

/* ─────────────────── webhook parsing ─────────────────── */

describe('Meta webhook parsing', () => {
  it('parses a text message', () => {
    const body = {
      entry: [{ changes: [{ value: {
        metadata: { display_phone_number: '919999000001' },
        contacts: [{ profile: { name: 'Asha' }, wa_id: '919876500001' }],
        messages: [{ from: '919876500001', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: 'hi' } }],
      } }] }],
    };
    const { messages } = parseMetaWebhook(body);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from: '+919876500001', to: '+919999000001', kind: 'TEXT', text: 'hi', profileName: 'Asha' });
  });

  it('parses a voice note', () => {
    const body = {
      entry: [{ changes: [{ value: {
        metadata: { display_phone_number: '919999000001' },
        messages: [{ from: '919876500001', id: 'wamid.2', timestamp: '1700000000', type: 'audio', audio: { id: 'MEDIA1' } }],
      } }] }],
    };
    const { messages } = parseMetaWebhook(body);
    expect(messages[0]).toMatchObject({ kind: 'AUDIO', mediaId: 'MEDIA1' });
  });

  it('parses delivery statuses', () => {
    const body = { entry: [{ changes: [{ value: {
      metadata: { display_phone_number: '1' },
      statuses: [{ id: 'wamid.9', status: 'read', timestamp: '1700000000' }],
    } }] }] };
    expect(parseMetaWebhook(body).statuses[0]).toMatchObject({ providerMessageId: 'wamid.9', status: 'read' });
  });

  it('survives junk without throwing', () => {
    expect(parseMetaWebhook({}).messages).toHaveLength(0);
    expect(parseMetaWebhook(null).messages).toHaveLength(0);
    expect(parseMetaWebhook({ entry: [{ changes: [{ value: {} }] }] }).messages).toHaveLength(0);
  });
});

/* ─────────────────── AI plumbing ─────────────────── */

describe('structured output repair', () => {
  it('parses clean JSON', () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  it('unwraps a markdown fence', () => {
    expect(extractJson<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('extracts JSON surrounded by prose', () => {
    expect(extractJson<{ a: number }>('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
  });
  it('throws rather than guessing', () => {
    expect(() => extractJson('not json at all')).toThrow(/did not return valid JSON/);
  });
});

describe('interpreter', () => {
  it('extracts quantities as digits and words', () => {
    expect(interpret('2 chicken biryani').items[0]).toMatchObject({ quantity: 2 });
    expect(interpret('three garlic naan').items[0]).toMatchObject({ quantity: 3 });
    expect(interpret('a coke').items[0]).toMatchObject({ quantity: 1 });
  });

  it('splits a qualifier across a multi-quantity line', () => {
    const r = interpret('2 chicken biryani, one spicy, and 2 coke');
    const biryani = r.items.filter((i) => i.phrase.includes('biryani'));
    expect(biryani).toHaveLength(2);
    expect(biryani.reduce((s, i) => s + i.quantity, 0)).toBe(2);
    expect(biryani.some((i) => i.modifierPhrases.includes('spicy'))).toBe(true);
    expect(r.items.find((i) => i.phrase === 'coke')?.quantity).toBe(2);
  });

  it('never merges two qualifiers onto one line', () => {
    const r = interpret('2 chicken biryani, one spicy, one regular');
    const withSpicy = r.items.filter((i) => i.modifierPhrases.includes('spicy'));
    const withRegular = r.items.filter((i) => i.modifierPhrases.includes('regular'));
    expect(withSpicy).toHaveLength(1);
    expect(withRegular).toHaveLength(1);
    expect(withSpicy[0]).not.toBe(withRegular[0]);
  });

  it('recognises confirmations and denials only when unambiguous', () => {
    expect(interpret('yes').intent).toBe('CONFIRM');
    expect(interpret('Yes!').intent).toBe('CONFIRM');
    expect(interpret('no').intent).toBe('DENY');
    expect(interpret('yes I want 2 cokes').intent).toBe('ORDER_ADD');
  });

  it('routes every allergen phrasing to the allergen intent', () => {
    for (const text of [
      'does the chicken biryani contain peanuts?',
      'is the naan gluten free?',
      "I'm allergic to shellfish",
      'any dairy in this?',
    ]) {
      expect(interpret(text).intent, text).toBe('ALLERGEN_QUESTION');
    }
  });

  it('does not hijack ordinary orders as allergen questions', () => {
    expect(interpret('2 chicken biryani and a coke').intent).toBe('ORDER_ADD');
    expect(interpret('one veg biryani').intent).toBe('ORDER_ADD');
  });

  it('detects removal', () => {
    const r = interpret('actually remove the fries');
    expect(r.intent).toBe('ORDER_REMOVE');
    expect(r.removeItems[0].phrase).toContain('fries');
  });

  it('detects the reorder shortcut', () => {
    expect(interpret('same as last time').intent).toBe('REPEAT_LAST_ORDER');
    expect(interpret('send me my usual').intent).toBe('REPEAT_LAST_ORDER');
  });

  it('asks for a human when asked', () => {
    expect(interpret('can I talk to a person').intent).toBe('HUMAN_REQUEST');
  });

  it('reports low confidence on nonsense so the backend asks instead of guessing', () => {
    const r = interpret('asdkjhasd');
    // The interpreter may still label it ORDER_ADD — deciding whether a thing
    // exists is the menu's job, not the model's — but it must not be confident.
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('is confident when there is a quantity or an ordering verb', () => {
    expect(interpret('2 chicken biryani').confidence).toBeGreaterThan(0.6);
    expect(interpret('I want chicken biryani').confidence).toBeGreaterThan(0.6);
  });
});

describe('language handling', () => {
  it('detects Devanagari', () => {
    expect(detectLanguage('दो चिकन बिरयानी')).toBe('hi');
  });
  it('detects romanised Hindi only with enough evidence', () => {
    expect(detectLanguage('Bhai do chicken biryani dena')).toBe('hi-Latn');
    expect(detectLanguage('two chicken biryani please')).toBe('en');
  });
  it('maps Hindi numerals and modifiers onto English shapes', () => {
    const n = normaliseForMatching('do chicken biryani ek teekha aur ek normal');
    expect(n).toContain('2 chicken biryani');
    expect(n).toContain('spicy');
    expect(n).toContain('regular');
  });
  it('understands Hinglish confirmation', () => {
    expect(interpret('haan').intent).toBe('CONFIRM');
    expect(interpret('nahi').intent).toBe('DENY');
  });
});

/* ─────────────────── consent ─────────────────── */

describe('marketing consent detection', () => {
  it('catches the mandated keywords', () => {
    for (const w of ['STOP', 'stop', 'UNSUBSCRIBE', 'opt out']) {
      expect(detectConsentIntent(w)).toBe('OPT_OUT');
    }
  });
  it('catches natural-language opt-outs', () => {
    expect(detectConsentIntent('please remove me from your list')).toBe('OPT_OUT');
    expect(detectConsentIntent("don't message me again")).toBe('OPT_OUT');
  });
  it('does not opt out on an order that contains the word stop', () => {
    expect(detectConsentIntent('one stop special please')).toBeNull();
  });
  it('detects opt-in', () => {
    expect(detectConsentIntent('START')).toBe('OPT_IN');
  });
});

/* ─────────────────── pickup time parsing ─────────────────── */

describe('requested pickup time', () => {
  const tz = 'Asia/Kolkata';
  // 2026-09-21T12:00:00Z == 17:30 IST
  const now = new Date('2026-09-21T12:00:00Z');

  it('parses relative minutes', () => {
    const t = parseRequestedTime('can I get it in 30 minutes', now, tz);
    expect(t && Math.round((t.getTime() - now.getTime()) / 60000)).toBe(30);
  });

  it('parses an explicit clock time', () => {
    const t = parseRequestedTime("I'll pick it up at 8 pm", now, tz);
    expect(t).not.toBeNull();
    expect(localParts(t!, tz).minuteOfDay).toBe(20 * 60);
  });

  it('assumes the next sensible occurrence when am/pm is omitted', () => {
    const t = parseRequestedTime('pickup around 8', now, tz);
    expect(localParts(t!, tz).minuteOfDay).toBe(20 * 60);
  });

  it('understands "baje"', () => {
    const t = parseRequestedTime('8 baje aa raha hoon', now, tz);
    expect(t).not.toBeNull();
  });

  it('returns null when no time was requested — never guesses', () => {
    expect(parseRequestedTime('2 chicken biryani and 2 coke', now, tz)).toBeNull();
    expect(parseRequestedTime('hi', now, tz)).toBeNull();
  });

  it('rolls a clearly-past morning time to the next day', () => {
    // 09:00 requested at 17:30 means tomorrow morning. The slot engine then
    // refuses it if it falls outside the advance-booking horizon.
    const t = parseRequestedTime('at 9 am', now, tz);
    expect(t).not.toBeNull();
    expect(localParts(t!, tz).minuteOfDay).toBe(9 * 60);
    expect(t!.getTime()).toBeGreaterThan(now.getTime());
  });

  it('returns null for a time that only just passed', () => {
    // 17:00 requested at 17:30 is not a booking, it is a mistake.
    expect(parseRequestedTime('at 5 pm', now, tz)).toBeNull();
  });
});

describe('slot maths', () => {
  it('snaps to slot boundaries', () => {
    const t = new Date('2026-09-21T12:07:33Z');
    expect(slotStartFor(t, 15).toISOString()).toBe('2026-09-21T12:00:00.000Z');
    expect(slotStartFor(t, 30).toISOString()).toBe('2026-09-21T12:00:00.000Z');
    expect(slotStartFor(new Date('2026-09-21T12:47:00Z'), 15).toISOString()).toBe('2026-09-21T12:45:00.000Z');
  });
});

describe('local time', () => {
  it('formats a 12-hour clock', () => {
    expect(minutesToClock(0)).toBe('12:00 AM');
    expect(minutesToClock(12 * 60)).toBe('12:00 PM');
    expect(minutesToClock(19 * 60 + 25)).toBe('7:25 PM');
  });
  it('converts UTC into the restaurant timezone', () => {
    const p = localParts(new Date('2026-09-21T12:00:00Z'), 'Asia/Kolkata');
    expect(p.minuteOfDay).toBe(17 * 60 + 30);
  });
});

/* ─────────────────── menu matching ─────────────────── */

const item = (over: Partial<any> = {}): any => ({
  id: 'i1', categoryId: 'c1', categoryName: 'Biryani', name: 'Chicken Biryani',
  description: 'Hyderabadi dum biryani with chicken', priceCents: 24000, prepMinutes: 22,
  isVegetarian: false, isVegan: false, allergens: ['dairy'],
  aliases: ['murgh biryani', 'chicken dum biryani'], substituteItemIds: [],
  availability: 'AVAILABLE', modifierGroups: [], ...over,
});

describe('menu matching', () => {
  it('scores an exact name as 1', () => {
    expect(scoreItem('chicken biryani', item())).toBe(1);
  });
  it('matches through an alias', () => {
    expect(scoreItem('murgh biryani', item())).toBe(1);
  });
  it('tolerates plurals', () => {
    expect(scoreItem('chicken biryanis', item())).toBeGreaterThan(0.7);
  });
  it('scores an unrelated dish low', () => {
    expect(scoreItem('lobster thermidor', item())).toBeLessThan(0.3);
  });
  it('scores a partial match below a full one', () => {
    expect(scoreItem('biryani', item())).toBeLessThan(scoreItem('chicken biryani', item()));
  });
  it('normalises punctuation and case', () => {
    expect(normalise('Chicken  Biryani!!')).toBe('chicken biryani');
  });
});

/* ─────────────────── printing ─────────────────── */

describe('KOT rendering', () => {
  const order: any = {
    orderNumber: 1048, createdAt: new Date('2026-09-21T13:00:00Z'),
    promisedReadyAt: new Date('2026-09-21T13:55:00Z'),
    subtotalCents: 60000, discountCents: 6000, taxCents: 2700, totalCents: 56700,
    paymentStatus: 'PAY_AT_PICKUP', specialInstructions: 'Ring the bell',
    items: [{
      name: 'Chicken Biryani', quantity: 2, lineTotalCents: 48000, notes: 'no raita',
      modifiers: [{ name: 'Spicy', priceDeltaCents: 0 }],
    }],
  };
  const opts = { restaurantName: 'SpiceBox Biryani', timezone: 'Asia/Kolkata', currency: 'INR' };

  it('prints items, modifiers and notes on a kitchen ticket', () => {
    const kot = renderKot(order, { ...opts, kind: 'KITCHEN' });
    expect(kot).toContain('ORDER #1048');
    expect(kot).toContain('2 x CHICKEN BIRYANI');
    expect(kot).toContain('+ Spicy');
    expect(kot).toContain('! no raita');
    expect(kot).toContain('Ring the bell');
  });

  it('keeps money off the kitchen ticket', () => {
    const kot = renderKot(order, { ...opts, kind: 'KITCHEN' });
    expect(kot).not.toContain('TOTAL');
    expect(kot).not.toContain('567.00');
  });

  it('puts money on the receipt and masks the phone', () => {
    const receipt = renderKot(order, { ...opts, kind: 'RECEIPT', customerPhone: '+919876500001' });
    expect(receipt).toContain('TOTAL');
    expect(receipt).toContain('₹567.00');
    expect(receipt).toContain('***0001');
    expect(receipt).not.toContain('9876500001');
  });

  it('respects the paper width', () => {
    const narrow = renderKot(order, { ...opts, width: 24 });
    for (const l of narrow.split('\n')) expect(l.length).toBeLessThanOrEqual(24);
  });
});

/* ─────────────────── tenancy ─────────────────── */

describe('tenancy guards', () => {
  const scope = systemScope('rst_A', 'corr');

  it('accepts a row from the same restaurant', () => {
    expect(assertSameTenant(scope, { restaurantId: 'rst_A', id: 'x' }).id).toBe('x');
  });
  it('rejects a row from another restaurant', () => {
    expect(() => assertSameTenant(scope, { restaurantId: 'rst_B' })).toThrow(TenantViolationError);
  });
  it('rejects a missing row', () => {
    expect(() => assertSameTenant(scope, null)).toThrow(TenantViolationError);
  });

  it('enforces role hierarchy', () => {
    const kitchen = { ...scope, role: 'KITCHEN' as const };
    const manager = { ...scope, role: 'MANAGER' as const };
    expect(() => requireRole(kitchen, 'MANAGER')).toThrow(ForbiddenError);
    expect(() => requireRole(manager, 'STAFF')).not.toThrow();
    expect(() => requireRole(manager, 'OWNER')).toThrow(ForbiddenError);
    expect(() => requireRole(scope, 'OWNER')).not.toThrow();   // SYSTEM bypasses
  });
});

/* ─────────────────── pricing issue copy ─────────────────── */

describe('pricing issue messages', () => {
  it('asks a real question for a missing required choice', () => {
    const text = describeIssue({
      kind: 'MISSING_REQUIRED_CHOICE', menuItemId: 'i1', itemName: 'Chicken Biryani',
      groupId: 'g1', groupName: 'Spice Level', options: ['Regular', 'Spicy'],
    });
    expect(text).toContain('Chicken Biryani');
    expect(text).toContain('Regular or Spicy');
  });
  it('names the sold-out item', () => {
    expect(describeIssue({ kind: 'ITEM_UNAVAILABLE', menuItemId: 'i1', name: 'Mutton Biryani', status: 'SOLD_OUT' }))
      .toContain('Mutton Biryani');
  });
});


/* ─────────────── event bus idempotency ─────────────── */

describe('event handler registration', () => {
  beforeEach(() => resetHandlers());

  it('replaces rather than appends when the same key registers twice', () => {
    // Regression: a dev hot-reload re-ran bootstrap and every customer got two
    // identical "order confirmed" messages. Registration must be idempotent.
    const register = () => on('order.confirmed', async () => {}, 'notify:confirmed');
    register();
    register();
    register();
    expect(handlerCount('order.confirmed')).toBe(1);
  });

  it('keeps genuinely different subscribers', () => {
    on('order.confirmed', async () => {}, 'notify:confirmed');
    on('order.confirmed', async () => {}, 'usage:orders');
    expect(handlerCount('order.confirmed')).toBe(2);
  });
});
