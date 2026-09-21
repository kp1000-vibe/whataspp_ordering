/**
 * Language detection and the Hindi/Hinglish lexicon.
 *
 * Why a lexicon and not "just let the LLM do it": the deterministic provider has
 * to work offline for tests and as the fallback when the hosted model is down.
 * A biryani shop in Hyderabad cannot have ordering break because an API is slow.
 *
 * Detection is script-based first (Devanagari is unambiguous), then lexical for
 * romanised Hindi (Hinglish), which is what most customers actually type.
 */

export type Language = 'en' | 'hi' | 'hi-Latn';

const DEVANAGARI = /[ऀ-ॿ]/;

/** Romanised Hindi markers common in food ordering. */
const HINGLISH_MARKERS = [
  'bhai', 'bhaiya', 'dena', 'dedo', 'de do', 'chahiye', 'chaiye', 'karo', 'kar do',
  'bhejo', 'bhej do', 'lelo', 'le lo', 'kitna', 'kitne', 'kitna hua', 'kab', 'kab tak',
  'haan', 'nahi', 'nai', 'theek', 'thik', 'accha', 'acha', 'baje', 'bje',
  'ek', 'do', 'teen', 'char', 'paanch', 'panch', 'chhe', 'chah', 'saat', 'aath', 'nau', 'das',
  'aur', 'bina', 'zyada', 'jyada', 'thoda', 'kam', 'garam', 'teekha', 'tikha',
  'plate', 'packet', 'parcel', 'ho jayega', 'milega', 'ready', 'banao',
];

export function detectLanguage(text: string): Language {
  if (DEVANAGARI.test(text)) return 'hi';

  const lower = ` ${text.toLowerCase().replace(/[^a-z\s]/g, ' ')} `;
  let hits = 0;
  for (const marker of HINGLISH_MARKERS) {
    if (lower.includes(` ${marker} `)) hits++;
  }
  // Two independent markers is a strong signal; one could be coincidence
  // ("do" and "char" are English words too).
  return hits >= 2 ? 'hi-Latn' : 'en';
}

/* ─────────────── numerals ─────────────── */

export const HINDI_NUMBERS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, pach: 5,
  chhe: 6, che: 6, chah: 6, saat: 7, sat: 7, aath: 8, ath: 8, nau: 9, no: 9, das: 10, dus: 10,
  // Devanagari
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 6, 'छह': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
};

/* ─────────────── intent cues ─────────────── */

export const HINDI_CONFIRM = /^\s*(haan|han|ha|ji|ji haan|theek hai|thik hai|ok theek|sahi hai|kar do|confirm kar do|हाँ|हां|ठीक है|जी)\s*[!.]*\s*$/i;
export const HINDI_DENY = /^\s*(nahi|nahin|nai|na|mat|नहीं|ना)\s*[!.]*\s*$/i;

/** Verbs/particles that mean "give me / I want" — stripped before item matching. */
export const HINDI_ORDER_VERBS =
  /\b(bhai|bhaiya|boss|dena|de dena|dedo|de do|chahiye|chaiye|karo|kar do|bhejo|bhej do|lelo|le lo|banao|bana do|milega|mil jayega|पैक|दे|दो|चाहिए|भेजो)\b/gi;

/** Modifier words that map onto configured modifiers via aliases. */
export const HINDI_MODIFIER_HINTS: Record<string, string> = {
  teekha: 'spicy', tikha: 'spicy', masaledar: 'spicy', 'तीखा': 'spicy',
  normal: 'regular', saada: 'regular', sada: 'regular', 'सादा': 'regular',
  zyada: 'extra', jyada: 'extra', extra: 'extra', 'ज़्यादा': 'extra',
  bina: 'no', bagair: 'no', 'बिना': 'no',
  kam: 'less', thoda: 'less', 'कम': 'less',
  garam: 'hot', 'गरम': 'hot',
};

/** Splitters: "aur" = "and". */
export const HINDI_CONJUNCTIONS = /\b(aur|और|plus)\b/gi;

