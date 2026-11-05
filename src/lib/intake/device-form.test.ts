import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import postgres from "postgres";
import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFRadioGroup,
  PDFTextField,
  type PDFField,
} from "@cantoo/pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as matchRoute } from "../../app/api/match/route";
import { GET as reviewRoute } from "../../app/api/forms/[formId]/review/route";
import { closeDb } from "../db";
import {
  detectCheckConflicts,
  skippedFieldNames,
} from "../forms/fill";
import { formRegistryEntries } from "../forms/registry";
import type { FormRegistryEntry } from "../forms/registry-core";
import type { AnswerStatus } from "../honesty";
import { assertNoPiiValuesInMatch } from "../match";
import { runMigrations } from "../migrate";
import { setLogSink } from "../telemetry";
import type { CanonicalAnswerValue } from "./answer-input";
import {
  CLIENT_ANSWER_PROVENANCES,
  EMPTY_CLIENT_ANSWERS,
  saveClientAnswer,
  toAnswerMap,
  type ClientAnswerProvenance,
  type ClientAnswerState,
} from "./client-store";
import { fillFormOnDevice } from "./device-fill";
import {
  DEVICE_FORM_ENTRY,
  deviceFillValues,
  deviceFormCoverage,
  deviceFormReview,
  deviceMatch,
  reviewAnswersForForm,
} from "./device-form";
import { fillReviewOnDevice } from "./review-fill";
import { QUESTIONS, type Question } from "./spec";
import { saveAnswer } from "./store";

// The device's match, review, and filled form (HACK-115) against the
// server's own, for the same answers. Each generated answer set is saved
// twice: through the server store (answer rows plus the vault, as the
// conversation page keeps them) and into a device answer state (as the
// step-by-step page keeps them). The real review and match code on each
// side must then agree: the same field values and provenance, the same
// to-resolve and not-applicable lists, the same conflict flags for boxes
// checked on both sides of a question, the same review view, and the same
// facts-only match the consent-declined route returns.
//
// The FILLS now agree on the values the client holds (the server fill
// route retired on HACK-138): the review payload's views drive
// fillReviewOnDevice, the device state drives fillFormOnDevice, and every
// field both surfaces hold reads back the same on the printed form. A
// private field the payload structurally omits fills only on the device
// that holds it and degrades to blank + to-resolve on the review path.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_device_form";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const adminUrl = databaseFrom(databaseUrl, "postgres");
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

let admin: postgres.Sql;
let testDb: postgres.Sql;

beforeAll(async () => {
  admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  testDb = postgres(testUrl, { max: 1 });
  process.env.DATABASE_URL = testUrl;
  await runMigrations(testDb);
  setLogSink(() => undefined);
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await Promise.all([admin.end({ timeout: 1 }), testDb.end({ timeout: 1 })]);
  await closeDb();
});

async function createSession(): Promise<string> {
  const [person] = await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`;
  const [session] =
    await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`;
  return String(session.id);
}

