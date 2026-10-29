import type { Question } from "./intake/spec";

// Choice canonicalization (Mission v2 M2, hardening item 6 / BN-05 / BN-11).
// The structured extractor saves only exact option values, and validation
// round 1 observed live that realistic free-text phrasings ("It's for
// myself") extracted NOTHING while the assistant's ack implied a save.
//
// This layer maps realistic free-text phrasings onto spec options. It is a
// canonicalization aid over spec data, never a replacement for it: the
// output is always an option value of the question, or nothing. When
// nothing maps, the caller must say so honestly instead of implying a save.

/**
 * Common spoken/typed phrasings per option value. Keyed by option value;
 * a mapping attempt only ever consults the entries of the question's own
 * options, so the same value under different questions is safe. Deliberately
 * plain-language — no program names (pilot-agnostic until HACK-16).
 */
export const CHOICE_OPTION_SYNONYMS: Readonly<Record<string, string[]>> = {
  self: ["me", "myself", "my own", "my own self", "just me", "only me", "me myself", "myself only"],
  family_member: ["family member", "a family member", "family", "my family", "relative", "for my family", "member of my family", "my relatives"],
  someone_else: ["someone else", "somebody else", "another person", "someone else i help", "another person i help", "a friend of mine"],
  food: ["food", "groceries", "meals", "eating", "grocery help", "food help"],
  housing: ["housing", "housing help", "a place to stay", "place to stay", "rent help", "help with rent", "somewhere to live", "a place to live"],
  healthcare: ["healthcare", "health care", "medical", "medical care", "health", "doctor", "medicine", "doctor visits"],
  cash_assistance: ["cash assistance", "cash help", "cash", "money help", "financial help", "financial assistance", "emergency cash"],
  other: ["other", "something else", "something different"],
  job: ["job", "a job", "work", "employment", "working", "my job", "a new job"],
  self_employed: ["self employed", "odd jobs", "gig work", "freelance", "freelancing", "my own business"],
  benefits: ["benefits", "checks", "disability checks", "retirement checks", "monthly checks", "public assistance", "assistance checks"],
  family_friends: ["family or friends", "money from family", "help from family", "money from friends", "help from friends", "family help", "friends", "from family"],
  child_support: ["child support", "child support payments"],
  none: ["none", "no money", "nothing", "no income", "no money coming in", "nothing right now"],
  weekly: ["weekly", "every week", "each week", "once a week", "every single week"],
  biweekly: ["biweekly", "every two weeks", "every other week", "once every two weeks", "every 2 weeks"],
  twice_monthly: ["twice a month", "twice per month", "two times a month", "twice monthly"],
  monthly: ["monthly", "every month", "each month", "once a month", "per month"],
  varies: ["varies", "it varies", "different each time", "depends", "it depends", "irregular", "it changes", "no set schedule"],
  shelter: ["shelter", "a shelter", "the shelter", "in a shelter", "at a shelter"],
  car: ["car", "in a car", "my car", "vehicle", "in a vehicle", "my vehicle", "in my car"],
  outdoors: ["outdoors", "outside", "on the street", "the street", "a place not meant for sleeping", "in the open"],
  nowhere: ["nowhere", "no place", "had nowhere", "nowhere to sleep", "no place to sleep", "nowhere at all"],
  staying_with_others: ["staying with family", "staying with friends", "staying with others", "with family", "with friends", "couch surfing", "doubling up", "staying with family or friends", "staying with someone else"],
  rental_or_own: ["rent or own", "a place i rent", "a place i own", "my own place", "my place", "my apartment", "my home", "renting", "own my home", "in my own place"],
  have_id: ["have id", "i have one", "have an id", "i have an id", "got one", "i have my id", "my id"],
  need_id: ["need id", "i need one", "need an id", "i need an id", "don't have one", "dont have one", "do not have one", "no id", "lost my id"],
  id_in_progress: ["in progress", "id in progress", "working on it", "on the way", "getting it", "working on getting it"],
  us_citizen: ["us citizen", "u.s. citizen", "united states citizen", "citizen", "american citizen", "i am a citizen"],
  permanent_resident: ["permanent resident", "green card", "green card holder", "lawful permanent resident", "permanent resident status"],
  other_status: ["other status", "another status", "different status"],
  yes: ["yes", "yeah", "yep", "i do", "we do", "someone does", "yes someone does"],
  no: ["no", "nope", "nobody", "i do not", "we do not"],
  not_sure: ["not sure", "unsure", "i don't know", "i dont know", "don't know", "dont know", "no idea", "not certain", "dunno", "not really sure"],
  not_student: ["not a student", "not student", "i'm not in school", "not in school"],
  full_time_student: ["full time student", "in school full time", "full time", "full time in school"],
  part_time_student: ["part time student", "in school part time", "part time", "part time in school"],
  po_box: ["po box", "p.o. box", "post office box", "a po box", "box number"],
  general_delivery: ["general delivery"],
  day_center: ["day center", "day shelter", "drop in center", "resource center", "a day center", "at a day center"],
  family_or_friend: ["family or friend", "family or friends", "with family", "with a friend", "with friends", "at family", "a family member's place"],
  call: ["call", "a call", "phone call", "phone", "telephone", "by phone", "phone me", "calls"],
  text: ["text", "texts", "texting", "text message", "sms", "text me"],
  email: ["email", "e mail", "emails", "by email"],
  in_person: ["in person", "face to face"],
  morning: ["morning", "mornings", "in the morning", "the morning", "early morning"],
  afternoon: ["afternoon", "afternoons", "in the afternoon", "midday", "around noon", "the afternoon"],
  evening: ["evening", "evenings", "in the evening", "at night", "night", "the evening"],
};