export const HINDI_QUESTION_CUES: Array<{ intent: string; re: RegExp }> = [
  { intent: 'PRICE_QUESTION', re: /\b(kitna|kitne|kitna hua|kitne ka|price kya|कितना|कितने)\b/i },
  { intent: 'PREP_TIME_QUESTION', re: /\b(kab tak|kitni der|kitna time|kab ready|कब तक|कितनी देर)\b/i },
  { intent: 'HOURS_QUESTION', re: /\b(khula|khule|band|kab khulta|कब खुलता|खुला है)\b/i },
  { intent: 'MENU_QUESTION', re: /\b(kya kya hai|menu kya|kya milega|kya hai|क्या है|क्या मिलेगा)\b/i },
  { intent: 'ORDER_STATUS', re: /\b(mera order|order kahan|ready hua|हुआ क्या|मेरा ऑर्डर)\b/i },
  { intent: 'HUMAN_REQUEST', re: /\b(kisi se baat|manager se baat|insaan|बात कराओ|किसी से बात)\b/i },
];

/**
 * Normalises a Hinglish/Hindi utterance toward the shapes the English rules
 * already understand, WITHOUT destroying the original (kept for the reply).
 */
export function normaliseForMatching(text: string): string {
  let out = ` ${text.toLowerCase()} `;

  out = out.replace(HINDI_CONJUNCTIONS, ' and ');

  for (const [word, n] of Object.entries(HINDI_NUMBERS)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'gi'), ` ${n} `);
  }
  for (const [word, english] of Object.entries(HINDI_MODIFIER_HINTS)) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'gi'), ` ${english} `);
  }
  out = out.replace(HINDI_ORDER_VERBS, ' ');

  return out.replace(/\s+/g, ' ').trim();
}

/** Reply snippets, so confirmations come back in the customer's language. */
export const REPLIES: Record<Language, Record<string, string>> = {
  en: {
    confirmQuestion: 'Shall I confirm?',
    total: 'Total',
    earliestPickup: 'The earliest pickup for this order is',
    confirmed: 'Confirmed! Your order',
    willBeReady: 'will be ready around',
    weWillMessage: "We'll message you when it's ready.",
    anythingElse: 'Anything else?',
    unavailable: 'is currently unavailable',
    wouldYouLike: 'Would you like',
    instead: 'instead?',
    preparing: 'Your order is being prepared.',
    ready: 'Your order is ready for pickup!',
    running_late: "We're running a little behind. Your updated pickup time is",
  },
  hi: {
    confirmQuestion: 'कन्फर्म कर दूँ?',
    total: 'कुल',
    earliestPickup: 'सबसे जल्दी पिकअप का समय है',
    confirmed: 'कन्फर्म! आपका ऑर्डर',
    willBeReady: 'तैयार हो जाएगा लगभग',
    weWillMessage: 'तैयार होने पर हम आपको मैसेज करेंगे।',
    anythingElse: 'और कुछ?',
    unavailable: 'अभी उपलब्ध नहीं है',
    wouldYouLike: 'क्या आप लेंगे',
    instead: 'इसके बजाय?',
    preparing: 'आपका ऑर्डर बन रहा है।',
    ready: 'आपका ऑर्डर पिकअप के लिए तैयार है!',
    running_late: 'हमें थोड़ी देर हो रही है। आपका नया पिकअप समय है',
  },
  'hi-Latn': {
    confirmQuestion: 'Confirm kar doon?',
    total: 'Total',
    earliestPickup: 'Sabse jaldi pickup ka time hai',
    confirmed: 'Confirmed! Aapka order',
    willBeReady: 'ready ho jayega around',
    weWillMessage: 'Ready hone par hum aapko message karenge.',
    anythingElse: 'Aur kuch?',
    unavailable: 'abhi available nahi hai',
    wouldYouLike: 'Kya aap lenge',
    instead: 'iske badle?',
    preparing: 'Aapka order ban raha hai.',
    ready: 'Aapka order pickup ke liye ready hai!',
    running_late: 'Thodi der ho rahi hai. Aapka naya pickup time hai',
  },
};

export function t(lang: Language, key: string): string {
  return REPLIES[lang]?.[key] ?? REPLIES.en[key] ?? key;
}
