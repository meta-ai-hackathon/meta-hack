// HACK-107 / HACK-106: verified spoken rendition for voice replies.
//
// A voice turn produces, in the same single model call, a token-bearing
// display reply (rehydrated locally by Rampart reveal() before display) and
// a token-free spoken rendition of the same reply. The spoken rendition is
// untrusted model output: the model never receives the session table and
// must never invent values for tokens or emit a raw placeholder.
//
// Before anything is spoken, the spoken string is verified on-device:
//   1. it must be non-empty,
//   2. it must contain no bracketed or bare placeholder token, and
//   3. it must pass the same banned-claims gate as displayed replies.
// If the model's rendition fails, we fall back to a deterministic on-device
// rendering of the display reply that refers to each token only by a keyed
// generic noun phrase (e.g. "the first person you mentioned", "the Social
// Security number you shared") -- this is speech rendering, not rehydration:
// it never touches placeholder values. Repeats of the same token say "the
// same ..." so a token spoken twice does not sound like a new disclosure. If
// that also fails verification, we fail closed to subtitles / no audio.
// Neither rehydrated PII nor raw tokens may reach TTS or speechSynthesis.

import { findBannedClaims } from "./honesty";

const PLACEHOLDER_PATTERN = /\[[A-Z][A-Z_]*_\d+\]|\b[A-Z][A-Z_]*_\d+\b/;
const BRACKETED_TOKEN_PATTERN = /\[([A-Z][A-Z_]+)_(\d+)\]/g;

const PERSON_LABELS = new Set([
  "GIVEN_NAME",
  "SURNAME",
  "PERSON",
  "NAME",
  "FULL_NAME",
]);

/**
 * Generic noun phrase for each label Rampart can tokenize (the redactable
 * PiiLabel vocabulary; CITY/STATE/ZIP_CODE are keep-labels and never yield a
 * token, but they get a sane phrase if one ever does).
 *
 * The phrases are deliberately value-free and role-based — words a benefits
 * assistant might already say, so the spoken fallback reads like the reply
 * instead of a code dump. A token's ordinal stays specific: "the first" vs
 * "the second" person matters when the conversation covers several people.
 */
const LABEL_PHRASES: Readonly<Record<string, string>> = {
  SSN: "Social Security number",
  CREDIT_CARD: "card number",
  IP_ADDRESS: "IP address",
  EMAIL: "email address",
  PHONE: "phone number",
  URL: "link",
  TAX_ID: "tax ID",
  BANK_ACCOUNT: "bank account number",
  ROUTING_NUMBER: "routing number",
  GOVERNMENT_ID: "government ID",
  PASSPORT: "passport number",
  DRIVERS_LICENSE: "driver's license number",
  BUILDING_NUMBER: "street number",
  STREET_NAME: "street name",
  SECONDARY_ADDRESS: "apartment or unit",
  CITY: "city",
  STATE: "state",
  ZIP_CODE: "ZIP code",
};

const ORDINALS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
  "ninth",
  "tenth",
  "eleventh",
  "twelfth",
  "thirteenth",
  "fourteenth",
  "fifteenth",
  "sixteenth",
  "seventeenth",
  "eighteenth",
  "nineteenth",
  "twentieth",
];

function ordinalWord(n: number): string {
  if (n >= 1 && n <= ORDINALS.length) return ORDINALS[n - 1] as string;
  // English suffix rule with the 11th-13th exception (22nd, not "22th").
  const finalTwo = n % 100;
  if (finalTwo >= 11 && finalTwo <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function containsPlaceholder(text: string): boolean {
  return PLACEHOLDER_PATTERN.test(text);
}

export type SpokenVerification =
  | { ok: true; text: string }
  | { ok: false; reason: "empty" | "placeholder" | "banned_claim" };

export function verifySpokenRendition(spoken: string): SpokenVerification {
  const text = typeof spoken === "string" ? spoken.trim() : "";
  if (text === "") return { ok: false, reason: "empty" };
  if (containsPlaceholder(text)) return { ok: false, reason: "placeholder" };
  if (findBannedClaims(text).length > 0) {
    return { ok: false, reason: "banned_claim" };
  }
  return { ok: true, text };
}

/** The generic noun phrase a token's label speaks as. */
function genericPhrase(label: string): string {
  return LABEL_PHRASES[label] ?? "information";
}

/** The "you ..." tail that keeps the generic reference in the reply's voice. */
function genericTail(label: string): string {
  return PERSON_LABELS.has(label) ? "you mentioned" : "you shared";
}

export function fallbackSpokenRendition(displayReply: string): string | null {
  if (typeof displayReply !== "string" || displayReply.trim() === "") {
    return null;
  }
  // Counting pass: some labels have several different tokens in one reply
  // ("the second phone number", not "the first phone number" when
  // everything shifts). A lone fact token drops its ordinal entirely.
  // Person tokens always keep theirs: "the first person" vs "the second"
  // matters when several people come up.
  const tokensPerLabel = new Map<string, Set<string>>();
  for (const match of displayReply.matchAll(BRACKETED_TOKEN_PATTERN)) {
    const label = match[1] as string;
    const tokens = tokensPerLabel.get(label) ?? new Set<string>();
    tokens.add(match[0] as string);
    tokensPerLabel.set(label, tokens);
  }
  // replace() walks matches left to right, so how many times a token has
  // already been rendered tells a first mention from a later one. A later
  // mention of the same token is "the same phone number you shared", not a
  // fresh disclosure that sounds like a second number.
  const alreadySpoken = new Map<string, number>();
  const rendered = displayReply.replace(
    BRACKETED_TOKEN_PATTERN,
    (match: string, label: string, ordinalText: string): string => {
      const ordinal = Number.parseInt(ordinalText, 10);
      if ((alreadySpoken.get(match) ?? 0) > 0) {
        alreadySpoken.set(match, (alreadySpoken.get(match) ?? 0) + 1);
        return `the same ${genericPhrase(label)} ${genericTail(label)}`;
      }
      alreadySpoken.set(match, 1);
      if (PERSON_LABELS.has(label)) {
        return `the ${ordinalWord(ordinal)} person you mentioned`;
      }
      if ((tokensPerLabel.get(label)?.size ?? 0) <= 1) {
        return `the ${genericPhrase(label)} ${genericTail(label)}`;
      }
      return `the ${ordinalWord(ordinal)} ${genericPhrase(label)} ${genericTail(label)}`;
    },
  );
  const verified = verifySpokenRendition(rendered);
  return verified.ok ? verified.text : null;
}

export type SpokenTextSelection =
  | { kind: "verified"; text: string }
  | { kind: "fallback"; text: string }
  | { kind: "silent" };

export function selectSpokenText(input: {
  spokenReply?: string | null;
  displayReply: string;
}): SpokenTextSelection {
  if (typeof input.spokenReply === "string") {
    const verified = verifySpokenRendition(input.spokenReply);
    if (verified.ok) return { kind: "verified", text: verified.text };
  }
  const fallback = fallbackSpokenRendition(input.displayReply);
  if (fallback !== null) return { kind: "fallback", text: fallback };
  return { kind: "silent" };
}
