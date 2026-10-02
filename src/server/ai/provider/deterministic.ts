/**
 * Offline, rule-based AI provider.
 *
 * Purpose: every test, the demo restaurant and local development run the FULL
 * ordering pipeline with zero API keys and zero network. It implements the same
 * AIProvider interface as the hosted models, so nothing downstream changes, and
 * it is the production fallback when a hosted model errors or times out.
 *
 * It reports only what the customer SAID — phrases, quantities, modifier words,
 * the subject of a question. Whether a dish exists, what it costs and when it
 * can be ready are decided by the backend against the database.
 */
import type {
  AIProvider, ChatMessage, ChatOptions, ChatResult, StructuredResult, TranscriptResult, Usage,
} from './types';
import { emptyUsage } from './types';
import { normaliseInterpretation, type Interpretation, type Intent, type ItemPhrase } from '../interpretation';
import {
  detectLanguage, normaliseForMatching, HINDI_CONFIRM, HINDI_DENY, HINDI_QUESTION_CUES, type Language,
} from '../language';

export class DeterministicProvider implements AIProvider {
  readonly name = 'deterministic';

  async chat(messages: ChatMessage[], _opts?: ChatOptions): Promise<ChatResult> {
    return { text: messages.at(-1)?.content ?? '', usage: emptyUsage(this.name, 'rules-v2') };
  }

  async structuredOutput<T>(messages: ChatMessage[], _schema: Record<string, unknown>, _opts?: ChatOptions): Promise<StructuredResult<T>> {
    const started = Date.now();
    const userText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const value = interpret(userText) as unknown as T;
    const usage: Usage = { ...emptyUsage(this.name, 'rules-v2', Date.now() - started), promptTokens: Math.ceil(userText.length / 4) };
    return { value, usage, raw: JSON.stringify(value) };
  }

  async transcribe(audio: Uint8Array, _mime: string, _hint?: string): Promise<TranscriptResult> {
    return { text: new TextDecoder().decode(audio), language: 'en', confidence: 0.9, usage: emptyUsage(this.name, 'rules-v2') };
  }

  async embed(texts: string[]) {
    const vectors = texts.map((t) => {
      const v = new Array(64).fill(0);
      for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 64] += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
    return { vectors, usage: emptyUsage(this.name, 'rules-v2') };
  }
}

/* ═══════════════════════ vocabulary ═══════════════════════ */

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, dozen: 12,
};

/** How a dish is made — never what the dish is. Longest first. */
const DESCRIPTORS = [
  'extra spicy', 'very spicy', 'double spicy', 'less spicy', 'medium spicy', 'mild spicy', 'not spicy',
  'no spice', 'extra hot', 'spicy', 'regular', 'mild', 'hot', 'normal', 'medium', 'plain',
];
const DESCRIPTOR_TOKENS = new Set(DESCRIPTORS.flatMap((d) => d.split(' ')));
/** "both spicy", "one spicy", "the other regular". */
const SCOPE_WORDS = new Set(['both', 'all', 'each', 'every', 'other', 'another', 'rest', 'the', 'of', 'them', 'one']);
const LEADERS = new Set(['extra', 'no', 'without', 'with', 'hold', 'light', 'double', 'less', 'more']);
const UNIT_WORDS = /^(?:plates?|pcs|pieces?|nos|packets?|bottles?|cans?|glasses?|portions?|servings?|full|half)\s+/i;