/**
 * Leading/trailing filler tokens stripped before matching. Deliberately
 * excludes words that are themselves answers ("me", "yes", "no", "not",
 * "sure", "maybe") and anything option-like.
 */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  "it", "its", "it's", "that", "thats", "that's", "this", "there", "theres",
  "here", "i", "im", "i'm", "ive", "i've", "we", "our", "you", "the", "a",
  "an", "for", "to", "of", "about", "with", "on", "in", "at", "is", "am",
  "are", "was", "were", "be", "been", "do", "does", "did", "just", "only",
  "really", "mostly", "actually", "probably", "please", "would", "could",
  "should", "like", "right", "now", "today", "currently", "applying",
  "apply", "application", "want", "wanted", "need", "needed", "looking",
  "look", "help", "answer", "and", "also", "so", "well", "then", "hello",
  "hi", "um", "uh", "basically", "pretty", "think", "guess", "honestly",
  "frankly",
]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercase, straighten apostrophes, drop punctuation noise, collapse spaces. */
export function normalizeChoiceText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[''‛]/g, "'")
    // Word separators become spaces ("self-employed" → "self employed");
    // dots vanish so "u.s." → "us".
    .replace(/[-–—/,]/g, " ")
    .replace(/\./g, "")
    .replace(/[!?;:"()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip filler tokens from both ends, but never an option's own values. */
function stripFillers(question: Question, normalized: string): string {
  // Protection is keyed on option VALUES deliberately: label words like the
  // "I" in "Someone else I help" must stay strippable, and no option VALUE
  // is itself a filler word.
  const optionValues = new Set(
    (question.options ?? []).flatMap((option) => option.value.split(" ")),
  );
  let tokens = normalized.split(" ").filter((token) => token !== "");
  let changed = true;
  while (changed && tokens.length > 0) {
    changed = false;
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    if (FILLER_WORDS.has(first) && !optionValues.has(first)) {
      tokens = tokens.slice(1);
      changed = true;
    }
    const lastAfter = tokens[tokens.length - 1];
    if (
      tokens.length > 0 &&
      FILLER_WORDS.has(lastAfter) &&
      !optionValues.has(lastAfter)
    ) {
      tokens = tokens.slice(0, -1);
      changed = true;
    }
    void last;
  }
  return tokens.join(" ");
}

interface PhraseMatch {
  readonly optionValue: string;
  readonly phraseLength: number;
}

/** Longest label/synonym phrase of each option that appears in the text. */
function containmentMatches(
  question: Question,
  texts: readonly string[],
  preferAll: boolean,
): PhraseMatch[] | null {
  const matches: PhraseMatch[] = [];
  for (const option of question.options ?? []) {
    const phrases = [
      normalizeChoiceText(option.label),
      ...(CHOICE_OPTION_SYNONYMS[option.value] ?? []).map((phrase) =>
        normalizeChoiceText(phrase),
      ),
    ]
      .filter((phrase) => phrase.length >= 3)
      .sort((a, b) => b.length - a.length);
    for (const phrase of phrases) {
      const pattern = new RegExp(
        `(?<![a-z0-9'])${escapeRegExp(phrase)}(?![a-z0-9'])`,
      );
      // A negation ruling the option OUT ("not housing", "no food",
      // "never a job") must not count as choosing it (claude-review P2-4).
      // Checked as a window before the match: negation + up to two
      // intervening words. When blocked, this option simply does not match
      // and the turn falls toward the honest "couldn't match" reply.
      const isNegated = (text: string): boolean => {
        const match = pattern.exec(text);
        if (!match) {
          return false;
        }
        const before = text
          .slice(Math.max(0, (match.index ?? 0) - 18), match.index ?? 0)
          .toLowerCase();
        // Checked as a window before the match: negation + up to one
        // intervening word ("never a job"). Normalization erases sentence
        // punctuation, so a negation followed by a DIFFERENT option in the
        // same breath ("not housing, food") also reads as negated — that
        // under-matches toward the honest "couldn't match" reply, which is
        // the safe direction (a wrong save is worse than a re-ask).
        return /(?:^|\s)(?:not|no|never|dont|don't)\s+(?:\w+\s+)?$/.test(
          before,
        );
      };
      if (texts.some((text) => pattern.test(text) && !isNegated(text))) {
        matches.push({ optionValue: option.value, phraseLength: phrase.length });
        break; // longest phrase per option is enough
      }
    }
  }
  if (matches.length === 0) {
    return null;
  }
  if (preferAll) {
    return matches; // multi-select: every matched option, spec order
  }
  // Single-select: the most specific (longest) match wins.
  const best = matches.reduce((a, b) => (b.phraseLength > a.phraseLength ? b : a));
  return [best];
}

/**
 * Map free text onto the question's option values. Returns the matched
 * option values (spec order for multi-select, one for single-select), or
 * null when nothing maps. Pure and deterministic.
 */
export function mapChoiceText(
  question: Question,
  text: string,
): string[] | null {
  const options = question.options;
  if (!options || options.length === 0) {
    return null;
  }
  const normalized = normalizeChoiceText(text);
  if (normalized === "") {
    return null;
  }
  // Exact value / label equality (the extractor's normal output).
  const exactValue = options.find((option) => option.value === normalized);
  if (exactValue) {
    return [exactValue.value];
  }
  const exactLabel = options.find(
    (option) => normalizeChoiceText(option.label) === normalized,
  );
  if (exactLabel) {
    return [exactLabel.value];
  }
  const stripped = stripFillers(question, normalized);
  // Equality after filler stripping, against values, labels, then synonyms.
  // (A text that strips to nothing — "i do" — skips these tiers; containment
  // below still runs on the untouched normalized text.)
  if (stripped !== "") {
    for (const option of options) {
      if (
        stripped === option.value ||
        stripped === normalizeChoiceText(option.label)
      ) {
        return [option.value];
      }
    }
    for (const option of options) {
      const synonyms = CHOICE_OPTION_SYNONYMS[option.value] ?? [];
      if (
        synonyms.some((synonym) => normalizeChoiceText(synonym) === stripped)
      ) {
        return [option.value];
      }
    }
  }
  // Phrase containment, most specific first — checked against both the
  // filler-stripped text and the untouched normalized text (a synonym
  // phrase may itself start or end with a filler word).
  const matches = containmentMatches(
    question,
    [stripped, normalized],
    question.type === "multi_select",
  );
  if (matches && matches.length > 0) {
    return matches.map((match) => match.optionValue);
  }
  return null;
}

function asText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(" ");
  }
  return String(value);
}