const ENTRIES = formRegistryEntries();
const templates = new Map<string, Uint8Array>();
function templateFor(entry: FormRegistryEntry): Uint8Array {
  let bytes = templates.get(entry.id);
  if (!bytes) {
    bytes = new Uint8Array(readFileSync(path.resolve(entry.pdfPath)));
    templates.set(entry.id, bytes);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Generated answer sets
// ---------------------------------------------------------------------------

/**
 * Text a person might give, including some the form's standard font can't
 * draw. Every value carries a digit or a letter outside plain ASCII, so none
 * can be a word the match route's own copy prints, which its pii gate would
 * refuse.
 */
const textArb = fc.oneof(
  fc.stringMatching(/^[A-Z][a-z]{2,8} [0-9]{1,4}( [A-Za-z0-9#.-]{1,8})?$/),
  fc.constantFrom("Nguyễn Văn An", "李小龍", "Zoë Ñúñez", "+1 (704) 555-0100", "555-010-9911"),
);

/** A canonical value for `question`, the shape both stores keep after their checks. */
function valueFor(question: Question): fc.Arbitrary<CanonicalAnswerValue> {
  const options = (question.options ?? []).map((option) => option.value);
  switch (question.type) {
    case "single_select":
      return fc.constantFrom(...options);
    case "multi_select":
      return fc.uniqueArray(fc.constantFrom(...options), { minLength: 1, maxLength: 4 });
    case "number":
      return fc.integer({ min: 0, max: 5000 });
    case "boolean":
      return fc.boolean();
    case "date":
      // Dates before 2026, so a birth date can't coincide with a source's
      // retrieval date on a card (the match route's pii gate refuses those).
      return fc
        .date({ min: new Date("1930-01-01"), max: new Date("2025-12-31"), noInvalidDate: true })
        .map((date) => date.toISOString().slice(0, 10));
    case "text":
    case "address":
      return textArb;
    // The household roster and the per-person answers (HACK-134, 135, 128),
    // which the DHB-5200 registry doesn't map: one valid value each.
    case "roster":
      return fc.constant([{ id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" }]);
    case "attribution":
      return fc.constant([{ memberId: "member-1", situationId: "wr_income_580", months: "both" }]);
    case "work_activity":
      return fc.constant([{ memberId: "member-1", activity: "job_internship", hours: 20 }]);
  }
}

interface GeneratedAnswer {
  readonly status: AnswerStatus;
  readonly provenance: ClientAnswerProvenance;
  readonly value: CanonicalAnswerValue | null;
}

/**
 * A provenance paired with a status the way both stores require: a drafted
 * answer is only ever "not verified", and a value from a tax return or the
 * person's own correction of one is only ever "known".
 */
function pairedProvenance(
  status: AnswerStatus,
  provenance: ClientAnswerProvenance,
): ClientAnswerProvenance {
  if (provenance === "ai_drafted" && status !== "unverified") {
    return "user_supplied";
  }
  if (
    (provenance === "tax_return" ||
      provenance === "user") &&
    status !== "known"
  ) {
    return "user_supplied";
  }
  return provenance;
}

function answerFor(question: Question): fc.Arbitrary<GeneratedAnswer> {
  return fc
    .tuple(
      fc.constantFrom<AnswerStatus>("known", "unknown", "unverified"),
      fc.constantFrom(...CLIENT_ANSWER_PROVENANCES),
      valueFor(question),
    )
    .map(([status, provenance, value]) => ({
      status,
      provenance: pairedProvenance(status, provenance),
      value: status === "unknown" ? null : value,
    }));
}

const answersArb = fc.record(
  Object.fromEntries(QUESTIONS.map((question) => [question.id, answerFor(question)])),
  { requiredKeys: [] },
) as fc.Arbitrary<Readonly<Record<string, GeneratedAnswer>>>;

/**
 * What the person types into the review for the form's unmapped fields.
 * "checked" and "unchecked" are what the fill reads a box or a yes/no pair
 * from, and often every box of one check-one group or yes/no pair is
 * checked at once, so the fill-time conflict check has something to flag.
 */
function typedFor(entry: FormRegistryEntry): fc.Arbitrary<Record<string, string>> {
  const unmapped = entry.fields.filter((field) => field.specQuestionId === null);
  const free = fc.dictionary(
    fc.constantFrom(...unmapped.map((field) => field.name)),
    fc.oneof(
      fc.stringMatching(/^ ?[A-Za-z0-9][A-Za-z0-9 ,.#-]{0,40} ?$/),
      fc.constantFrom("   ", "", "Nguyễn Văn An", "checked", "unchecked"),
    ),
  );
  const groups = new Map<string, string[]>();
  for (const field of unmapped) {
    if (field.conflictGroup) {
      groups.set(field.conflictGroup.id, [...(groups.get(field.conflictGroup.id) ?? []), field.name]);
    }
  }
  if (groups.size === 0) {
    return free;
  }
  const allChecked = fc
    .constantFrom(...groups.values())
    .chain((members) => fc.subarray(members, { minLength: 2 }))
    .map((members) => Object.fromEntries(members.map((name) => [name, "checked"])));
  return fc
    .tuple(free, fc.option(allChecked, { freq: 2 }))
    .map(([typed, checked]) => ({ ...typed, ...(checked ?? {}) }));
}

const caseArb = fc
  .constantFrom(...ENTRIES)
  .chain((entry) =>
    fc.record({ entry: fc.constant(entry), answers: answersArb, typed: typedFor(entry) }),
  );

/** Save one generated answer set on the server, as the conversation page would. */
async function seedServer(answers: Readonly<Record<string, GeneratedAnswer>>): Promise<string> {
  const sessionId = await createSession();
  for (const [questionId, answer] of Object.entries(answers)) {
    await saveAnswer(sessionId, questionId, answer.status, answer.value, answer.provenance);
  }
  return sessionId;
}

/** The same answer set as the device keeps it. */
function deviceState(answers: Readonly<Record<string, GeneratedAnswer>>): ClientAnswerState {
  let state = EMPTY_CLIENT_ANSWERS;
  for (const [questionId, answer] of Object.entries(answers)) {
    state = saveClientAnswer(state, { questionId, ...answer });
  }
  return state;
}

/**
 * One field's value as a PDF viewer would read it, by the field's own kind
 * in the PDF. That can differ from the registry's: the DSS-8207 registers
 * its digital signature widget as text, and the fill leaves it blank by
 * disposition. A field with no value to read is compared by its kind.
 */
function readField(field: PDFField): unknown {
  if (field instanceof PDFCheckBox) {
    return field.isChecked();
  }
  if (field instanceof PDFRadioGroup) {
    return field.getSelected() ?? null;
  }
  if (field instanceof PDFDropdown) {
    return field.getSelected();
  }
  if (field instanceof PDFTextField) {
    return field.getText() ?? "";
  }
  return field.constructor.name;
}

/** Every registry field's value as a PDF viewer would read it. */
async function readFields(bytes: Uint8Array, entry: FormRegistryEntry): Promise<Record<string, unknown>> {
  const form = (await PDFDocument.load(bytes)).getForm();
  return Object.fromEntries(entry.fields.map((field) => [field.name, readField(form.getField(field.name))]));
}

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("the device form against the server's, for the same answers", () => {
  it("draws contradictory checks for the fill to flag often (non-vacuous)", () => {
    const cases = fc.sample(caseArb, { numRuns: 100, seed: 115 });
    const flagged = cases.filter(({ entry, answers, typed }) => {
      const assembled = deviceFillValues(deviceState(answers), typed, entry);
      return (
        assembled !== null &&
        detectCheckConflicts(entry, assembled.values, skippedFieldNames(entry, assembled.answerMap))
          .length > 0
      );
    });
    expect(flagged.length).toBeGreaterThan(10);
  });

  it("both download fills print the same values for the answers the client holds", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async ({ entry, answers, typed }) => {
        const state = deviceState(answers);

        // Both download paths run the page's box word-trust first: a box
        // answer that isn't the word checked or unchecked is named back and
        // nothing fills, so the parity below only covers fillable drafts.
        const { values: pageTyped, unreadable } = reviewAnswersForForm(
          typed,
          entry,
        );
        if (unreadable.length > 0) {
          return;
        }

        // The conversation page's download: the review payload's views (the
        // client-held values) plus the typed drafts drive the review fill.
        const views = deviceFormReview(state, entry).fields;
        const reviewFill = await fillReviewOnDevice(
          templateFor(entry),
          views,
          pageTyped,
          entry,
        );
        // The step-by-step page's download: the device state drives the
        // device fill.
        const deviceFill = await fillFormOnDevice(
          templateFor(entry),
          state,
          pageTyped,
          entry,
        );
        expect(deviceFill.kind).toBe("filled");
        if (deviceFill.kind !== "filled") {
          return;
        }
        if (reviewFill.kind !== "filled") {
          throw new Error(`expected a review fill, got ${reviewFill.kind}`);
        }

        // Every field the review payload carries (prefilled, non-private)
        // is filled on BOTH surfaces with the person's own provenance —
        // the two download surfaces agree on the values the client holds.
        const shared = views.filter(
          (field) =>
            field.state === "prefilled" &&
            !field.piiLikely &&
            field.value !== undefined,
        );
        const deviceFilled = new Set(
          deviceFill.outcome.filled.map((item) => item.fieldName),
        );
        const reviewFilled = new Set(
          reviewFill.outcome.filled.map((item) => item.fieldName),
        );
        for (const field of shared) {
          expect(deviceFilled.has(field.fieldName), field.fieldName).toBe(true);
          expect(reviewFilled.has(field.fieldName), field.fieldName).toBe(true);
        }

        // On the AcroForm forms the printed values agree field for field.
        if (entry.kind === "acroform") {
          const deviceFields = await readFields(deviceFill.outcome.bytes, entry);
          const reviewFields = await readFields(reviewFill.outcome.bytes, entry);
          for (const field of shared) {
            expect(deviceFields[field.fieldName]).toEqual(
              reviewFields[field.fieldName],
            );
          }
        }

        // A field the review marks ASKED (the person still owes the answer)
        // and does not hold privately is filled from the same information on
        // both surfaces: neither holds a value for it, and neither may skip
        // it (the device's fill-time skip map sees no more than the
        // review's), so BOTH list it to-resolve. Conflict flags and
        // not-applicable handling are pinned per fill (fill-core's own
        // suite, review-fill.test.ts): the two surfaces hold different
        // truths — the payload structurally omits private values, and the
        // fill-time skip map is allowlist-redacted — so their to-resolve
        // lists legitimately differ beyond this shared core (a field gated
        // by a private answer the form's allowlist doesn't admit prints
        // blank on BOTH surfaces and lands in the device's to-resolve even
        // when the review marks it not-needed).
        const reviewToResolve = new Set(
          reviewFill.outcome.toResolve.map((item) => item.fieldName),
        );
        const deviceToResolveNames = new Set(
          deviceFill.outcome.toResolve.map((item) => item.fieldName),
        );
        const askedNonPrivate = views.filter(
          (field) => field.state === "asked" && !field.piiLikely,
        );
        for (const field of askedNonPrivate) {
          expect(reviewToResolve.has(field.fieldName), field.fieldName).toBe(
            true,
          );
          expect(
            deviceToResolveNames.has(field.fieldName),
            field.fieldName,
          ).toBe(true);
          expect(deviceFilled.has(field.fieldName), field.fieldName).toBe(
            false,
          );
          expect(reviewFilled.has(field.fieldName), field.fieldName).toBe(
            false,
          );
        }

        // A private field the payload structurally omits fills only on the
        // device that holds it; on the review path it degrades to blank and
        // is honestly named to-resolve.
        for (const field of views) {
          if (field.state !== "prefilled" || !field.piiLikely) {
            continue;
          }
          expect(reviewFilled.has(field.fieldName), field.fieldName).toBe(false);
          expect(
            reviewToResolve.has(field.fieldName),
            field.fieldName,
          ).toBe(true);
        }
      }),
      { numRuns: 30 },
    );
  }, 120_000);

  it("reviews the form and builds the match exactly as the server's routes do", async () => {
    let compared = 0;
    await fc.assert(
      fc.asyncProperty(caseArb, async ({ entry, answers }) => {
        const sessionId = await seedServer(answers);
        const state = deviceState(answers);
        const cookie = `bn_session=${sessionId}`;

        const reviewResponse = await reviewRoute(
          new Request(`http://localhost:3100/api/forms/${entry.id}/review`, { headers: { cookie } }),
          { params: Promise.resolve({ formId: entry.id }) },
        );
        expect(reviewResponse.status).toBe(200);
        const review = (await reviewResponse.json()) as Record<string, unknown>;
        const view = deviceFormReview(state, entry);
        expect(asJson(view.fields)).toEqual(review.fields);
        expect(asJson(view.toResolve)).toEqual(review.toResolve);
        expect(asJson(view.counts)).toEqual(review.counts);
        expect(asJson(deviceFormCoverage(entry))).toEqual(review.coverage);

        // No consent receipt: the route explains from the entry's facts,
        // the only explanation the device ever shows.
        const matchResponse = await matchRoute(
          new Request("http://localhost:3100/api/match", { headers: { cookie } }),
        );
        const onDevice = deviceMatch(state);
        if (matchResponse.status !== 200) {
          // The route's last check refuses a whole response when a private
          // answer's text turns up in it without the public copy excusing
          // it. Since main made the work hours question private, an answer
          // like 0 or 1 does, because those digits appear in the response's
          // dates and ids. That is the only refusal: the same check refuses
          // the device's response too, which never leaves the device.
          expect(matchResponse.status).toBe(500);
          expect(() => assertNoPiiValuesInMatch(onDevice, toAnswerMap(state))).toThrow();
          return;
        }
        compared += 1;
        const match = (await matchResponse.json()) as Record<string, unknown>;
        expect(asJson(onDevice.matches)).toEqual(match.matches);
        expect(asJson(onDevice.toResolve)).toEqual(match.toResolve);
      }),
      { numRuns: 40 },
    );
    // Most answer sets still reach a served match to compare against.
    expect(compared).toBeGreaterThan(10);
  }, 120_000);
});

describe("the device form entry", () => {
  it("is the pilot's registered form, as the server registers it", () => {
    expect(ENTRIES).toContainEqual(DEVICE_FORM_ENTRY);
  });
});