const CONFIRM_RE = /^\s*(y|ya|yes|yeah|yep|yup|yess+|sure|ok|okay|k|kk|confirm(?:ed)?|confirm (?:it|order|my order|please)|yes,?\s*(?:please|confirm|go ahead|place it)|that'?s (?:right|correct|it)|correct|place (?:it|the order|my order)|go ahead|do it|book it|sounds good|perfect|done|👍|👌|✅|✔|🆗)\s*[!.]*\s*$/iu;
const DENY_RE = /^\s*(no|nope|nah|not quite|wrong|incorrect|n|not yet|wait)\s*[!.]*\s*$/i;
const GREETING_ONLY = /^\s*(hi+|hello+|hey+|hiya|yo|hola|namaste|namaskar|salaam|good\s+(?:morning|afternoon|evening|night))(?:\s+(?:there|team|all|everyone|bhai|bhaiya|sir|madam|ji))?[\s!.,🙏👋]*$/iu;
const GREETING_PREFIX = /^\s*(?:hi+|hello+|hey+|hiya|yo|hola|namaste|namaskar|good\s+(?:morning|afternoon|evening))(?:\s+(?:there|team|bhai|bhaiya|sir|madam|ji))?[\s!.,]+/iu;
const SMALL_TALK = /^\s*(thanks?|thank you(?: so much)?|thx|ty|ok(?:ay)?\s+(?:thanks?|thank you|cool|great)|cool|great|awesome|nice|got it|alright|shukriya|dhanyavaad|dhanyawad|🙏|😊|❤️|♥️)[\s!.]*$/iu;

const ORDER_REQUEST = /\b(?:can|could|may)\s+(?:i|we)\s+(?:get|have|order|grab)\b|\bi(?:'d| would)\s+(?:like|love)\b|\bi\s+(?:want|need)\b|\bi'?ll\s+(?:have|take)\b|\bgive me\b|\bget me\b|\bgimme\b|\bsend me\b|\bplease add\b|^\s*add\b/i;
const INTERROGATIVE_START = /^\s*(?:is|are|was|do|does|did|can you|could you|will you|what|whats|what's|which|where|when|how|any|got any|have you got|kya)\b/i;

const PATTERNS: Array<{ intent: Intent; re: RegExp }> = [
  { intent: 'HUMAN_REQUEST', re: /\b(?:speak|talk|chat|connect)\s+(?:to|with)\s+(?:a\s+|the\s+)?(?:human|person|someone|somebody|staff|manager|owner|agent)\b|\breal person\b|\bcan (?:a|someone|somebody)\s+(?:real\s+)?(?:person|human)\b|\bcall me\b/i },
  { intent: 'REPEAT_LAST_ORDER', re: /\b(?:my usual|the usual|same as (?:last time|before|usual)|same again|usual please|repeat (?:my |the )?(?:last )?order|reorder|order again)\b/i },
  { intent: 'ORDER_HISTORY_QUESTION', re: /\bwhat did i (?:order|get|have)\b|\bmy (?:last|previous) order\b(?!.*\b(?:status|ready)\b)/i },
  { intent: 'ORDER_STATUS', re: /\b(?:where(?:'?s| is)|status|track(?:ing)?|update on|any update)\b.*\border\b|\border\b.*\b(?:status|ready|done|update)\b|\bis (?:it|my order|my food) ready\b|\bhow(?:'?s| is) my order\b/i },
  { intent: 'CANCEL_ORDER', re: /^\s*cancel\s*[.!]*\s*$|\bcancel\s+(?:it|that|this|my order|the order|order|everything|all of it)\b|\bnever ?mind\b|\bforget it\b|\bscrap (?:it|that)\b|\bdon'?t want (?:it|anything)\b/i },
  { intent: 'GROUP_ORDER', re: /\bfor\s+(?:\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s*(?:people|persons|pax|guests|of us|ppl|adults)\b|\b(?:catering|bulk order|large order|office (?:lunch|party)|party order)\b/i },
];

/** Allergen vocabulary (dishes like paneer are NOT allergen words; dairy is). */
const ALLERGEN_WORDS = '(?:peanuts?|nuts?|tree ?nuts?|almonds?|cashews?|gluten|wheat|dairy|milk|lactose|shellfish|prawns?|shrimps?|crab|fish|soya?|soybeans?|eggs?|sesame|mustard|celery)';
const ALLERGEN_RE = new RegExp([
  String.raw`\ballerg\w+\b`,
  String.raw`\b(?:contains?|containing)\b[\s\S]*\b${ALLERGEN_WORDS}\b`,
  String.raw`\b(?:does|do|is|are|any|has|have)\b[\s\S]*\b${ALLERGEN_WORDS}\b`,
  String.raw`\b${ALLERGEN_WORDS}\b[^?]*\?`,
  String.raw`\b(?:gluten|dairy|nut|lactose|egg)[- ]free\b`,
].join('|'), 'i');
const DIETARY_RE = /\b(?:veg|veggie|vegetarian|vegan|non[- ]?veg|jain|halal|eggless|egg[- ]free)\b/i;

const QUESTION_WORDS = new Set([
  'do', 'does', 'did', 'you', 'u', 'have', 'has', 'got', 'any', 'is', 'are', 'was', 'the', 'a', 'an', 'what', 'whats',
  'which', 'how', 'much', 'many', 'for', 'of', 'in', 'there', 'your', 'price', 'cost', 'costs', 'rate', 'kitna',
  'kitne', 'kitni', 'ka', 'ki', 'ke', 'hai', 'kya', 'available', 'serve', 'sell', 'today', 'it', 'this', 'that',
  'can', 'i', 'we', 'get', 'tell', 'me', 'please', 'options', 'option', 'items', 'item', 'menu', 'on', 'contain',
  'contains', 'free', 'veg', 'veggie', 'vegetarian', 'vegan', 'non', 'jain', 'halal', 'with', 'where', 'when',
  'still', 'stock', 'left', 'some', 'something', 'dish', 'dishes',
]);

/* ═══════════════════════ time phrases ═══════════════════════ */

const T = String.raw`\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|baje|bje|o'?clock)?`;
const TIME_RES: RegExp[] = [
  new RegExp(String.raw`(?:(?:i'?ll|i will|we'?ll|we will|i can|can i|could i|will|i'?m|i am|gonna)\s+)?(?:pick(?:\s+(?:it|them|this|that|the order))?\s*up|pickup|collect(?:\s+(?:it|them))?|come(?:\s+by)?|be there|arrive|reach|get there|be ready)?\s*(?:(?:it|them)\s+)?(?:at|around|by|after|before|till|until|@)\s*${T}\b`, 'gi'),
  /\bin\s+(?:\d{1,3}|an?|one|half an?)\s*(?:min(?:ute)?s?|hours?|hrs?)\b/gi,
  new RegExp(String.raw`\b\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|baje|bje|o'?clock)(?![a-z])`, 'gi'),
];
const PICKUP_VERBS = /\b(?:i'?ll|i will|we'?ll|can i|could i)?\s*(?:pick(?:\s+(?:it|them))?\s*up|pickup|collect(?:\s+it)?|come by|come)\b(?:\s+(?:it|later|myself|instead))?/gi;

export function hasTimeRequest(text: string): boolean {
  return TIME_RES.some((re) => { re.lastIndex = 0; return re.test(text); });
}

function stripTimePhrases(text: string): string {
  let out = text;
  for (const re of TIME_RES) { re.lastIndex = 0; out = out.replace(re, ' '); }
  if (out !== text) { PICKUP_VERBS.lastIndex = 0; out = out.replace(PICKUP_VERBS, ' '); }
  return out.replace(/\s+/g, ' ').trim();
}

/* ═══════════════════════ cleaning ═══════════════════════ */

const FILLER_PHRASES = [
  "i would like to have", "i would like", "i'd like", "i would love", "i'd love", "i'll have", "i will have", "i'll take",
  "i will take", "i want to order", "i want", "i wanted", "i need", "we need", "we want", "we would like",
  "we'll have", "can i get", "can i have", "could i get", "could i have", "may i have", "may i get",
  "can you give me", "can we get", "give me", "get me", "gimme", "lemme get", "let me get", "let me have",
  "send me", "send", "add", "order", "include", "pack", "make me", "please", "pls", "plz", "kindly",
  "thank you", "thanks", "thx", "actually", "also", "just", "um", "uh", "hmm", "ok so", "okay so", "so",
  "then", "for me", "for us", "to go", "take away", "takeaway", "parcel", "for pickup", "bhai", "bhaiya",
  "boss", "sir", "madam", "yaar", "ji", "mujhe", "mujhko", "hume", "humein",
].sort((a, b) => b.length - a.length);

const FILLER_RE = new RegExp(String.raw`\b(?:${FILLER_PHRASES.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})\b`, 'gi');
const LEADING_VERB = /^(?:(?:i|we)\s+)?(?:(?:will|would|'ll|'d)\s+)?(?:like|want|need|have|take|get|grab|bring)(?:\s+to\s+(?:have|order|get))?\s+/i;
const NOISE = /^(?:it|that|this|them|those|these|me|you|order|food|something|anything|stuff|everything|the|a|an|ok|okay|yes|no|hi|hello|thanks|and|or|more|too|as well)$/i;

function clean(clause: string): string {
  return clause
    .replace(GREETING_PREFIX, ' ')
    .replace(FILLER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_VERB, '')
    .trim();
}

/** Splits a message into orderable clauses: commas, "and", newlines, bullets, sentences, brackets. */
export function splitClauses(text: string): string[] {
  const s = text
    .replace(/\r/g, '')
    .replace(/^\s*[-*•·]\s*/gm, '')
    .replace(/\n+/g, ' , ')
    .replace(/[()[\]{}]/g, ' , ')
    .replace(/(?<!\d)\.(?!\d)/g, ' , ')
    .replace(/[;&+|]/g, ' , ')
    .replace(/\b(?:and|plus|also|aur|then|with that|along with)\b/gi, ' , ');
  return s.split(',').map((c) => c.trim()).filter(Boolean).flatMap(expandQuantityRuns);
}

/** "1 spicy 1 regular" → ["1 spicy", "1 regular"]; "one spicy one regular" likewise. */
function expandQuantityRuns(clause: string): string[] {
  const tokens = clause.toLowerCase().split(/\s+/);
  const isQty = (t: string) => /^\d{1,3}$/.test(t) || (NUMBER_WORDS[t] !== undefined && t !== 'a' && t !== 'an');
  const allModifiers = tokens.every((t) => isQty(t) || DESCRIPTOR_TOKENS.has(t) || SCOPE_WORDS.has(t));
  const qtyCount = tokens.filter(isQty).length;
  if (!allModifiers || qtyCount < 2) return [clause];
  const parts: string[][] = [];
  for (const t of clause.split(/\s+/)) {
    if (isQty(t.toLowerCase()) || parts.length === 0) parts.push([t]); else parts[parts.length - 1].push(t);
  }
  return parts.map((p) => p.join(' '));
}

function leadingQuantity(clause: string): { quantity: number | null; rest: string } {
  const digit = clause.match(/^\s*(\d{1,3})\s*(?:x|×|\*)?\s+(.*)$/i);
  if (digit) return { quantity: Number(digit[1]), rest: digit[2].replace(UNIT_WORDS, '') };
  const dozen = clause.match(/^\s*(?:a|one)\s+dozen\s+(.*)$/i);
  if (dozen) return { quantity: 12, rest: dozen[1] };
  const word = clause.match(/^\s*([a-z]+)\s+(.*)$/i);
  if (word && NUMBER_WORDS[word[1].toLowerCase()] !== undefined) {
    return { quantity: NUMBER_WORDS[word[1].toLowerCase()], rest: word[2].replace(UNIT_WORDS, '') };
  }
  return { quantity: null, rest: clause };
}

function trailingQuantity(phrase: string): { quantity: number | null; rest: string } {
  const m = phrase.match(/^(.*?)\s+[x×*]\s*(\d{1,3})\s*$/i) ?? phrase.match(/^(.*?)\s+(\d{1,3})\s*(?:nos|pcs|plates?|pieces?)\s*$/i);
  return m ? { quantity: Number(m[2]), rest: m[1].trim() } : { quantity: null, rest: phrase };
}

/** Pulls "with X", "no X", "extra X", "without X" and descriptor words out of a phrase. */
function extractModifiers(phrase: string): { base: string; modifiers: string[] } {
  const modifiers: string[] = [];
  let base = ` ${phrase} `;

  const withRe = /\b(with|w\/|no|without|hold(?:\s+the)?|extra|double|light|less)\s+([a-z][a-z ]*?)(?=\s+(?:with|w\/|no|without|hold|extra|double|light|less)\b|\s*$)/gi;
  let m: RegExpExecArray | null;
  const found: string[] = [];
  while ((m = withRe.exec(phrase)) !== null) {
    const lead = m[1].toLowerCase().replace(/\s+the$/, '');
    const body = m[2].trim();
    if (!body) continue;
    if (lead === 'with' || lead === 'w/') modifiers.push(body);
    else if (lead === 'hold' || lead === 'without' || lead === 'no') modifiers.push(`no ${body}`);
    else modifiers.push(`${lead} ${body}`);
    found.push(m[0]);
  }
  for (const f of found) base = base.replace(f, ' ');
  base = base.replace(/\s+/g, ' ').trim();

  // Descriptors at the end ("chicken biryani spicy") or start ("spicy chicken biryani").
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of DESCRIPTORS) {
      const lower = base.toLowerCase();
      if (lower.endsWith(` ${d}`) && base.length > d.length + 1) {
        modifiers.push(d); base = base.slice(0, -d.length).trim(); changed = true; break;
      }
      const rest = lower.startsWith(`${d} `) ? base.slice(d.length).trim() : null;
      if (rest && rest.split(/\s+/).length >= 2) {
        modifiers.push(d); base = rest; changed = true; break;
      }
    }
  }
  return { base, modifiers };
}

function isModifierOnly(text: string, hadQuantity: boolean): boolean {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.every((t) => DESCRIPTOR_TOKENS.has(t) || SCOPE_WORDS.has(t))) {
    return tokens.some((t) => DESCRIPTOR_TOKENS.has(t));
  }
  return !hadQuantity && LEADERS.has(tokens[0]) && tokens.length <= 4;
}

/* ═══════════════════════ items ═══════════════════════ */

export function extractItems(text: string): ItemPhrase[] {
  const out: ItemPhrase[] = [];
  /**
   * Qualifier clauses ("one spicy", "both regular", "extra raita") apply to
   * the LAST REAL DISH mentioned, splitting its quantity where needed.
   */
  let anchor = -1;

  for (const rawClause of splitClauses(text.replace(/[?!]+/g, ' '))) {
    const noTime = stripTimePhrases(rawClause).replace(/\b(?:code|promo(?:\s*code)?|coupon)\s*[:\-]?\s*[a-z0-9]{3,20}\b/gi, ' ');
    const cleaned = clean(noTime);
    if (!cleaned) continue;

    const lead = leadingQuantity(cleaned);
    const trail = trailingQuantity(lead.rest);
    const quantity = lead.quantity ?? trail.quantity;
    const scopeStripped = trail.rest.replace(/^(?:both|all|each|the other|other|another|the rest)\s+/i, '');
    const { base, modifiers } = extractModifiers(scopeStripped);
    const phrase = base.replace(/[^\p{L}\p{N}\s'&-]/gu, ' ').replace(/\s+/g, ' ').trim();

    // A pure qualifier: attach to (and possibly split) the anchor dish.
    const qualifierText = phrase ? `${phrase} ${modifiers.join(' ')}`.trim() : modifiers.join(' ');
    const qualifierOnly = (!phrase && modifiers.length > 0) || (phrase && isModifierOnly(trail.rest, quantity !== null));
    if (qualifierOnly && anchor >= 0) {
      const target = out[anchor];
      const mods = phrase && isModifierOnly(trail.rest, quantity !== null) ? [qualifierText] : modifiers;
      const splitQty = quantity ?? target.quantity;
      if (splitQty < target.quantity) {
        target.quantity -= splitQty;
        out.push({ phrase: target.phrase, quantity: splitQty, modifierPhrases: [...mods] });
      } else {
        target.modifierPhrases.push(...mods);
      }
      continue;
    }

    if (!phrase || phrase.length < 2 || NOISE.test(phrase)) continue;
    out.push({ phrase, quantity: quantity ?? 1, modifierPhrases: modifiers });
    anchor = out.length - 1;
  }
  return out;
}

/** The subject of a question: "do you have mango lassi?" → "mango lassi". */
export function questionProbe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[?!.,]/g, ' ')
    .replace(new RegExp(String.raw`\b${ALLERGEN_WORDS}\b`, 'gi'), ' ')
    .split(/\s+/)
    .filter((w) => w && !QUESTION_WORDS.has(w) && !/^'?s$/.test(w))
    .join(' ')
    .replace(/^\d{1,3}\s+/, '')
    .trim();
}

function findPromoCode(text: string): string | undefined {
  return text.match(/\b(?:code|promo(?:\s*code)?|coupon)\s*[:\-]?\s*([A-Z0-9]{3,20})\b/i)?.[1]?.toUpperCase();
}

function wordToQty(w: string): number | null {
  if (/^\d{1,3}$/.test(w)) return Number(w);
  return NUMBER_WORDS[w.toLowerCase()] ?? null;
}

/* ═══════════════════════ interpret ═══════════════════════ */

export function interpret(input: string): Interpretation {
  const original = String(input || '').replace(/[\u{1F3FB}-\u{1F3FF}\uFE0F]/gu, '').trim();
  if (!original) return normaliseInterpretation({ intent: 'UNKNOWN', confidence: 0 });

  const language: Language = detectLanguage(original);
  const text = language === 'en' ? original : normaliseForMatching(original);
  const base = { language };
  const r = (intent: Intent, extra: Record<string, unknown> = {}, confidence = 0.9) =>
    normaliseInterpretation({ intent, confidence, ...base, ...extra });

  // 1. Pure acknowledgements.
  if (CONFIRM_RE.test(original) || HINDI_CONFIRM.test(original)) return r('CONFIRM', {}, 0.97);
  if (DENY_RE.test(original) || HINDI_DENY.test(original)) return r('DENY', {}, 0.95);
  if (GREETING_ONLY.test(original)) return r('GREETING', {}, 0.95);
  if (SMALL_TALK.test(original)) return r('SMALL_TALK', {}, 0.9);

  const core = text.replace(GREETING_PREFIX, '').trim();
  if (!core) return r('GREETING', {}, 0.95);

  // 2. Hindi question cues (specific enough to check regardless of detected language).
  for (const cue of HINDI_QUESTION_CUES) {
    if (cue.re.test(original)) {
      const probe = questionProbe(normaliseForMatching(original));
      return r(cue.intent as Intent, { question: original, probe }, 0.85);
    }
  }

  // 3. Unambiguous intents.
  for (const { intent, re } of PATTERNS) {
    if (re.test(core)) return r(intent, { question: original }, 0.9);
  }

  const looksLikeQuestion = (/\?\s*$/.test(core) || INTERROGATIVE_START.test(core)) && !ORDER_REQUEST.test(core);

  // 4. Dietary before allergen: "is paneer tikka vegetarian?" is not an allergy question.
  if (looksLikeQuestion && DIETARY_RE.test(core)) return r('DIETARY_QUESTION', { question: original, probe: questionProbe(core) }, 0.85);
  if (ALLERGEN_RE.test(core) && !ORDER_REQUEST.test(core)) return r('ALLERGEN_QUESTION', { question: original, probe: questionProbe(core) }, 0.85);

  // 5. Questions about the restaurant.
  if (/^\s*(?:the\s+)?menu\b|\b(?:send|show)\s+(?:me\s+)?(?:the\s+|your\s+)?menu\b|\bwhat(?:'?s| is) on (?:the|your) menu\b/i.test(core)) {
    return r('MENU_QUESTION', { question: original, probe: '' }, 0.9);
  }
  if (looksLikeQuestion) {
    const probe = questionProbe(core);
    if (/\b(?:open|opens|close[sd]?|closing|hours|timings?)\b/i.test(core)) return r('HOURS_QUESTION', { question: original, probe });
    if (/\bhow long\b|\bhow soon\b|\bwhen will\b.*\bready\b|\bwait(?:ing)? time\b|\bready (?:in|by)\b/i.test(core)) return r('PREP_TIME_QUESTION', { question: original, probe });
    if (/\b(?:deals?|specials?|promos?|promotions?|discounts?|offers?|coupons?)\b/i.test(core)) return r('PROMO_QUESTION', { question: original, probe });
    if (/\bhow much\b|\bcosts?\b|\bprices?\b|\brate\b/i.test(core)) return r('PRICE_QUESTION', { question: original, probe });
    if (/\bdo you (?:have|serve|sell|make)\b|\bgot any\b|\bhave you got\b|\boptions?\b|\bavailable\b|\bwhat (?:do you|can i)\b/i.test(core)) {
      return r('MENU_QUESTION', { question: original, probe });
    }
    if (!hasTimeRequest(core)) return r('FAQ_QUESTION', { question: original, probe }, 0.7);
  }

  // 6. Editing a draft.
  const setRe1 = core.match(/^(?:actually\s+|no\s*,?\s*)?(?:make (?:it|that|them)|change (?:it|that|them)? ?to|update (?:it|that) to|just|only)\s+(\d{1,3}|[a-z]+)\s+(.+)$/i);
  if (setRe1 && wordToQty(setRe1[1]) !== null) {
    return r('ORDER_SET_QUANTITY', { setQuantities: [{ phrase: clean(setRe1[2]), quantity: wordToQty(setRe1[1]) }] }, 0.85);
  }
  const setRe2 = core.match(/\b(?:change|make|update|set)\s+(?:the\s+)?(.+?)\s+(?:to|into)\s+(\d{1,3}|[a-z]+)\s*$/i);
  if (setRe2 && wordToQty(setRe2[2]) !== null) {
    return r('ORDER_SET_QUANTITY', { setQuantities: [{ phrase: clean(setRe2[1]), quantity: wordToQty(setRe2[2]) }] }, 0.8);
  }

  const removal = core.match(/\b(?:remove|delete|take off|take out|drop|cancel|minus|skip|no more|hata do|hatao)\s+(?:the\s+|my\s+)?(.+)$/i);
  if (removal) {
    const removeItems = splitClauses(removal[1]).map((c) => {
      const { quantity, rest } = leadingQuantity(clean(c));
      return { phrase: rest.trim(), quantity: quantity ?? undefined };
    }).filter((x) => x.phrase && !NOISE.test(x.phrase));
    if (removeItems.length) return r('ORDER_REMOVE', { removeItems }, 0.85);
  }

  const modify = core.match(/^(?:actually\s+|and\s+|please\s+)?(?:make|have|can you make|please make)\s+(?:it|them|that|both|all|(?:the|my)\s+(.+?))\s+((?:extra |very |double |less |not |medium |mild )?(?:spicy|regular|mild|hot|normal|plain)|(?:with|without|no|extra|less)\s+.+)\s*$/i);
  if (modify) return r('ORDER_MODIFY', { modifyPhrases: [modify[2].trim()], modifyTarget: modify[1]?.trim() }, 0.85);

  // 7. Group / catering handled above; time-only messages.
  const items = extractItems(core);
  if (items.length === 0 && hasTimeRequest(core)) return r('PICKUP_TIME', { question: original }, 0.85);

  // A message that is only a qualifier ("spicy", "extra raita", "no onions").
  const cleanedCore = clean(stripTimePhrases(core));
  if (items.length === 0 && cleanedCore) {
    const { base: leftover, modifiers } = extractModifiers(cleanedCore);
    if (modifiers.length && (!leftover || isModifierOnly(leftover, false))) {
      return r('ORDER_MODIFY', { modifyPhrases: leftover ? [cleanedCore] : modifiers }, 0.8);
    }
    if (isModifierOnly(cleanedCore, false)) return r('ORDER_MODIFY', { modifyPhrases: [cleanedCore] }, 0.8);
  }

  if (items.length > 0) {
    const hasQuantity = /\b(?:\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple|dozen)\b/i.test(text);
    const hasVerb = ORDER_REQUEST.test(core) || /\b(?:want|order|add|get|give|have|take|please|send)\b/i.test(core);
    // Advisory only: the line confidence the console shows comes from menu matching.
    const confidence = hasQuantity || hasVerb ? 0.9 : 0.45;
    return r('ORDER_ADD', { items, promoCode: findPromoCode(original) }, confidence);
  }

  if (/\?/.test(core)) return r('FAQ_QUESTION', { question: original, probe: questionProbe(core) }, 0.5);
  return r('UNKNOWN', { question: original }, 0.2);
}