/** True when the value is already a valid option (or list of options). */
function directOptionValues(
  question: Question,
  value: unknown,
): string[] | null {
  const options = question.options;
  if (!options || options.length === 0) {
    return null;
  }
  const isOption = (candidate: unknown): candidate is string =>
    typeof candidate === "string" &&
    options.some((option) => option.value === candidate);
  if (question.type === "multi_select") {
    if (!Array.isArray(value)) {
      return null;
    }
    const values = [...new Set(value.filter(isOption))];
    return values.length > 0 ? values : null;
  }
  return isOption(value) ? [value] : null;
}

/**
 * Canonicalize one extracted choice answer: accept exact option values as
 * they are; otherwise cascade through the extracted value's own words, the
 * verbatim span, and the raw turn text. Returns the mapped option values,
 * or null when nothing maps (the caller must then answer honestly that
 * nothing was saved).
 */
export function mapChoiceAnswer(
  question: Question,
  value: unknown,
  verbatim: string | undefined,
  rawTurnText: string | undefined,
): string[] | null {
  if (!question.options || question.options.length === 0) {
    return null;
  }
  const direct = directOptionValues(question, value);
  if (direct) {
    return direct;
  }
  const candidates = [asText(value), verbatim, rawTurnText];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      continue;
    }
    const mapped = mapChoiceText(question, candidate);
    if (mapped) {
      return mapped;
    }
  }
  return null;
}
