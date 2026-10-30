import type { Question } from "./spec";

// Answer-value canonicalization (BN-09), shared by the server store and the
// on-device intake (HACK-99). Pure and browser-safe: it imports only the
// question spec's types, so the step-by-step page can check an answer
// exactly as POST /api/intake/answer does without any answer reaching a
// server. store.ts wraps it to raise the taxonomy validation error.

/** The longest text or address answer either store accepts. */
export const MAX_ANSWER_TEXT_LENGTH = 2000;

/** What a valid known or unverified answer is stored as. */
export type CanonicalAnswerValue = string | number | boolean | string[];

/**
 * The canonical stored value of `value` for `question`, or null when the
 * value is not a valid answer to that question: text is trimmed and
 * non-empty, numbers are finite (numeric strings convert), dates are
 * YYYY-MM-DD, and choices come from the question's own options, with
 * multi-select de-duplicated in order.
 */
export function canonicalAnswerValue(
  question: Question,
  value: unknown,
): CanonicalAnswerValue | null {
  switch (question.type) {
    case "text":
    case "address": {
      if (typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      if (trimmed === "" || trimmed.length > MAX_ANSWER_TEXT_LENGTH) {
        return null;
      }
      return trimmed;
    }
    case "number": {
      let numeric = value;
      if (typeof numeric === "string" && numeric.trim() !== "") {
        numeric = Number(numeric);
      }
      if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
        return null;
      }
      return numeric;
    }
    case "boolean": {
      return typeof value === "boolean" ? value : null;
    }
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return null;
      }
      return value;
    }
    case "single_select": {
      if (
        typeof value !== "string" ||
        !question.options?.some((option) => option.value === value)
      ) {
        return null;
      }
      return value;
    }
    case "multi_select": {
      if (!Array.isArray(value) || value.length === 0) {
        return null;
      }
      const values = [...new Set(value.map((item) => String(item)))];
      for (const item of values) {
        if (!question.options?.some((option) => option.value === item)) {
          return null;
        }
      }
      return values;
    }
  }
}
