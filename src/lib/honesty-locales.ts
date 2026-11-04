/**
 * Per-locale banned-claim patterns (HACK-131). * 
 * `honesty.ts` carries the English and Spanish gate. The intake ships eleven
 * locales, and machine translation can turn an honest sentence into a
 * determination or a promise of money, so each other locale gets a coarse net
 * for the four shapes that matter: an eligibility determination, an approval
 * promise, a benefit that is said to be on its way, and a guarantee claim.
 * Negated forms are honest disclaimers and stay allowed.
 *
 * These are a best-effort net over machine output, not a substitute for a
 * fluent review: they catch the common assertive phrasing, not every way to
 * promise an outcome. Like the English patterns, they are written so this
 * file's own text does not match the English or Spanish gate.
 */

import type { BannedClaimMatch } from "./honesty";

type LocaleClaimPatterns = Readonly<Record<string, readonly RegExp[]>>;

/** The ten non-English, non-Spanish locales the intake offers. */
export const BANNED_CLAIM_PATTERNS_BY_LOCALE: LocaleClaimPatterns = {
  // An eligibility determination, an approval promise, and a guarantee claim,
  // in the shapes machine translation tends to produce.
  zh: [
    /(?:您|你)\s*(?:已经|已|将|会)?\s*(?:符合|满足)(?:资格|条件)/,
    /(?:您|你)(?:已经|已)?有(?:资格|权利|权)(?:获得|领取)/,
    /(?:申请|您的申请|你的申请)\s*(?:将被|会被|已经|已)\s*(?:批准|获批)/,
    /(?<!不)(?<!无法)保证(?:您|你)(?:一定|肯定)?(?:能|会|获得|获批)/,
    // A benefit said to be on its way: the honest shape is that a person who
    // qualifies may get it, never that it is coming.
    /(?:您|你)\s*(?:将|会|将会|就会)\s*(?:获得|得到|收到|领取)/,
  ],
  vi: [
    /\bbạn\s+(?:đủ\s+điều\s+kiện|hội\s+đủ\s+điều\s+kiện|sẽ\s+được\s+chấp\s+thuận|được\s+chấp\s+thuận)/i,
    /(?<!không\s)được\s+bảo\s+đảm/i,
    /(?<!\p{L})bạn\s+sẽ\s+(?:nhận|được\s+nhận)(?!\p{L})/iu,
  ],
  tl: [
    /\b(?:ikaw|kayo)\s+ay\s+(?:karapat-dapat|kwalipikado|aprubado)\b/i,
    /\bkarapat-dapat\s+ka\b/i,
    /(?<!hindi\s)\bgarantisado\b/i,
    /\bmakakatanggap\s+(?:ka|kayo)\b/i,
  ],
  ar: [
    /(?:أنت|أنتم)\s+(?:مؤهل|مؤهلون|مؤهلة)/,
    /(?<!غير\s)مؤهل/,
    /(?:سيتم|تم|ستتم)\s+الموافقة/,
    /(?<!غير\s)مضمون/,
    /(?:سيتم|تم|ستتم)\s+قبول\s+طلب(?:ك|كم)/,
    /(?:سوف|س)\s*(?:تحصل|ستحصل|تحصلون|ستحصلون)/,
  ],
  fr: [
    /\b(?:vous|tu)\s+(?:êtes|es|serez|seras|avez\s+été)\s+(?:admissible|admis(?:e)?|approuvé(?:e)?|éligible)/i,
    /\b(?:vous|tu)\s+(?:avez|as)\s+(?:le\s+)?droit\s+(?:à|a)/i,
    /\b(?:demande|dossier)\s+(?:est|sera|a\s+été)\s+(?:approuvé(?:e)?|accepté(?:e)?)/i,
    /(?<!\bpas\s)\bgaranti(?:e|s|es)?\b/i,
    /\b(?:vous|tu)\s+(?:recevrez|recevras|allez\s+recevoir|vas\s+recevoir)\b/i,
  ],
  ko: [
    /자격이\s*(?:있습니다|있어요|됩니다|되십니다)/,
    /승인(?:됩니다|되었습니다|될\s*것입니다|받으실)/,
    /보장(?:됩니다|되었습니다|해\s*드립니다)/,
    /받게\s*(?:됩니다|될\s*것입니다)/,
  ],
  ht: [
    /\bou\s+(?:kalifye|apwouve)\b/i,
    /\b(?:w\s+ap|pral)\s+(?:apwouve|kalifye)\b/i,
    /(?<!\bpa\s)\bgaranti\b/i,
    /\b(?:w\s+ap|pral)\s+(?:resevwa|jwenn)\b/i,
  ],
  // Portuguese accents (ê, á, à) are not ASCII word characters, so \b anchors
  // are unreliable at the accented end of a word; letter lookarounds instead.
  pt: [
    /(?<!\p{L})(?:você|tu)\s+(?:é|és|foi|será|serás|está|estás)\s+(?:elegível|elegivel|qualificad[oa]|apt[oa])(?!\p{L})/iu,
    /(?<!\p{L})(?:você|tu)\s+(?:se\s+)?qualifica(?:s)?(?!\p{L})/iu,
    /(?<!\p{L})(?:você|tu)\s+(?:tem|tens|terá|terás)\s+direito\s+(?:a|ao|à|aos|às)(?!\p{L})/iu,
    /(?<!\p{L})(?:seu|sua|teu|tua)\s+(?:pedido|solicitação|requerimento|candidatura)\s+(?:foi|será|está|é)\s+(?:aprovad[oa]|aceit[oa]|deferid[oa])(?!\p{L})/iu,
    /(?:é|será|está|são|serão)\s+garantid[oa]s?(?!\p{L})/iu,
    /(?<!\p{L})garantimos(?!\p{L})/iu,
    /(?<!\p{L})(?:você|tu)\s+(?:vai|vais|irá|irás)\s+(?:receber|ganhar|obter)(?!\p{L})/iu,
    /(?<!\p{L})(?:você|tu)\s+(?:receberá|receberás)(?!\p{L})/iu,
  ],
  // Hindi marks the claim with a copula after the adjective, so the shapes put
  // "पात्र/योग्य" and "अधिकार" next to "है/होगा" rather than a verb first.
  hi: [
    /(?:आप|तुम)(?:(?!।)[^\n]){0,40}?(?:पात्र|योग्य)\s+(?:हैं|हो|है)/,
    /(?:आपको|तुम्हें)(?:(?!।)[^\n]){0,40}?(?:अधिकार|हक)\s+(?:है|होगा|मिलेगा)/,
    /(?:आपका|आपकी|तुम्हारा|तुम्हारी)\s+(?:आवेदन|आवेदनपत्र|याचिका)\s+(?:स्वीकृत|मंज़ूर|मंजूर|अनुमोदित)\s+(?:हो\s+गया|होगा|है|किया\s+गया)/,
    /(?<!नहीं\s)(?<!बिना\s)(?:गारंटी|सुनिश्चित)\s+(?:है|होगी|होगा|की\s+जाती\s+है)/,
    /(?:आपको|तुम्हें)\s+(?:लाभ|सहायता|पैसे|राशि|फ़ायदा|फायदा)\s+(?:मिलेगा|मिलेगी|मिलेंगे)/,
  ],
  // Cyrillic letters are not ASCII word characters either, so every anchor is
  // a letter lookaround rather than \b.
  ru: [
    /(?<!\p{L})(?:вы|ты)\s+(?:имеете|имеешь|имел[аи]?|будете\s+иметь)\s+право(?!\p{L})/iu,
    /(?<!\p{L})(?:вы|ты)\s+(?:соответствуете|соответствуешь|подходите|подходишь|квалифицируетесь)(?!\p{L})/iu,
    /(?<!\p{L})(?:ваша|ваш|ваше|твоя|твой|твоё)\s+(?:заявка|заявление|обращение|анкета)\s+(?:одобрен[аоы]?|будет\s+одобрен[аоы]?|принят[аоы]?|утвержден[аоы]?)(?!\p{L})/iu,
    /(?<!не\s)(?<!\p{L})гарантирован[аоы]?(?!\p{L})/iu,
    /(?<!\p{L})гарантиру(?:ем|ется|ют)(?!\p{L})/iu,
    /(?<!\p{L})(?:вы|ты)\s+(?:получите|получишь)(?!\p{L})/iu,
  ],
};

