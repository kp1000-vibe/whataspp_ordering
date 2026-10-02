/**
 * The ONE structure the language model is allowed to return for ordering.
 *
 * Read the fields carefully: there is no price, no total, no tax, no prep time,
 * no availability and no item id. The model reports what the customer SAID
 * (phrases + quantities). The backend resolves phrases to menu ids, checks
 * availability, and computes all money. That separation is the entire guardrail.
 */
export const INTENTS = [
  'GREETING', 'SMALL_TALK', 'ORDER_ADD', 'ORDER_REMOVE', 'ORDER_SET_QUANTITY', 'ORDER_MODIFY',
  'CONFIRM', 'DENY', 'CANCEL_ORDER', 'ORDER_STATUS', 'PICKUP_TIME',
  'MENU_QUESTION', 'PRICE_QUESTION', 'DIETARY_QUESTION', 'ALLERGEN_QUESTION', 'FAQ_QUESTION',
  'HOURS_QUESTION', 'PREP_TIME_QUESTION', 'PROMO_QUESTION',
  'REPEAT_LAST_ORDER', 'ORDER_HISTORY_QUESTION', 'GROUP_ORDER',
  'HUMAN_REQUEST', 'OPT_OUT', 'OPT_IN', 'UNKNOWN',
] as const;

export type Intent = typeof INTENTS[number];

export type ItemPhrase = {
  /** Exactly what the customer called it, e.g. "large pepperoni pizza". */
  phrase: string;
  quantity: number;
  /** e.g. ["stuffed crust", "extra cheese", "no onions"] */
  modifierPhrases: string[];
  notes?: string;
};

export type Interpretation = {
  intent: Intent;
  items: ItemPhrase[];
  removeItems: Array<{ phrase: string; quantity?: number }>;
  /** ORDER_SET_QUANTITY: "make it 3 cokes" -> [{ phrase: 'cokes', quantity: 3 }] */
  setQuantities?: Array<{ phrase: string; quantity: number }>;
  /** ORDER_MODIFY: "make it spicy" -> ['spicy']; target is optional ("make the biryani spicy"). */
  modifyPhrases?: string[];
  modifyTarget?: string;
  /** Questions: the subject being asked about with question words removed ("mango lassi"). */
  probe?: string;
  /** For question intents: the question as written. */
  question?: string;
  /** Free-text promo code if the customer typed one. */
  promoCode?: string;
  /** Model's self-reported confidence. Advisory only — menu matching has its own score. */
  confidence: number;
  /** Detected language of the customer's message; replies try to match it. */
  language: 'en' | 'hi' | 'hi-Latn';
};

/** JSON Schema handed to providers that support structured output. */
export const INTERPRETATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'items', 'removeItems', 'confidence'],
  properties: {
    intent: { type: 'string', enum: [...INTENTS] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['phrase', 'quantity', 'modifierPhrases'],
        properties: {
          phrase: { type: 'string' },
          // No maximum here on purpose: an out-of-range quantity must reach the
          // pricing engine so the customer is TOLD, not silently capped.
          quantity: { type: 'integer', minimum: 1 },
          modifierPhrases: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
      },
    },
    removeItems: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['phrase'],
        properties: { phrase: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
      },
    },
    setQuantities: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['phrase', 'quantity'],
        properties: { phrase: { type: 'string' }, quantity: { type: 'integer', minimum: 0 } },
      },
    },
    modifyPhrases: { type: 'array', items: { type: 'string' } },
    modifyTarget: { type: 'string' },
    probe: { type: 'string' },
    question: { type: 'string' },
    promoCode: { type: 'string' },
    language: { type: 'string', enum: ['en', 'hi', 'hi-Latn'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

export function emptyInterpretation(intent: Intent = 'UNKNOWN', confidence = 0): Interpretation {
  return { intent, items: [], removeItems: [], confidence, language: 'en' };
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Defensive normaliser — providers lie, schemas drift, users paste emoji. */
export function normaliseInterpretation(raw: any): Interpretation {
  const intent: Intent = INTENTS.includes(raw?.intent) ? raw.intent : 'UNKNOWN';
  const items: ItemPhrase[] = Array.isArray(raw?.items)
    ? raw.items
        .filter((i: any) => typeof i?.phrase === 'string' && i.phrase.trim())
        .map((i: any) => ({
          phrase: String(i.phrase).trim(),
          // Kept as-is (no silent cap): pricing rejects out-of-range quantities with a message.
          quantity: Number.isInteger(i?.quantity) && i.quantity > 0 ? i.quantity : 1,
          modifierPhrases: Array.isArray(i?.modifierPhrases)
            ? i.modifierPhrases.filter((m: any) => typeof m === 'string' && m.trim()).map((m: string) => m.trim())
            : [],
          notes: str(i?.notes),
        }))
    : [];
  const removeItems = Array.isArray(raw?.removeItems)
    ? raw.removeItems
        .filter((i: any) => typeof i?.phrase === 'string' && i.phrase.trim())
        .map((i: any) => ({ phrase: String(i.phrase).trim(), quantity: Number.isInteger(i?.quantity) ? i.quantity : undefined }))
    : [];
  const setQuantities = Array.isArray(raw?.setQuantities)
    ? raw.setQuantities
        .filter((i: any) => typeof i?.phrase === 'string' && Number.isInteger(i?.quantity) && i.quantity >= 0)
        .map((i: any) => ({ phrase: String(i.phrase).trim(), quantity: i.quantity }))
    : undefined;
  const modifyPhrases = Array.isArray(raw?.modifyPhrases)
    ? raw.modifyPhrases.filter((m: any) => typeof m === 'string' && m.trim()).map((m: string) => m.trim())
    : undefined;

  const confidence = typeof raw?.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1
    ? raw.confidence : 0.5;
  const language = ['en', 'hi', 'hi-Latn'].includes(raw?.language) ? raw.language : 'en';

  return {
    intent, items, removeItems, language, confidence,
    setQuantities: setQuantities?.length ? setQuantities : undefined,
    modifyPhrases: modifyPhrases?.length ? modifyPhrases : undefined,
    modifyTarget: str(raw?.modifyTarget),
    probe: str(raw?.probe),
    question: str(raw?.question),
    promoCode: str(raw?.promoCode),
  };
}
