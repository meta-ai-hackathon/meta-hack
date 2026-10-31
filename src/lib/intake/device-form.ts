import { PDFDocument } from "@cantoo/pdf-lib";
import {
  assembleFillValues,
  checkedFormValues,
  fillLoadedPdf,
  type FillAnswerRecord,
  type FillOutcome,
  type FillValue,
} from "../forms/fill-core";
import { buildFormFlow, type FormFlowView } from "../forms/flow";
import {
  parseCommittedRegistryEntries,
  type FormRegistryEntry,
} from "../forms/registry-core";
import { buildFactsMatchResponse, type MatchResponse } from "../match-core";
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

export type DeviceFillResult =
  | { readonly kind: "filled"; readonly outcome: FillOutcome }
  /** A typed answer didn't pass the checks (too long, for example). Nothing was filled. */
  | { readonly kind: "invalid_answers" }
  /** The blank form couldn't be opened. Nothing was filled. */
  | { readonly kind: "unreadable_form" };

/**
 * Fill the blank form with the device answers, in memory. The bytes are
 * the person's own filled application; nothing here stores or sends them.
 *
 * The template is the committed public form (device-template.ts serves the
 * registry's own bytes, pinned by a test, and that copy passes the
 * server's XFA and encryption gate). A copy that won't open, encrypted
 * ones included, fills nothing.
 */
export async function fillFormOnDevice(
  templateBytes: Uint8Array,
  answers: ClientAnswerState,
  typed: Readonly<Record<string, string>> = {},
  entry: FormRegistryEntry = DEVICE_FORM_ENTRY,
): Promise<DeviceFillResult> {
  const assembled = deviceFillValues(answers, typed, entry);
  if (assembled === null) {
    return { kind: "invalid_answers" };
  }
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(templateBytes);
  } catch {
    return { kind: "unreadable_form" };
  }
  const { filled, toResolve } = await fillLoadedPdf(
    pdf,
    entry,
    assembled.values,
    assembled.answerMap,
  );
  return { kind: "filled", outcome: { bytes: await pdf.save(), filled, toResolve } };
}