/**
 * Words that hedge or negate a claim, per language. A match with one of these
 * shortly before it is a hedged or negated statement, which is the honest
 * wording the gate exists to keep, so it is not a claim. Deliberately coarse:
 * the net is best-effort.
 */
type HedgeRules = {
  /** Negations that bind the word they sit next to ("pas approuvé", "不符合"). */
  readonly adjacent: readonly RegExp[];
  /** Hedges that can open a clause ("peut-être que…", "قد…", "có thể…"). */
  readonly nearby: readonly RegExp[];
};

const HEDGE_RULES: Readonly<Record<string, HedgeRules>> = {
  zh: { adjacent: [/不/, /未/], nearby: [/可能/, /未必/] },
  // Vietnamese letters carry diacritics that \b does not count as word
  // characters, so the boundaries are letter-based instead.
  vi: {
    adjacent: [/(?<!\p{L})không(?!\p{L})/iu, /(?<!\p{L})chưa(?!\p{L})/iu],
    nearby: [/(?<!\p{L})có thể(?!\p{L})/iu],
  },
  tl: { adjacent: [/\bhindi\b/i], nearby: [/\bmaaaring\b/i, /\bbaka\b/i] },
  // Standalone particles only: the same letters sit inside ordinary words
  // (the letters of "قد" inside "المتقدمين", applicants), and matching those
  // would let the very claims this net exists to catch pass as hedged.
  ar: {
    adjacent: [/(?:^|\s)غير(?=\s|$)/, /(?:^|\s)ليس(?=\s|$)/, /(?:^|\s)لن(?=\s|$)/],
    nearby: [/(?:^|\s)قد(?=\s|$)/, /(?:^|\s)ربما(?=\s|$)/],
  },
  fr: { adjacent: [/\bpas\b/i, /\bn'/i], nearby: [/\bpeut-être\b/i] },
  // Korean 지도/수도 are ordinary nouns as well as particles, so they are out.
  ko: { adjacent: [/않/, /아니/], nearby: [] },
  ht: { adjacent: [/\bpa\b/i], nearby: [/\bpetèt\b/i] },
  pt: {
    adjacent: [/\bnão\b/i, /\bnem\b/i],
    // "pode/poderia" open an honest possibility ("você pode se qualificar"), so
    // they hedge the clause the same way "peut-être" does in French.
    // The modal only hedges when it governs the claim verb ("você pode ser
    // aprovado"); assertive idioms such as "pode confiar" must not launder a
    // determination that follows them.
    nearby: [
      /\btalvez\b/i,
      /\bpossivelmente\b/i,
      /(?<!\p{L})pode(?:ria|rá|m|mos)?\s+(?:ser|se\s+qualificar|qualificar|receber|conseguir|ganhar|obter|ter\s+direito)(?!\p{L})/iu,
    ],
  },
  hi: {
    // "न" is also the last letter of ordinary words (लेकिन, "but"), so only a
    // standalone "न" or "नहीं" negates the claim that follows it.
    adjacent: [/(?:^|\s)(?:नहीं|न)(?=\s|$)/],
    // "सकते हैं" alone is not enough: "निश्चिंत रह सकते हैं" ("you can rest
    // assured") is assertive, so only a possibility verb pattern hedges.
    nearby: [/शायद/, /संभवतः/, /हो\s+सकता\s+है/, /हो\s+सकती\s+है/],
  },
  ru: {
    adjacent: [/(?<!\p{L})не(?!\p{L})/iu, /(?<!\p{L})ни(?!\p{L})/iu],
    nearby: [/(?<!\p{L})возможно(?!\p{L})/iu, /(?<!\p{L})вероятно(?!\p{L})/iu, /(?<!\p{L})может(?!\p{L})/iu],
  },
};

/**
 * How far before a claim a hedge may sit and still bind it. A hedge can open a
 * clause, so it gets a longer window; it stays inside the claim's own sentence,
 * so a "peut-être" about something else does not launder the claim. Negations
 * get no window at all: they bind only the word directly before the claim, so
 * "Ne vous inquiétez pas, vous serez approuvé" is still a claim.
 */
const HEDGE_WINDOWS: Readonly<Record<string, { readonly nearby: number }>> = {
  zh: { nearby: 8 },
  ko: { nearby: 12 },
  ar: { nearby: 30 },
  vi: { nearby: 26 },
  tl: { nearby: 26 },
  fr: { nearby: 26 },
  ht: { nearby: 26 },
  pt: { nearby: 26 },
  hi: { nearby: 26 },
  ru: { nearby: 26 },
};

/** How much text before a negation is enough to see the word it modifies. */
const NEGATION_LOOKBACK = 24;

/**
 * Whether the claim at `index` is hedged or negated. Only the clause the claim
 * is in counts (a hedge in an earlier sentence does not excuse a later
 * assertion), and only markers close enough to be about this claim: a "不" or
 * "n'" in an unrelated earlier word does not launder it.
 */
function hedged(text: string, index: number, language: string): boolean {
  const rules = HEDGE_RULES[language];
  const windows = HEDGE_WINDOWS[language];
  if (!rules || !windows) return false;
  const sentence = text
    .slice(0, index)
    .split(/[.!?。！？;；\n]/)
    .pop() ?? "";
  // A negation counts only when nothing but spaces or joins separates it from
  // the claim ("pas approuvé", "n'est pas approuvé", "ne sera pas approuvé").
  const before = sentence.slice(-NEGATION_LOOKBACK);
  const binds = rules.adjacent.some((marker) =>
    new RegExp(`${marker.source}[\\s'’]*$`, marker.flags.replace("g", "")).test(before),
  );
  const clause = sentence.slice(-windows.nearby);
  return binds || rules.nearby.some((marker) => marker.test(clause));
}

/**
 * A determination can also be negative ("not eligible", "does not qualify").
 * Telling someone they do not qualify is still an eligibility decision only the
 * agency may make, so these are checked without the hedge exemption: a negation
 * inside the phrase is the determination, not a disclaimer.
 */
const NEGATED_DETERMINATIONS: Readonly<Record<string, readonly RegExp[]>> = {
  pt: [
    /(?<!\p{L})não\s+(?:é|são)\s+(?:elegível|elegíveis)(?!\p{L})/iu,
    /(?<!\p{L})não\s+(?:se\s+qualifica|qualificam)(?!\p{L})/iu,
    /(?<!\p{L})não\s+tem\s+direito(?!\p{L})/iu,
  ],
  hi: [
    /(?:पात्र|योग्य)\s+नहीं(?!\p{L})/u,
    /(?:अधिकार|हक)\s+नहीं(?!\p{L})/u,
    /नहीं\s+(?:पात्र|योग्य|हकदार)(?!\p{L})/u,
  ],
  ru: [
    /(?<!\p{L})не\s+(?:имеете|имеет)\s+права(?!\p{L})/iu,
    /(?<!\p{L})не\s+(?:соответствуете|соответствует)(?!\p{L})/iu,
    /(?<!\p{L})не\s+положено(?!\p{L})/iu,
  ],
  fr: [
    /(?<!\p{L})(?:n'|ne\s+)(?:est|êtes|es)\s+pas\s+(?:admissible|éligible)(?:s)?(?!\p{L})/iu,
    /(?<!\p{L})pas\s+(?:admissible|éligible)(?:s)?(?!\p{L})/iu,
  ],
  zh: [/不符合(?:资格|条件|规定)/, /没有资格/],
  vi: [
    /(?<!\p{L})không\s+(?:đủ\s+điều\s+kiện|hội\s+đủ\s+điều\s+kiện)(?!\p{L})/iu,
    /(?<!\p{L})không\s+(?:được\s+hưởng|đủ\s+tiêu\s+chuẩn)(?!\p{L})/iu,
  ],
  tl: [/(?<!\p{L})hindi\s+(?:ka\s+)?(?:kwalipikado|karapat-dapat|eligible)(?!\p{L})/iu],
  ar: [/غير\s+مؤهل/, /غير\s+مستحق/, /لا\s+يحق/],
  ko: [/자격이\s+없/, /(?:수급|혜택)\s*(?:대상이\s+)?아니/],
  ht: [/(?<!\p{L})pa\s+(?:kalifye|elijib)(?!\p{L})/iu, /(?<!\p{L})pa\s+dwa(?!\p{L})/iu],
};

/**
 * Banned-claim matches for one locale: the English and Spanish gate plus that
 * locale's own patterns. English text is checked by `findBannedClaims`.
 */
export function findLocaleClaims(
  text: string,
  language: string,
  findBannedClaims: (value: string) => BannedClaimMatch[],
): BannedClaimMatch[] {
  const matches = findBannedClaims(text);
  for (const pattern of BANNED_CLAIM_PATTERNS_BY_LOCALE[language] ?? []) {
    // Every occurrence, not just the first: a hedged claim early in a string
    // must not hide an unhedged one after it.
    const global = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
    for (let found = global.exec(text); found; found = global.exec(text)) {
      if (hedged(text, found.index, language)) continue;
      matches.push({
        patternSource: pattern.source,
        matchedText: found[0].slice(0, 80),
        index: found.index,
      });
    }
  }
  for (const pattern of NEGATED_DETERMINATIONS[language] ?? []) {
    const global = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
    for (let found = global.exec(text); found; found = global.exec(text)) {
      matches.push({
        patternSource: pattern.source,
        matchedText: found[0].slice(0, 80),
        index: found.index,
      });
    }
  }
  return matches;
}
