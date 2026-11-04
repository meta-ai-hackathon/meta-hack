import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import { setLogSink, type LogLine } from "../telemetry";
import {
  EMPTY_CLIENT_ANSWERS,
  saveClientAnswer,
  type ClientAnswerState,
} from "../intake/client-store";
import { fillFormOnDevice } from "../intake/device-fill";
import { getFormRegistryEntry } from "./registry";
import {
  checkedFormValues,
  fillFormPdf,
  MAX_FORM_VALUES,
  skippedFieldNames,
  type FillValue,
} from "./fill";

// Forms fill tests (VAL-PDF-003/004/005/007): round-trip on the committed
// AcroForm sample and its flat variant, skip-logic respect, provenance per
// filled field, visibly-blank unknowns with a to-resolve list, and clean
// rejections for templates the fill cannot serve. Filled bytes are only
// ever in memory; no log line carries a value.
//
// VEHICLE CHANGE (HACK-138, owner decision 2026-11-04): the server fill
// route and its vault-reading collection path are retired, so the
// round-trip exercises the on-device fill (device-fill.ts, the
// step-by-step page's download) over the device's own answer state — the
// same value assembly and drawing the review-page download runs
// (review-fill.ts, pinned in its own suite). The meaning is unchanged:
// values round-trip, provenance rides, unknowns stay visibly blank, and
// nothing is ever persisted. The vault-crossing tests retired with the
// crossing machinery; the vault boundary itself is pinned in
// vault-boundary.test.ts and vault.test.ts.

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const acroformTemplate = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-acroform.pdf")));
const flatTemplate = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-flat.pdf")));
const xfaTemplate = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-xfa.pdf")));
const encryptedTemplate = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-encrypted.pdf")));

const ENTRY = getFormRegistryEntry("sample-application-form");
const FLAT_ENTRY = getFormRegistryEntry("sample-application-form-flat");

/** The known answer set as the device keeps it (the step-by-step page's state). */
function deviceState(
  answers: Record<string, { status: "known" | "unknown" | "unverified"; value: unknown }>,
): ClientAnswerState {
  let state = EMPTY_CLIENT_ANSWERS;
  for (const [questionId, answer] of Object.entries(answers)) {
    state = saveClientAnswer(state, {
      questionId,
      status: answer.status,
      value: answer.value,
      provenance: "user_supplied",
    });
  }
  return state;
}

/** A full known answer set, the same one the flows use (skip logic included). */
function knownAnswerSet() {
  return {
    household_size: { status: "known" as const, value: 3 },
    // housing_status = shelter SKIPS housing_cost in the spec's own skip
    // logic (no rent in a shelter) — the flow never asks it, so we never
    // answer it.
    date_of_birth: { status: "known" as const, value: "1990-01-01" },
    housing_status: { status: "known" as const, value: "shelter" },
    phone_contact: { status: "known" as const, value: "555-0100" },
    email_contact: { status: "known" as const, value: "person@example.com" },
    mailing_situation: { status: "known" as const, value: "shelter" },
    shelter_mail_consent: { status: "known" as const, value: true },
    id_status: { status: "known" as const, value: "need_id" },
    id_issue_detail: { status: "known" as const, value: "my ID was lost" },
  };
}

const SENTINEL_NAME = "FILL-SENTINEL-ZQX";

function expectedValues(): Record<string, string> {
  return {
    applicant_date_of_birth: "1990-01-01",
    household_size_count: "3",
    housing_situation: "In a shelter",
    contact_phone: "555-0100",
    contact_email: "person@example.com",
  };
}

