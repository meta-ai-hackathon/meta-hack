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
// rendering of the display reply that refers to each token only by type and
// ordinal (e.g. "the first person you mentioned") -- this is speech
// rendering, not rehydration: it never touches placeholder values. If that
// also fails verification, we fail closed to subtitles / no audio. Neither
// rehydrated PII nor raw tokens may reach TTS or speechSynthesis.

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

export function fallbackSpokenRendition(displayReply: string): string | null {
  if (typeof displayReply !== "string" || displayReply.trim() === "") {
    return null;
  }
  const rendered = displayReply.replace(
    BRACKETED_TOKEN_PATTERN,
    (_match, label: string, ordinalText: string) => {
      const ordinal = Number.parseInt(ordinalText, 10);
      if (PERSON_LABELS.has(label)) {
        return `the ${ordinalWord(ordinal)} person you mentioned`;
      }
      if (label === "SSN") {
        return "the social security number you mentioned";
      }
      return "the information you mentioned";
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
