/**
 * Offline, rule-based AI provider.
 *
 * Purpose: every test, the demo restaurant and local development run the FULL
 * ordering pipeline with zero API keys and zero network. It implements the same
 * AIProvider interface as the hosted models, so nothing downstream changes.
 *
 * It is NOT a toy: it handles quantities (digits and words), multi-item
 * utterances, modifiers, removals, negations, confirmations and the common
 * question intents. It is deliberately conservative — when unsure it returns
 * low confidence and lets the backend ask a clarifying question.
 */
import type {
  AIProvider, ChatMessage, ChatOptions, ChatResult, StructuredResult, TranscriptResult, Usage,
} from './types';
import { emptyUsage } from './types';
import { normaliseInterpretation, type Interpretation, type Intent, type ItemPhrase } from '../interpretation';
import {
  detectLanguage, normaliseForMatching, HINDI_CONFIRM, HINDI_DENY, HINDI_QUESTION_CUES,
  type Language,
} from '../language';

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, dozen: 12,
};

const MODIFIER_LEADERS = [
  'extra', 'no', 'without', 'with', 'add', 'hold', 'light', 'double',
  'spicy', 'mild', 'regular', 'large', 'small', 'medium', 'stuffed', 'thin', 'thick',
];

/**
 * Words that describe HOW an item is made, never WHAT the item is.
 * A clause made only of these attaches to the previous item instead of becoming
 * a phantom order line. This is what makes the canonical utterance
 * "2 chicken biryani, one spicy, 2 coke" parse the way a human hears it.
 */
const MODIFIER_VOCAB = new Set([
  ...MODIFIER_LEADERS,
  'normal', 'plain', 'hot', 'less', 'more', 'half', 'full', 'well', 'done',
  'crispy', 'soft', 'sweet', 'salt', 'salty', 'cheese', 'sauce', 'ice',
  'the', 'one', 'other', 'another', 'rest', 'and',
]);

function isModifierOnlyPhrase(phrase: string): boolean {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return false;
  if (!words.some((w) => MODIFIER_LEADERS.includes(w) || MODIFIER_VOCAB.has(w))) return false;
  return words.every((w) => MODIFIER_VOCAB.has(w));
}

/** Allergen vocabulary, singular and plural, used by the guard regex below. */
const ALLERGEN_WORDS =
  '(?:peanuts?|nuts?|almonds?|cashews?|gluten|wheat|dairy|milk|lactose|cheese|paneer|' +
  'shellfish|prawns?|shrimps?|crab|fish|soya?|soybeans?|eggs?|sesame|mustard|celery)';