describe("AcroForm round-trip on the device fill (VAL-PDF-003)", () => {
  it("fills every expected field with the expected value", async () => {
    const outcome = await fillFormOnDevice(
      acroformTemplate(),
      deviceState(knownAnswerSet()),
      {},
      ENTRY,
    );
    if (outcome.kind !== "filled") {
      throw new Error(`expected a fill, got ${outcome.kind}`);
    }
    const pdf = await PDFDocument.load(outcome.outcome.bytes);
    const form = pdf.getForm();
    const expected = expectedValues();
    for (const [fieldName, expectedValue] of Object.entries(expected)) {
      if (fieldName === "housing_situation") {
        continue; // a dropdown — asserted separately below
      }
      expect(form.getTextField(fieldName).getText()).toBe(expectedValue);
    }
    expect(
      form.getDropdown("housing_situation").getSelected(),
    ).toEqual(["In a shelter"]);
    expect(form.getCheckBox("mail_consent").isChecked()).toBe(true);
    expect(form.getTextField("id_problem_explanation").getText()).toBe(
      "my ID was lost",
    );
  });

  it("fills a mapped non-pii answer when the flow does not skip it", async () => {
    const outcome = await fillFormOnDevice(
      acroformTemplate(),
      deviceState({
        housing_status: { status: "known", value: "rental_or_own" },
        housing_cost: { status: "known", value: 900 },
      }),
      {},
      ENTRY,
    );
    if (outcome.kind !== "filled") {
      throw new Error(`expected a fill, got ${outcome.kind}`);
    }
    const pdf = await PDFDocument.load(outcome.outcome.bytes);
    expect(pdf.getForm().getTextField("monthly_rent_amount").getText()).toBe(
      "900",
    );
    expect(
      outcome.outcome.filled.find(
        (item) => item.fieldName === "monthly_rent_amount",
      )?.provenance,
    ).toBe("user_supplied");
  });

  it("records a provenance label for every filled field", async () => {
    const outcome = await fillFormOnDevice(
      acroformTemplate(),
      deviceState(knownAnswerSet()),
      {},
      ENTRY,
    );
    if (outcome.kind !== "filled") {
      throw new Error(`expected a fill, got ${outcome.kind}`);
    }
    const provenance = new Map(
      outcome.outcome.filled.map((item) => [item.fieldName, item.provenance]),
    );
    for (const fieldName of Object.keys(expectedValues())) {
      expect(provenance.get(fieldName)).toBe("user_supplied");
    }
    expect(provenance.get("mail_consent")).toBe("user_supplied");
    expect(provenance.get("id_problem_explanation")).toBe("user_supplied");
    // Unmapped fields with no typed answer are NOT in the filled set.
    expect(provenance.has("applicant_name")).toBe(false);
    expect(provenance.has("case_number")).toBe(false);
  });

  it("leaves unknown fields visibly blank and lists them as to-resolve", async () => {
    const outcome = await fillFormOnDevice(
      acroformTemplate(),
      deviceState({ household_size: { status: "known", value: 2 } }),
      {},
      ENTRY,
    );
    if (outcome.kind !== "filled") {
      throw new Error(`expected a fill, got ${outcome.kind}`);
    }
    const pdf = await PDFDocument.load(outcome.outcome.bytes);
    const form = pdf.getForm();
    // Visibly blank: no text in the fields nothing knew (getText is
    // undefined for an untouched field).
    expect(form.getTextField("applicant_date_of_birth").getText() ?? "").toBe("");
    expect(form.getTextField("contact_phone").getText() ?? "").toBe("");
    expect(form.getCheckBox("mail_consent").isChecked()).toBe(false);
    const toResolveNames = outcome.outcome.toResolve.map((item) => item.fieldName);
    expect(toResolveNames).toContain("applicant_date_of_birth");
    expect(toResolveNames).toContain("applicant_name");
    expect(toResolveNames).toContain("case_number");
    expect(toResolveNames).toContain("contact_phone");
    // Skipped by the flow (housing_status unknown → fail-open → visible, so
    // housing_cost is to-resolve, not skipped — the fail-open contract).
    expect(toResolveNames).toContain("monthly_rent_amount");
    // Each to-resolve item carries the plain-language question (BN-21).
    for (const item of outcome.outcome.toResolve) {
      expect(item.question).not.toBe("");
    }
  });

  it("a typed unmapped answer fills and carries provenance", async () => {
    // The answers typed into the review fill and live only in the person's
    // own copy — nothing stores them.
    const outcome = await fillFormOnDevice(
      acroformTemplate(),
      deviceState({}),
      { applicant_name: SENTINEL_NAME },
      ENTRY,
    );
    if (outcome.kind !== "filled") {
      throw new Error(`expected a fill, got ${outcome.kind}`);
    }
    const pdf = await PDFDocument.load(outcome.outcome.bytes);
    expect(pdf.getForm().getTextField("applicant_name").getText()).toBe(
      SENTINEL_NAME,
    );
    expect(
      outcome.outcome.filled.find((item) => item.fieldName === "applicant_name")
        ?.provenance,
    ).toBe("user_supplied");
    // The mapped-but-unanswered fields stay to-resolve.
    expect(outcome.outcome.toResolve.map((item) => item.fieldName)).toContain(
      "applicant_date_of_birth",
    );
    // Without the typed value the field stays blank + to-resolve.
    const without = await fillFormOnDevice(
      acroformTemplate(),
      deviceState({}),
      {},
      ENTRY,
    );
    if (without.kind !== "filled") {
      throw new Error(`expected a fill, got ${without.kind}`);
    }
    expect(without.outcome.toResolve.map((item) => item.fieldName)).toContain(
      "applicant_name",
    );
  });

  it("conditional fields respect the flow's skip logic", async () => {
    const outcome = await fillFormOnDevice(
      acroformTemplate(),
      deviceState(knownAnswerSet()),
      {},
      ENTRY,
    );
    if (outcome.kind !== "filled") {
      throw new Error(`expected a fill, got ${outcome.kind}`);
    }
    const pdf = await PDFDocument.load(outcome.outcome.bytes);
    const form = pdf.getForm();
    // Within the known set: housing_status = shelter skips housing_cost
    // (spec skip logic) — monthly_rent_amount stays blank, NOT to-resolve.
    expect(form.getTextField("monthly_rent_amount").getText() ?? "").toBe("");
    const toResolveNames = outcome.outcome.toResolve.map((item) => item.fieldName);
    expect(toResolveNames).not.toContain("monthly_rent_amount");
    expect(skippedFieldNames(ENTRY, {
      housing_status: { status: "known", value: "shelter" },
    })).toEqual(new Set(["monthly_rent_amount"]));
  });

  it("id-issue and mail-consent conditionals follow their skip conditions", async () => {
    const outcome = await fillFormOnDevice(
      acroformTemplate(),
      deviceState({
        id_status: { status: "known", value: "have_id" },
        mailing_situation: { status: "known", value: "family_or_friend" },
      }),
      {},
      ENTRY,
    );
    if (outcome.kind !== "filled") {
      throw new Error(`expected a fill, got ${outcome.kind}`);
    }
    const pdf = await PDFDocument.load(outcome.outcome.bytes);
    const form = pdf.getForm();
    expect(form.getTextField("id_problem_explanation").getText() ?? "").toBe("");
    expect(form.getCheckBox("mail_consent").isChecked()).toBe(false);
    const toResolveNames = outcome.outcome.toResolve.map((item) => item.fieldName);
    // Skipped by design: blank, and NOT to-resolve.
    expect(toResolveNames).not.toContain("id_problem_explanation");
    expect(toResolveNames).not.toContain("mail_consent");
    expect(
      skippedFieldNames(ENTRY, {
        id_status: { status: "known", value: "have_id" },
        mailing_situation: { status: "known", value: "family_or_friend" },
      }),
    ).toEqual(new Set(["id_problem_explanation", "mail_consent"]));
  });

  it("rejects an XFA input at the fill level too", async () => {
    await expect(
      fillFormPdf(xfaTemplate(), ENTRY, {}),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects an encrypted input at the fill level too", async () => {
    await expect(
      fillFormPdf(encryptedTemplate(), ENTRY, {}),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("bad templates fill nothing on the device either (VAL-PDF-004)", async () => {
    // Encrypted bytes never open: nothing is filled.
    const encrypted = await fillFormOnDevice(
      encryptedTemplate(),
      deviceState({}),
      {},
      ENTRY,
    );
    expect(encrypted.kind).toBe("unreadable_form");
    // XFA bytes carry no fillable AcroForm fields: nothing fills and
    // nothing is fabricated — every field lands in to-resolve.
    const xfa = await fillFormOnDevice(xfaTemplate(), deviceState({}), {}, ENTRY);
    if (xfa.kind !== "filled") {
      throw new Error(`expected an empty fill, got ${xfa.kind}`);
    }
    expect(xfa.outcome.filled).toEqual([]);
    expect(xfa.outcome.toResolve.length).toBeGreaterThan(0);
  });

  it("a mapped non-pii date answer fills in its canonical display", async () => {
    const outcome = await fillFormOnDevice(
      acroformTemplate(),
      deviceState({
        date_of_birth: { status: "known", value: "1990-01-01" },
      }),
      {},
      ENTRY,
    );
    if (outcome.kind !== "filled") {
      throw new Error(`expected a fill, got ${outcome.kind}`);
    }
    const pdf = await PDFDocument.load(outcome.outcome.bytes);
    expect(pdf.getForm().getTextField("applicant_date_of_birth").getText()).toBe(
      "1990-01-01",
    );
  });

  it("non-WinAnsi display values are refused per field, not fatal", async () => {
    const values: Record<string, FillValue> = {
      applicant_name: {
        display: "姓名 test",
        provenance: "user_supplied",
        source: "in_request",
      },
      case_number: {
        display: "A-1234",
        provenance: "user_supplied",
        source: "in_request",
      },
    };
    const outcome = await fillFormPdf(acroformTemplate(), ENTRY, values);
    expect(outcome.filled.map((item) => item.fieldName)).toEqual([
      "case_number",
    ]);
    const degraded = outcome.toResolve.find(
      (item) => item.fieldName === "applicant_name",
    );
    expect(degraded?.reason).toBe("unsupported_characters");
  });
});

describe("flat PDF fill via coordinate fallback (VAL-PDF-007)", () => {
  it("draws expected values at the registry coordinates", async () => {
    const outcome = await fillFormOnDevice(
      flatTemplate(),
      deviceState(knownAnswerSet()),
      {},
      FLAT_ENTRY,
    );
    if (outcome.kind !== "filled") {
      throw new Error(`expected a fill, got ${outcome.kind}`);
    }
    // Re-parse the output with pdfjs and confirm the drawn values.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({
      data: outcome.outcome.bytes.slice(),
    }).promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const texts = content.items.map((item) =>
      "str" in item ? item.str : "",
    );
    for (const expected of Object.values(expectedValues())) {
      expect(texts).toContain(expected);
    }
    expect(texts).toContain("X"); // checked box
  });

  it("records provenance for drawn fields and leaves unknowns blank", async () => {
    const outcome = await fillFormOnDevice(
      flatTemplate(),
      deviceState({ household_size: { status: "known", value: 4 } }),
      {},
      FLAT_ENTRY,
    );
    if (outcome.kind !== "filled") {
      throw new Error(`expected a fill, got ${outcome.kind}`);
    }
    expect(
      outcome.outcome.filled.find(
        (item) => item.fieldName === "household_size_count",
      )?.provenance,
    ).toBe("user_supplied");
    expect(
      outcome.outcome.toResolve.map((item) => item.fieldName),
    ).toContain("applicant_name");
    // Unchecked boolean: visibly blank — no X drawn for mail_consent.
    expect(
      outcome.outcome.filled.map((item) => item.fieldName),
    ).not.toContain("mail_consent");
  });
});

describe("no value ever reaches a log line (VAL-PDF-005)", () => {
  it("the fill pipeline logs counts only — no values, no field ids", async () => {
    const lines: LogLine[] = [];
    setLogSink((line) => lines.push(JSON.parse(line) as LogLine));
    await fillFormOnDevice(
      acroformTemplate(),
      deviceState(knownAnswerSet()),
      { applicant_name: SENTINEL_NAME },
      ENTRY,
    );
    setLogSink(() => undefined);
    for (const line of lines) {
      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain(SENTINEL_NAME);
      expect(serialized).not.toContain("555-0100");
      expect(serialized).not.toContain("1990-01-01");
      expect(serialized).not.toContain("person@example.com");
      expect(serialized).not.toContain("applicant_name");
    }
  });
});

describe("typed answer checks (the on-device drafts)", () => {
  // The fill route's in-request answer validation retired with the route;
  // the same checks (fill-core's checkedFormValues) now guard the answers
  // typed into the device review and the conversation review, and the
  // callers degrade null to their own invalid-answers result.

  it("accepts bounded values for unmapped fields only", () => {
    const parsed = checkedFormValues(ENTRY, {
      applicant_name: "Jane Tester",
      case_number: "A-1234",
    });
    expect(parsed).toEqual({
      applicant_name: "Jane Tester",
      case_number: "A-1234",
    });
  });

  it("rejects a spec-mapped field name — mapped answers live in the stores", () => {
    expect(
      checkedFormValues(ENTRY, { applicant_date_of_birth: "1990-01-01" }),
    ).toBeNull();
    expect(checkedFormValues(ENTRY, { made_up_field: "x" })).toBeNull();
  });

  it("rejects non-string, empty, and oversized values, and non-object payloads", () => {
    expect(checkedFormValues(ENTRY, { applicant_name: 42 })).toBeNull();
    expect(checkedFormValues(ENTRY, { applicant_name: "   " })).toBeNull();
    expect(
      checkedFormValues(ENTRY, { applicant_name: "x".repeat(201) }),
    ).toBeNull();
    expect(checkedFormValues(ENTRY, ["not", "an", "object"] as unknown as Record<string, string>)).toBeNull();
    expect(checkedFormValues(ENTRY, "a string" as unknown as Record<string, string>)).toBeNull();
    expect(checkedFormValues(ENTRY, null)).toEqual({});
  });

  // Full-form mapping (VAL-FIX-007, owner decision): the review-and-
  // complete step carries a typed answer for EVERY mapped field of the
  // real DHB-5200 (the full-form persona rides the typed drafts) — the old
  // cap (50) was below the form's mapped-field count, so the cap now covers
  // every field the committed template has (614) with headroom. Pinned here
  // so the number is a reviewed decision, not a magic value.
  it("carries a full-form persona: the cap covers every mapped field with headroom", () => {
    expect(MAX_FORM_VALUES).toBe(650);
    // Boundary behavior on a synthetic spec-null entry: 650 typed answers
    // pass; 651 is refused (null).
    const wideEntry = {
      ...ENTRY,
      fields: Array.from({ length: 651 }, (_, index) => ({
        name: `persona_field_${index}`,
        type: "text" as const,
        label: `Persona field ${index}`,
        question: `Synthetic persona field ${index} for the typed-answer cap boundary (not committed data).`,
        specQuestionId: null,
        piiLikely: true,
        required: false,
        pages: [1],
        disposition: "mapped" as const,
      })),
    };
    const values = Object.fromEntries(
      Array.from({ length: 650 }, (_, index) => [`persona_field_${index}`, "x"]),
    );
    expect(Object.keys(checkedFormValues(wideEntry, values) ?? {})).toHaveLength(650);
    expect(
      checkedFormValues(wideEntry, { ...values, persona_field_650: "x" }),
    ).toBeNull();
  });
});
