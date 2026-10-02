/**
 * Language detection and the Hindi / Hinglish lexicon.
 *
 * Why a lexicon and not "just let the LLM do it": the deterministic provider has
 * to work offline for tests and as the fallback when the hosted model is down.
 * A biryani shop cannot stop taking orders because an API is slow.
 *
 * All word matching here is Unicode-aware. JavaScript's `\b` only understands
 * ASCII word characters, so `\bदो\b` never matches anything — an earlier
 * version of this file silently did nothing for Devanagari text because of it.
 */

export type Language = 'en' | 'hi' | 'hi-Latn';

const DEVANAGARI = /[ऀ-ॿ]/;

/** Word boundary that understands Devanagari letters and combining vowel signs. */
function word(w: string): RegExp {
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}(?![\\p{L}\\p{M}\\p{N}])`, 'giu');
}

/** Romanised Hindi markers common in food ordering. */
const HINGLISH_MARKERS = [
  'bhai', 'bhaiya', 'dena', 'dedo', 'de do', 'chahiye', 'chaiye', 'karo', 'kar do',
  'bhejo', 'bhej do', 'lelo', 'le lo', 'kitna', 'kitne', 'kab', 'kya', 'hai', 'hoga',
  'haan', 'nahi', 'nai', 'theek', 'thik', 'accha', 'acha', 'baje', 'bje', 'mujhe', 'mujhko',
  'ek', 'teen', 'chaar', 'paanch', 'panch', 'chhe', 'saat', 'aath', 'nau', 'das',
  'aur', 'bina', 'zyada', 'jyada', 'thoda', 'kam', 'garam', 'teekha', 'tikha', 'dono',
  'saada', 'sada', 'wala', 'wali', 'jaldi', 'yaar', 'milega', 'banao', 'ho jayega',
];

export function detectLanguage(text: string): Language {
  if (DEVANAGARI.test(text)) return 'hi';
  const lower = ` ${text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ')} `;
  let hits = 0;
  for (const marker of HINGLISH_MARKERS) if (lower.includes(` ${marker} `)) hits++;
  // Two independent markers: one could be coincidence ("do" and "char" are English too).
  return hits >= 2 ? 'hi-Latn' : 'en';
}

/* ─────────────── numerals ─────────────── */

export const HINDI_NUMBERS: Record<string, number> = {
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, pach: 5,
  chhe: 6, chah: 6, saat: 7, aath: 8, nau: 9, das: 10, dus: 10,
  // NB: deliberately NOT "no" -> 9: in Hinglish "no onions" means no onions.
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6,
  'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
};

/* ─────────────── intent cues ─────────────── */

export const HINDI_CONFIRM = /^\s*(haan|han|ha|haa|ji|ji haan|haan ji|theek hai|thik hai|sahi hai|kar do|confirm kar do|pakka|हाँ|हां|ठीक है|जी|जी हाँ)\s*[!.]*\s*$/iu;
export const HINDI_DENY = /^\s*(nahi|nahin|nai|na|mat|नहीं|ना)\s*[!.]*\s*$/iu;

/** "give me / I want / send" — removed BEFORE numerals are mapped ("bhej do" is not "send 2"). */
const ORDER_VERB_PHRASES = [
  'de dijiye', 'dijiye', 'de dena', 'de do', 'dedo', 'dena', 'bhej do', 'bhej dena', 'bhejo',
  'le lo', 'lelo', 'kar do', 'karo', 'bana do', 'banao', 'chahiye', 'chaiye', 'milega', 'mil jayega',
  'dede', 'bhai', 'bhaiya', 'yaar', 'mujhe', 'mujhko', 'hume', 'humein', 'hamein',
  'दे दीजिए', 'दीजिए', 'दे दो', 'देना', 'दे', 'भेज दो', 'भेजो', 'चाहिए', 'मुझे', 'भाई',
];

/** Modifier words mapped onto the English vocabulary menus use. */
const MODIFIER_HINTS: Array<[string, string]> = [
  ['kam teekha', 'less spicy'], ['kam spicy', 'less spicy'], ['extra teekha', 'extra spicy'],
  ['zyada teekha', 'extra spicy'], ['jyada teekha', 'extra spicy'],
  ['teekha', 'spicy'], ['tikha', 'spicy'], ['masaledar', 'spicy'], ['तीखा', 'spicy'], ['तीखी', 'spicy'],
  ['normal', 'regular'], ['saada', 'regular'], ['sada', 'regular'], ['सादा', 'regular'], ['सादी', 'regular'],
  ['dono', 'both'], ['दोनों', 'both'], ['sab', 'all'],
  ['zyada', 'extra'], ['jyada', 'extra'], ['bina', 'no'], ['bagair', 'no'], ['बिना', 'no'],
  ['garam', 'hot'],
];

