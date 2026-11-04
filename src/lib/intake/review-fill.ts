import { PDFDocument, ParseSpeeds } from "@cantoo/pdf-lib";
import {
  checkedFormValues,
  fillLoadedPdf,
  type FillOutcome,
  type FillValue,
} from "../forms/fill-core";
import {
  parseCommittedRegistryEntries,
  type FormRegistryEntry,
} from "../forms/registry-core";
import type { AnswerProvenance } from "../honesty";

// The conversation review's browser-side fill (HACK-138).
//
// The review section's download used to POST /api/forms/<formId>/fill,
// which filled the form on the server from the session's server-side
// stores — the answer table and, through the entry's per-form allowlist,
// the vault — and sent the filled PDF back to the page. The
// sanctioned-download rule (.github/claude-review/rules.md, the HACK-115
// owner decision) sanctions "a filled form created in the user's browser
// from values the client already holds", and says the exception "does not
// permit sending server- or vault-held pii values to a page or payload …
// a form value the client does not already hold stays off the client."
// The server-filled download crossed exactly that line: the vault-held
// values rode to the page inside the PDF.
//
// This module is the bounded fix: the review section fills the blank form
// HERE, in the browser, from the values the page already holds — the
// review payload's non-private field values (private ones are structurally
// omitted from the payload; their status badges render instead) and the
// answers typed into the review. No request carries answers; the only
// fetch on the path is the blank public template's GET
// (device-template.ts, no cookies, no referrer). Nothing here stores,
// sends, or logs anything: the bytes go to the person's own download and
// are gone when the page lets go of them.
//
// This is the conversation page's counterpart of the step-by-step page's
// device fill (device-fill.ts): the same drawing (fill-core's), over the
// client-held values each surface has. The conversation page's answers
// live on the server, so its fill covers the values its payload carries,
// and every field whose value the page doesn't hold comes out blank and
// to-resolve — the person finishes those lines by hand, the same way the
// review's still-needed list already describes.

/** The review payload's field view, as far as this fill reads it. */
export interface ReviewFillField {
  readonly fieldName: string;
  readonly state: "prefilled" | "asked" | "not_applicable";
  readonly specQuestionId: string | null;
  readonly piiLikely: boolean;
  /**
   * The display value — present ONLY for non-private prefilled fields,
   * exactly as the review route sends it (the fill prints the same
   * display the review shows).
   */
  readonly value?: string;
  readonly status?: "known" | "unknown" | "unverified";
  readonly provenance?: AnswerProvenance;
}

export type ReviewFillResult =
  | { readonly kind: "filled"; readonly outcome: FillOutcome }
  /** A typed box answer wasn't the word checked or unchecked. Nothing was filled. */
  | { readonly kind: "unreadable_boxes"; readonly fields: readonly string[] }
  /** A typed answer didn't pass the checks (too long, or a mapped field's name). Nothing was filled. */
  | { readonly kind: "invalid_answers" }
  /** The blank form couldn't be opened. Nothing was filled. */
  | { readonly kind: "unreadable_form" };

/** The only words a box or a yes/no pair on the form takes in the review. */
const BOX_ANSWER_WORDS = ["checked", "unchecked"];

/**
 * The committed registry entry for a form id, or undefined for an id the
 * registry doesn't carry.
 */
export function reviewFormEntry(formId: string): FormRegistryEntry | undefined {
  return parseCommittedRegistryEntries(
    (detail) => new Error(detail),
  ).find((entry) => entry.id === formId);
}

/**
 * Fill the blank form in the browser from the review payload's client-held
 * values plus the answers typed into the review, in memory.
 *
 * The payload's own field states are the skip decision: a field the review
 * marks not-applicable stays blank and out of the to-resolve list (the
 * client doesn't re-derive skip logic from values it can't see). A private
 * answer the page doesn't hold (its view carries the status badge, never a
 * value) is never filled and never asked for: it degrades to to-resolve,
 * fail-closed, the same way the server's fill degrades a value the vault
 * allowlist doesn't admit.
 */
export async function fillReviewOnDevice(
  templateBytes: Uint8Array,
  fields: readonly ReviewFillField[],
  drafts: Readonly<Record<string, string>> = {},
  entry: FormRegistryEntry,
): Promise<ReviewFillResult> {
  // Box answers typed into the review count only as checked or unchecked
  // (device-form.ts's reviewAnswersForForm rule): any other word would
  // print an unchecked box with no word to the person, so it is named back
  // before anything is filled.
  const boxNames = new Set(
    entry.fields
      .filter((field) => field.type === "checkbox" || field.type === "radio")
      .map((field) => field.name),
  );
  const unreadable: string[] = [];
  const readableDrafts: Record<string, string> = {};
  for (const [name, value] of Object.entries(drafts)) {
    // A blank draft is no answer (device-form.ts's rule): it is dropped
    // here, before the checks, and its field comes out blank to-resolve.
    if (value.trim() === "") {
      continue;
    }
    const word = value.trim().toLowerCase();
    if (boxNames.has(name)) {
      if (BOX_ANSWER_WORDS.includes(word)) {
        readableDrafts[name] = word;
      } else {
        unreadable.push(name);
      }
    } else {
      readableDrafts[name] = value;
    }
  }
  if (unreadable.length > 0) {
    return { kind: "unreadable_boxes", fields: unreadable };
  }
  // The same check the fill route runs on its in-request answers: keys
  // must be unmapped fields, values bounded non-empty text. Mapped fields'
  // answers live in the stores (here: the payload's own values).
  const draftValues = checkedFormValues(entry, readableDrafts);
  if (draftValues === null) {
    return { kind: "invalid_answers" };
  }

  const values: Record<string, FillValue> = {};
  for (const field of fields) {
    // Only a prefilled non-private view carries a value — the display the
    // review itself shows. Private views (status badge, no value) and
    // unknowns contribute nothing: their fields come out blank and
    // to-resolve below.
    if (field.state !== "prefilled" || field.piiLikely || field.value === undefined) {
      continue;
    }
    values[field.fieldName] = {
      display: field.value,
      provenance: field.provenance ?? "user_supplied",
      source: "spec_answer",
    };
  }
  for (const [name, display] of Object.entries(draftValues)) {
    values[name] = { display, provenance: "user_supplied", source: "in_request" };
  }

  let pdf: PDFDocument;
  try {
    // Parse fast: the fork's default Slow speed yields a `setTimeout` tick
    // per indirect object, and a browser throttles background tabs'
    // timers to about one a second — a 21-page form's parse would take
    // minutes of ticks. Fast parses without the ticks, in one go.
    pdf = await PDFDocument.load(templateBytes, { parseSpeed: ParseSpeeds.Fast });
  } catch {
    return { kind: "unreadable_form" };
  }
  const outcome = await fillLoadedPdf(pdf, entry, values, {});
  // Save in one go, too: the writer's default yields a `setTimeout` tick
  // per 50 objects, which a throttled background tab stretches to minutes.
  const bytes = await pdf.save({ objectsPerTick: Infinity });
  // The payload's not-applicable states are the skip decision (above):
  // their fields' blank to-resolve rows — which a valueless fill lists —
  // come back out, so the still-needed list stays the review's.
  const notApplicable = new Set(
    fields.filter((field) => field.state === "not_applicable").map((field) => field.fieldName),
  );
  return {
    kind: "filled",
    outcome: {
      bytes,
      filled: outcome.filled,
      toResolve: outcome.toResolve.filter((item) => !notApplicable.has(item.fieldName)),
      conflicts: outcome.conflicts,
    },
  };
}