const CONFIRM_RE = /^\s*(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|that'?s? right|correct|place it|go ahead|do it|sounds good|perfect|y)\s*[!.]*\s*$/i;
const DENY_RE = /^\s*(no|nope|nah|not quite|wrong|incorrect|n)\s*[!.]*\s*$/i;

const PATTERNS: Array<{ intent: Intent; re: RegExp }> = [
  { intent: 'OPT_OUT', re: /\b(stop|unsubscribe|opt\s*out|remove me from|no more (offers|promos|marketing))\b/i },
  { intent: 'OPT_IN', re: /\b(subscribe|opt\s*in|send me (offers|deals|promos))\b/i },
  { intent: 'HUMAN_REQUEST', re: /\b(speak|talk|connect)\s+(to|with)\s+(a\s+)?(human|person|someone|staff|manager)\b|\breal person\b/i },
  /**
   * Allergen detection is deliberately greedy and sits ABOVE the ordering rules.
   * A false positive costs one extra question; a false negative means an
   * allergy question silently became an order. The regex is plural-tolerant
   * because "peanuts" is what people actually type.
   */
  { intent: 'ALLERGEN_QUESTION', re: new RegExp(
      [
        String.raw`\ballerg\w+\b`,
        String.raw`\b(contains?|contain|containing)\b[\s\S]*\b${ALLERGEN_WORDS}\b`,
        String.raw`\b(does|do|is|are)\b[\s\S]*\b${ALLERGEN_WORDS}\b[\s\S]*\?`,
        String.raw`\b${ALLERGEN_WORDS}\b[^?]*\?`,
        String.raw`\b(gluten[- ]free|dairy[- ]free|nut[- ]free)\b`,
      ].join('|'), 'i') },
  { intent: 'HOURS_QUESTION', re: /\b(open|close|closing|hours|what time)\b.*\?|\bare you open\b|\bwhat are your hours\b/i },
  { intent: 'PREP_TIME_QUESTION', re: /\bhow long\b|\bhow soon\b|\bwhen will (it|my order) be ready\b|\bready in\b/i },
  { intent: 'ORDER_STATUS', re: /\b(where'?s|status of|track)\b.*\border\b|\bis my order ready\b|\border\s*#?\s*\d+\b.*\bstatus\b/i },
  { intent: 'PROMO_QUESTION', re: /\b(deal|deals|special|specials|promo|promotion|discount|offer)\b/i },
  { intent: 'ORDER_HISTORY_QUESTION', re: /\bwhat did i (order|get|have)\b|\blast time\b.*\?|\bmy (last|previous) order\b/i },
  { intent: 'REPEAT_LAST_ORDER', re: /\b(my usual|the usual|same as last time|same again|usual please|send me my usual|repeat my last order)\b/i },
  { intent: 'CANCEL_ORDER', re: /\bcancel\b.*\border\b|\bcancel that\b|\bnever ?mind\b|\bscrap that\b|\bforget it\b/i },
  { intent: 'MENU_QUESTION', re: /\b(what|which|do you have|got any|any)\b.*\b(vegetarian|vegan|options?|menu|serve|sell|available)\b|\bwhat'?s on the menu\b|\bdo you (have|sell|serve)\b/i },
  { intent: 'PRICE_QUESTION', re: /\bhow much\b|\bwhat does .* cost\b|\bprice of\b/i },
  { intent: 'GREETING', re: /^\s*(hi|hey|hello|yo|good (morning|afternoon|evening)|namaste|hola)\b[\s!.,]*$/i },
];

const REMOVE_RE = /\b(remove|delete|take off|take out|drop|cancel|get rid of)\s+(the\s+)?(?<rest>.+)$/i;

export class DeterministicProvider implements AIProvider {
  readonly name = 'deterministic';

  async chat(messages: ChatMessage[], _opts?: ChatOptions): Promise<ChatResult> {
    // Copywriting is templated in the agent; this exists so the interface is complete.
    const last = messages.at(-1)?.content ?? '';
    return { text: last, usage: emptyUsage(this.name, 'rules-v1') };
  }

  async structuredOutput<T>(
    messages: ChatMessage[], _schema: Record<string, unknown>, _opts?: ChatOptions,
  ): Promise<StructuredResult<T>> {
    const started = Date.now();
    const userText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const value = interpret(userText) as unknown as T;
    const usage: Usage = {
      ...emptyUsage(this.name, 'rules-v1', Date.now() - started),
      promptTokens: Math.ceil(userText.length / 4),
    };
    return { value, usage, raw: JSON.stringify(value) };
  }

  async transcribe(audio: Uint8Array, _mime: string, _hint?: string): Promise<TranscriptResult> {
    // Mock media bytes are `fixture:<mediaId>`; the fixture table lives in stt/mock.ts.
    const text = new TextDecoder().decode(audio);
    return {
      text, language: 'en', confidence: 0.9,
      usage: emptyUsage(this.name, 'rules-v1'),
    };
  }

  async embed(texts: string[]) {
    // Deterministic hashing embedding — stable, offline, good enough for nearest-neighbour smoke tests.
    const vectors = texts.map((t) => {
      const v = new Array(64).fill(0);
      for (let i = 0; i < t.length; i++) v[t.charCodeAt(i) % 64] += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
    return { vectors, usage: emptyUsage(this.name, 'rules-v1') };
  }
}

/* ────────────────────── the rules ────────────────────── */

export function interpret(input: string): Interpretation {
  const original = String(input || '').trim();
  if (!original) return normaliseInterpretation({ intent: 'UNKNOWN', confidence: 0 });

  const language: Language = detectLanguage(original);
  // Hindi/Hinglish is folded onto the English shapes; English passes through untouched.
  const text = language === 'en' ? original : normaliseForMatching(original);

  if (CONFIRM_RE.test(original) || HINDI_CONFIRM.test(original)) {
    return normaliseInterpretation({ intent: 'CONFIRM', confidence: 0.97, language });
  }
  if (DENY_RE.test(original) || HINDI_DENY.test(original)) {
    return normaliseInterpretation({ intent: 'DENY', confidence: 0.95, language });
  }

  if (language !== 'en') {
    for (const cue of HINDI_QUESTION_CUES) {
      if (cue.re.test(original)) {
        const items = extractItems(text);
        if (items.length && cue.intent === 'PRICE_QUESTION') {
          return normaliseInterpretation({ intent: 'ORDER_ADD', items, confidence: 0.7, language });
        }
        return normaliseInterpretation({ intent: cue.intent, question: original, confidence: 0.85, language });
      }
    }
  }

  for (const { intent, re } of PATTERNS) {
    if (re.test(text)) {
      // A message can both answer a question AND order ("do you have fries? add 2")
      const items = extractItems(text);
      if (intent === 'GREETING' && items.length === 0) {
        return normaliseInterpretation({ intent, confidence: 0.95, language });
      }
      if (['ORDER_STATUS', 'CANCEL_ORDER', 'REPEAT_LAST_ORDER', 'OPT_OUT', 'OPT_IN', 'HUMAN_REQUEST'].includes(intent)) {
        return normaliseInterpretation({ intent, question: original, confidence: 0.9, language });
      }
      if (items.length > 0 && ['MENU_QUESTION', 'PROMO_QUESTION', 'PRICE_QUESTION'].includes(intent)
          && /\b(add|want|get|give|i'?ll (have|take)|order)\b/i.test(text)) {
        return normaliseInterpretation({ intent: 'ORDER_ADD', items, confidence: 0.75, language });
      }
      return normaliseInterpretation({ intent, question: original, confidence: 0.85, language });
    }
  }

  const removal = text.match(REMOVE_RE);
  if (removal?.groups?.rest) {
    const removeItems = splitClauses(removal.groups.rest).map((c) => {
      const { quantity, rest } = leadingQuantity(c);
      return { phrase: stripModifierWords(rest), quantity: quantity ?? undefined };
    }).filter((r) => r.phrase);
    if (removeItems.length) return normaliseInterpretation({ intent: 'ORDER_REMOVE', removeItems, confidence: 0.85, language });
  }

  const items = extractItems(text);
  if (items.length > 0) {
    // Confidence drops when the utterance is long relative to what we extracted.
    const coverage = items.reduce((s, i) => s + i.phrase.length, 0) / text.length;
    let confidence = Math.max(0.45, Math.min(0.92, 0.5 + coverage * 0.5));

    /**
     * A bare noun phrase with no quantity and no ordering verb is weak evidence
     * of an order — it is just as likely to be a typo or a stray word. Without
     * this cap, "asdkjhasd" scores 0.92 purely because it is short. Menu
     * resolution would still reject it, but an honest confidence number is what
     * drives clarification and the AI-quality metrics, so it has to be right.
     */
    const hasQuantitySignal = /\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|couple|dozen)\b/i.test(text);
    const hasOrderVerb = /\b(want|order|add|get|give|have|take|like|gimme|lemme|please)\b/i.test(text);
    if (!hasQuantitySignal && !hasOrderVerb) confidence = Math.min(confidence, 0.45);

    return normaliseInterpretation({
      intent: 'ORDER_ADD', items, confidence, language, promoCode: findPromoCode(original),
    });
  }

  if (original.includes('?')) return normaliseInterpretation({ intent: 'MENU_QUESTION', question: original, confidence: 0.4, language });
  return normaliseInterpretation({ intent: 'UNKNOWN', confidence: 0.2, language });
}

function findPromoCode(text: string): string | undefined {
  const m = text.match(/\b(?:code|promo|coupon)\s*[:\s]\s*([A-Z0-9]{3,20})\b/i);
  return m?.[1];
}

/** Splits "2 burgers, fries and a coke" into orderable clauses. */
function splitClauses(text: string): string[] {
  return text
    .replace(/\band\b/gi, ',')
    .replace(/\bplus\b/gi, ',')
    .replace(/\balso\b/gi, ',')
    .split(/[,;]+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function leadingQuantity(clause: string): { quantity: number | null; rest: string } {
  const digit = clause.match(/^\s*(\d{1,2})\s*x?\s+(.*)$/i);
  if (digit) return { quantity: Number(digit[1]), rest: digit[2] };

  const word = clause.match(/^\s*([a-z]+)\s+(.*)$/i);
  if (word && NUMBER_WORDS[word[1].toLowerCase()] !== undefined) {
    return { quantity: NUMBER_WORDS[word[1].toLowerCase()], rest: word[2] };
  }
  return { quantity: null, rest: clause };
}

const ORDER_VERBS = /\b(i(?:'| a)?m?\s*)?(would like|i'?ll have|i'?ll take|want|wanted|get me|give me|can i (?:get|have)|could i (?:get|have)|may i have|order|add|gimme|lemme get|please)\b/gi;

function stripModifierWords(phrase: string): string {
  return phrase
    .replace(ORDER_VERBS, ' ')
    .replace(/\b(please|thanks|thank you|for me|to go|takeout|pickup)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pulls trailing/leading modifier phrases out of a clause. */
function extractModifiers(clause: string): { base: string; modifiers: string[] } {
  const modifiers: string[] = [];
  let base = clause;

  // "with extra cheese", "no onions", "without pickles", "hold the mayo"
  const withRe = /\b(with|w\/|no|without|hold(?:\s+the)?|add|extra|double|light)\s+([a-z][a-z\s]*?)(?=(?:\s+(?:with|w\/|no|without|hold|add|extra|double|light)\b)|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = withRe.exec(clause)) !== null) {
    const lead = m[1].toLowerCase().replace(/\s+the$/, '');
    const body = m[2].trim();
    if (!body) continue;
    if (lead === 'with' || lead === 'w/' || lead === 'add') modifiers.push(body);
    else if (lead === 'hold' || lead === 'without' || lead === 'no') modifiers.push(`no ${body}`);
    else modifiers.push(`${lead} ${body}`);
    base = base.replace(m[0], ' ');
  }

  // Leading size/style adjectives stay in the base phrase (they identify the item),
  // but are ALSO offered as modifier candidates so "large" can match a Size group.
  const leading = base.trim().split(/\s+/)[0]?.toLowerCase();
  if (leading && MODIFIER_LEADERS.includes(leading) && base.trim().split(/\s+/).length > 1) {
    modifiers.push(leading);
  }

  return { base: base.replace(/\s+/g, ' ').trim(), modifiers };
}

export function extractItems(text: string): ItemPhrase[] {
  const cleaned = text.replace(/[?!]+/g, ' ');
  const out: ItemPhrase[] = [];
  /**
   * Modifier-only clauses always split from the LAST REAL DISH mentioned, not
   * from whatever line happened to be pushed most recently. Without this,
   * "2 biryani, one spicy, one regular" collapses both qualifiers onto the same
   * line instead of producing one spicy and one regular.
   */
  let anchor = -1;

  for (const rawClause of splitClauses(cleaned)) {
    const stripped = stripModifierWords(rawClause);
    if (!stripped) continue;

    const { quantity, rest } = leadingQuantity(stripped);
    const { base, modifiers } = extractModifiers(rest);
    const phrase = base.trim();

    // Reject pure noise: needs at least one word that could be a food noun.
    if (!phrase || phrase.length < 2) continue;
    if (/^(it|that|this|them|those|these|me|you|order|food)$/i.test(phrase)) continue;

    // "one spicy" after "2 chicken biryani" is not a second dish — it splits the
    // anchor line into 1 spicy + however many remain unqualified.
    if (isModifierOnlyPhrase(phrase) && anchor >= 0) {
      const base = out[anchor];
      const splitQty = quantity ?? base.quantity;

      if (splitQty < base.quantity) {
        base.quantity -= splitQty;
        out.push({
          phrase: base.phrase,
          quantity: splitQty,
          modifierPhrases: [...modifiers, phrase],
        });
      } else {
        // Nothing left to split off — the qualifier describes the anchor itself.
        base.modifierPhrases.push(phrase, ...modifiers);
      }
      continue;
    }

    out.push({
      phrase,
      quantity: quantity ?? 1,
      modifierPhrases: modifiers,
    });
    anchor = out.length - 1;
  }
  return out;
}