/** Common food words written in Devanagari → the Latin spellings menus use. */
const DEVANAGARI_FOOD: Array<[string, string]> = [
  ['बिरयानी', 'biryani'], ['बिर्यानी', 'biryani'], ['बिरियानी', 'biryani'],
  ['चिकन', 'chicken'], ['मटन', 'mutton'], ['वेज', 'veg'], ['पनीर', 'paneer'], ['टिक्का', 'tikka'],
  ['गार्लिक', 'garlic'], ['लहसुन', 'garlic'], ['नान', 'naan'], ['बटर', 'butter'], ['रोटी', 'roti'],
  ['कोक', 'coke'], ['पेप्सी', 'pepsi'], ['पानी', 'water'], ['लस्सी', 'lassi'], ['मीठी', 'sweet'],
  ['रायता', 'raita'], ['चावल', 'rice'], ['एक्स्ट्रा', 'extra'],
];

export const HINDI_CONJUNCTIONS: Array<[string, string]> = [['aur', ' and '], ['और', ' and '], ['ya', ' or ']];

export const HINDI_QUESTION_CUES: Array<{ intent: string; re: RegExp }> = [
  { intent: 'PRICE_QUESTION', re: /(?<![\p{L}])(kitna|kitne|kitni|kitne ka|price kya|कितना|कितने|कितनी)(?![\p{L}])/iu },
  { intent: 'PREP_TIME_QUESTION', re: /(kab tak|kitni der|kitna time|kab ready|kab milega|कब तक|कितनी देर)/iu },
  { intent: 'HOURS_QUESTION', re: /(khula|khule|band hai|kab khulta|कब खुलता|खुला है)/iu },
  { intent: 'MENU_QUESTION', re: /(kya kya hai|menu kya|kya milega|kya hai menu|मेनू|क्या मिलेगा)/iu },
  { intent: 'ORDER_STATUS', re: /(mera order|order kahan|order kaha|ready hua|मेरा ऑर्डर)/iu },
  { intent: 'HUMAN_REQUEST', re: /(kisi se baat|manager se baat|insaan se|बात कराओ|किसी से बात)/iu },
];

/**
 * Folds Hindi / Hinglish onto the English shapes the parser understands.
 * Order matters: remove "give/send" verbs first, then conjunctions, then
 * modifiers, then numerals — otherwise "bhej do" becomes "send 2".
 */
export function normaliseForMatching(text: string): string {
  let out = ` ${text.toLowerCase()} `;
  for (const v of ORDER_VERB_PHRASES.sort((a, b) => b.length - a.length)) out = out.replace(word(v), ' ');
  for (const [w, repl] of HINDI_CONJUNCTIONS) out = out.replace(word(w), repl);
  for (const [w, repl] of DEVANAGARI_FOOD) out = out.replace(word(w), ` ${repl} `);
  for (const [w, repl] of MODIFIER_HINTS) out = out.replace(word(w), ` ${repl} `);
  for (const [w, n] of Object.entries(HINDI_NUMBERS)) out = out.replace(word(w), ` ${n} `);
  return out.replace(/\s+/g, ' ').trim();
}

/* ─────────────── replies in the customer's language ─────────────── */

export const REPLIES: Record<Language, Record<string, string>> = {
  en: {
    confirmed: 'Confirmed! Your order',
    willBeReady: 'will be ready around',
    weWillMessage: "We'll message you when it's ready.",
    preparing: 'Your order is being prepared.',
    ready: 'Your order is ready for pickup!',
    running_late: "We're running a little behind. Your updated pickup time is",
  },
  hi: {
    confirmed: 'कन्फर्म! आपका ऑर्डर',
    willBeReady: 'तैयार हो जाएगा लगभग',
    weWillMessage: 'तैयार होने पर हम आपको मैसेज करेंगे।',
    preparing: 'आपका ऑर्डर बन रहा है।',
    ready: 'आपका ऑर्डर पिकअप के लिए तैयार है!',
    running_late: 'हमें थोड़ी देर हो रही है। आपका नया पिकअप समय है',
  },
  'hi-Latn': {
    confirmed: 'Confirmed! Aapka order',
    willBeReady: 'ready ho jayega around',
    weWillMessage: 'Ready hone par hum aapko message karenge.',
    preparing: 'Aapka order ban raha hai.',
    ready: 'Aapka order pickup ke liye ready hai!',
    running_late: 'Thodi der ho rahi hai. Aapka naya pickup time hai',
  },
};

export function t(lang: Language, key: string): string {
  return REPLIES[lang]?.[key] ?? REPLIES.en[key] ?? key;
}
