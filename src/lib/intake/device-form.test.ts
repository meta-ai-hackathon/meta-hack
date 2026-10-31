import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import postgres from "postgres";
import { PDFDocument } from "@cantoo/pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as matchRoute } from "../../app/api/match/route";
import { GET as reviewRoute } from "../../app/api/forms/[formId]/review/route";
import { closeDb } from "../db";
import { collectFillValues, fillForSession, parseFormValues, skippedFieldNames } from "../forms/fill";
import { formRegistryEntries } from "../forms/registry";
import type { FormRegistryEntry } from "../forms/registry-core";
import type { AnswerStatus } from "../honesty";
import { runMigrations } from "../migrate";
import { setLogSink } from "../telemetry";
import type { CanonicalAnswerValue } from "./answer-input";
import {
  EMPTY_CLIENT_ANSWERS,
  saveClientAnswer,
  type ClientAnswerProvenance,
  type ClientAnswerState,
} from "./client-store";
import { fillFormOnDevice } from "./device-fill";
import {
  DEVICE_FORM_ENTRY,
  deviceFillValues,
  deviceFormReview,
  deviceMatch,
} from "./device-form";
import { QUESTIONS, type Question } from "./spec";
import { saveAnswer } from "./store";

// The device's match, review, and filled form (HACK-115) against the
// server's own, for the same answers. Each generated answer set is saved
// twice: through the server store (answer rows plus the vault, as the
// conversation page keeps them) and into a device answer state (as the
// step-by-step page keeps them). The real fill, review, and match code on
// each side must then agree: the same field values and provenance, the same
// to-resolve and not-applicable lists, the same review view, and the same
// facts-only match the consent-declined route returns.

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
  }
}

interface GeneratedAnswer {
  readonly status: AnswerStatus;
  readonly provenance: ClientAnswerProvenance;
  readonly value: CanonicalAnswerValue | null;
}

function answerFor(question: Question): fc.Arbitrary<GeneratedAnswer> {
  return fc
    .tuple(
      fc.constantFrom<AnswerStatus>("known", "unknown", "unverified"),
      fc.constantFrom<ClientAnswerProvenance>("user_supplied", "ai_drafted", "source_verified"),
      valueFor(question),
    )
    .map(([status, provenance, value]) => ({
      status,
      // Both stores pair a drafted answer only with "not verified".
      provenance: provenance === "ai_drafted" && status !== "unverified" ? "user_supplied" : provenance,
      value: status === "unknown" ? null : value,
    }));
}

const answersArb = fc.record(
  Object.fromEntries(QUESTIONS.map((question) => [question.id, answerFor(question)])),
  { requiredKeys: [] },
) as fc.Arbitrary<Readonly<Record<string, GeneratedAnswer>>>;

/** What the person types into the review for the form's unmapped fields. */
function typedFor(entry: FormRegistryEntry): fc.Arbitrary<Record<string, string>> {
  const unmapped = entry.fields.filter((field) => field.specQuestionId === null);
  return fc.dictionary(
    fc.constantFrom(...unmapped.map((field) => field.name)),
    fc.oneof(
      fc.stringMatching(/^ ?[A-Za-z0-9][A-Za-z0-9 ,.#-]{0,40} ?$/),
      fc.constantFrom("   ", "", "Nguyễn Văn An"),
    ),
  );
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

/** What the server's review sends with a download: the typed answers that aren't blank. */
function sentWithDownload(typed: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(typed).filter(([, value]) => value.trim() !== ""));
}

/** Every registry field's value as a PDF viewer would read it. */
async function readFields(bytes: Uint8Array, entry: FormRegistryEntry): Promise<Record<string, unknown>> {
  const form = (await PDFDocument.load(bytes)).getForm();
  return Object.fromEntries(
    entry.fields.map((field) => {
      switch (field.type) {
        case "checkbox":
          return [field.name, form.getCheckBox(field.name).isChecked()];
        case "dropdown":
          return [field.name, form.getDropdown(field.name).getSelected()];
        default:
          return [field.name, form.getTextField(field.name).getText() ?? ""];
      }
    }),
  );
}

const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("the device form against the server's, for the same answers", () => {
  it("fills the same fields with the same values and lists the same fields to resolve", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async ({ entry, answers, typed }) => {
        const sessionId = await seedServer(answers);
        const state = deviceState(answers);
        const formValues = parseFormValues(entry, sentWithDownload(typed));

        // What goes onto the form, and the skip logic it runs under.
        const server = await collectFillValues(sessionId, entry, formValues);
        const device = deviceFillValues(state, typed, entry);
        expect(device).toEqual(server);
        expect(skippedFieldNames(entry, device!.answerMap)).toEqual(
          skippedFieldNames(entry, server.answerMap),
        );

        // The filled PDFs themselves.
        const serverFill = await fillForSession(templateFor(entry), entry, sessionId, formValues);
        const deviceFill = await fillFormOnDevice(templateFor(entry), state, typed, entry);
        expect(deviceFill.kind).toBe("filled");
        if (deviceFill.kind !== "filled") {
          return;
        }
        expect(deviceFill.outcome.filled).toEqual(serverFill.filled);
        expect(deviceFill.outcome.toResolve).toEqual(serverFill.toResolve);
        if (entry.kind === "acroform") {
          expect(await readFields(deviceFill.outcome.bytes, entry)).toEqual(
            await readFields(serverFill.bytes, entry),
          );
        }
      }),
      { numRuns: 30 },
    );
  }, 120_000);

  it("reviews the form and builds the match exactly as the server's routes do", async () => {
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

        // No consent receipt: the route explains from the entry's facts,
        // the only explanation the device ever shows.
        const matchResponse = await matchRoute(
          new Request("http://localhost:3100/api/match", { headers: { cookie } }),
        );
        expect(matchResponse.status).toBe(200);
        const match = (await matchResponse.json()) as Record<string, unknown>;
        const onDevice = deviceMatch(state);
        expect(asJson(onDevice.matches)).toEqual(match.matches);
        expect(asJson(onDevice.toResolve)).toEqual(match.toResolve);
      }),
      { numRuns: 40 },
    );
  }, 120_000);
});

describe("the device form entry", () => {
  it("is the pilot's registered form, as the server registers it", () => {
    expect(ENTRIES).toContainEqual(DEVICE_FORM_ENTRY);
  });
});
