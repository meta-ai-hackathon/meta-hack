import {
  assembleFillValues,
  checkedFormValues,
  type FillAnswerRecord,
  type FillValue,
} from "../forms/fill-core";
import { buildFormFlow, type FormFlowView } from "../forms/flow";
import {
  parseCommittedRegistryEntries,
  type FormRegistryEntry,
} from "../forms/registry-core";
import { KB_ENTRIES, type KbEntry } from "../kb";
import {
  buildFactsMatchResponse,
  officialLinks,
  type MatchLink,
  type MatchResponse,
} from "../match-core";
import { PILOT_CONFIG } from "../pilot";
import type { AnswerMap } from "./flow";
import { toAnswerMap, vaultValues, type ClientAnswerState } from "./client-store";
import { QUESTION_BY_ID, QUESTIONS } from "./spec";

// The match, the review, and the filled application on the step-by-step
// page (HACK-115), computed in the browser from the answers sealed on the
// device. Nothing here reads a server store or sends a request: the match
// runs the same deterministic scoring as the server with every explanation
// composed from the entry's own facts (no model call), the review is the
// same form-driven field view the server's review route builds, and the
// fill runs the same value assembly and PDF fill as the server's fill
// route, over the device answers and the on-device vault view.
//
// The device answers are laid out the way the server keeps the same
// answers: the answer rows carry no private value (pii values live in the
// vault), and the form reads private values only through its committed
// allowlist. So for any answers, the device's review and filled form match
// what the server builds for the same answers field for field
// (property-proven in device-form.test.ts against the real routes).
//
// Nothing here loads pdf-lib: drawing onto the form is device-fill.ts,
// which the page loads only when the person downloads.

/** The pilot's registered form, read from the committed registry data. */
export const DEVICE_FORM_ENTRY: FormRegistryEntry = pilotFormEntry();

function pilotFormEntry(): FormRegistryEntry {
  const entries = parseCommittedRegistryEntries(
    (detail) => new Error(`The form registry entry failed validation: ${detail}`),
  );
  const entry = entries.find((candidate) => candidate.id === PILOT_CONFIG.formRegistryId);
  if (!entry) {
    throw new Error("The pilot's form is not in the committed registry.");
  }
  return entry;
}

/** The benefit match for the device answers: facts only, never a model call. */
export function deviceMatch(answers: ClientAnswerState): MatchResponse {
  return buildFactsMatchResponse(toAnswerMap(answers));
}

/**
 * The official ways to apply for the pilot's program, each citing its
 * source: where the person takes the form they filled. Shown whatever the
 * match says, like the form itself. They come from the pilot's own
 * knowledge base entries (KB_ENTRIES is the pilot seam's kbEntryIds, the
 * same seam that names the form), and only from active ones: a stale or
 * withdrawn entry's links are never presented (BN-29), the rule the match
 * follows too.
 */
export function deviceHandoffLinks(entries: readonly KbEntry[] = KB_ENTRIES): readonly MatchLink[] {
  return entries
    .filter((entry) => entry.status === "active")
    .flatMap((entry) => officialLinks(entry));
}

/**
 * The form review for the device answers: every field's state (filled from
 * an answer, still needed, or not needed), with the status and provenance
 * of its answer. Private values are left out of the view by construction.
 */
export function deviceFormReview(
  answers: ClientAnswerState,
  entry: FormRegistryEntry = DEVICE_FORM_ENTRY,
): FormFlowView {
  const provenances: Record<string, FillAnswerRecord["provenance"]> = {};
  for (const [questionId, record] of Object.entries(answers)) {
    if (record) {
      provenances[questionId] = record.provenance;
    }
  }
  return buildFormFlow(entry, toAnswerMap(answers), provenances);
}

/** The device answers as answer rows: a private answer's value stays out of its row. */
function answerRows(answers: ClientAnswerState): Record<string, FillAnswerRecord> {
  const rows: Record<string, FillAnswerRecord> = {};
  for (const [questionId, record] of Object.entries(answers)) {
    if (!record) {
      continue;
    }
    const pii = Object.hasOwn(QUESTION_BY_ID, questionId) && QUESTION_BY_ID[questionId].pii;
    rows[questionId] = {
      status: record.status,
      provenance: record.provenance,
      value: pii ? null : record.value,
    };
  }
  return rows;
}

/**
 * What the fill puts on the form for the device answers, plus the answers
 * the person typed into the review for fields the questions don't ask.
 * Typed answers left blank are not answers; the rest are checked as the
 * server's fill route checks them. Null when they don't pass.
 */
export function deviceFillValues(
  answers: ClientAnswerState,
  typed: Readonly<Record<string, string>> = {},
  entry: FormRegistryEntry = DEVICE_FORM_ENTRY,
): { values: Record<string, FillValue>; answerMap: AnswerMap } | null {
  const given = Object.fromEntries(
    Object.entries(typed).filter(([, value]) => value.trim() !== ""),
  );
  const formValues = checkedFormValues(entry, given);
  if (formValues === null) {
    return null;
  }
  return assembleFillValues(entry, answerRows(answers), vaultValues(answers, QUESTIONS), formValues);
}
