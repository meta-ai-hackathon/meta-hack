import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { PDFDocument } from "@cantoo/pdf-lib";
import { fillFormPdf, detectCheckConflicts, type FillValue } from "./fill";
import { getFormRegistryEntry } from "./registry";
import type { FormRegistryEntry, FormRegistryField } from "./registry";
import { QUESTION_BY_ID } from "../intake/spec";
import { setLogSink } from "../telemetry";
import fullPersonaJson from "./fixtures/dhb5200-full-persona.json";

// The full-form proof (full-form mapping, VAL-FIX-007): the fill-time
// consistency check over the registry's conflict groups — the independent
// Yes/No checkbox pairs and check-one groups the part-3 claude-review
// finding named — plus the FULL-form round-trip: the complete synthetic
// persona (fixture, tests only) + the spec answers fill EVERY mapped field
// and read back exactly what the persona carries, so CI proves the
// full-coverage fill without any Desktop artifact.

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const REAL_FORM_PATH = path.join(FIXTURES, "dhb-5200-ia-9-2020.pdf");
const realBytes = () => new Uint8Array(readFileSync(REAL_FORM_PATH));

const entry = () => getFormRegistryEntry("dhb-5200");

/**
 * The full-form persona's in-request answers (fixture data, NOT product
 * data) — every mapped spec-null field of the real form, keyed by the
 * form's real field names.
 */
const FULL_PERSONA = fullPersonaJson as Record<string, string>;

/**
 * The state option label derived from the spec (this file sits inside
 * src/lib/forms where the pilot-name scan runs).
 */
const STATE_OPTION_LABEL = QUESTION_BY_ID.state.options!.find(
  (option) => option.value === "NC",
)!.label;

/**
 * The spec answers the full-form persona rides (the same full-coverage
 * fixture the fill route's full-coverage test saves through the ordinary
 * stores: pii values cross the vault through the entry's allowlist, the
 * wage + state ride the answer table, and income_sources keeps the wage
 * question inside the flow's visibility). The five displays are what
 * displayValueFor renders for these raw answers.
 */
const SPEC_ANSWER_DISPLAYS: readonly {
  field: string;
  display: string;
  source: "vault" | "spec_answer";
}[] = [
  { field: "3 Date of Birth mmddyyyy", display: "07/08/1979", source: "vault" },
  { field: "14 Phone Number", display: "555-014-2277", source: "vault" },
  { field: "5 State", display: STATE_OPTION_LABEL, source: "spec_answer" },
  { field: "7 County", display: "Sample County", source: "vault" },
  { field: "undefined_10", display: "1500", source: "spec_answer" },
];

/** The skip-logic answer map those spec answers produce (nothing skips). */
const SPEC_ANSWER_MAP = {
  date_of_birth: { status: "known" as const, value: "1979-07-08" },
  phone_contact: { status: "known" as const, value: "555-014-2277" },
  state: { status: "known" as const, value: "NC" },
  county: { status: "known" as const, value: "Sample County" },
  income_sources: { status: "known" as const, value: ["job"] },
  job_income_amount: { status: "known" as const, value: 1500 },
};

/**
 * The COMPLETE full-form value set: the persona's in-request answers plus
 * the spec answers — one value for every mapped field of the registry
 * (self-checked below), exactly as the real fill assembles them.
 */
function fullFormValues(): Record<string, FillValue> {
  const values: Record<string, FillValue> = {};
  for (const field of entry().fields) {
    if (field.disposition !== "mapped") {
      continue;
    }
    if (field.specQuestionId === null) {
      values[field.name] = {
        display: FULL_PERSONA[field.name]!,
        provenance: "user_supplied",
        source: "in_request",
      };
    }
  }
  for (const spec of SPEC_ANSWER_DISPLAYS) {
    values[spec.field] = {
      display: spec.display,
      provenance: "user_supplied",
      source: spec.source,
    };
  }
  return values;
}

function fillValueFor(display: string): FillValue {
  return { display, provenance: "user_supplied", source: "in_request" };
}

beforeAll(() => {
  setLogSink(() => undefined);
});

describe("the fill-time check-conflict consistency pass", () => {
  // Synthetic two-checkbox pair (the shape of the form's independent
  // Yes/No pairs, e.g. the Person 4 foster-care question): detectCheckConflicts
  // is a pure function, so the helper is exercised directly.
  const yesSide: FormRegistryField = {
    name: "pair_yes",
    type: "checkbox",
    label: "16. Was PERSON 4 in Foster Care when they turned 18?",
    question: "Synthetic yes-side field for the conflict check (not committed data).",
    specQuestionId: null,
    piiLikely: true,
    required: false,
    pages: [16],
    disposition: "mapped",
    exportValue: "On",
    conflictGroup: { id: "synthetic-pair", kind: "yes_no" },
  };
  const noSide: FormRegistryField = {
    ...yesSide,
    name: "pair_no",
    question: "Synthetic no-side field for the conflict check (not committed data).",
  };
  const unrelated: FormRegistryField = {
    ...yesSide,
    name: "race_box",
    label: "White",
    question: "A check-all-that-apply box carries no conflict group.",
  };
  const synthetic: FormRegistryEntry = {
    ...entry(),
    fields: [yesSide, noSide, { ...unrelated, conflictGroup: undefined }],
  };

  it("flags a group exactly when two or more of its members are checked", () => {
    const both = {
      pair_yes: fillValueFor("checked"),
      pair_no: fillValueFor("checked"),
    };
    expect(detectCheckConflicts(synthetic, both)).toEqual([
      {
        kind: "yes_no",
        question: yesSide.question,
        fields: ["pair_yes", "pair_no"],
      },
    ]);
    const onlyYes = { pair_yes: fillValueFor("checked") };
    expect(detectCheckConflicts(synthetic, onlyYes)).toEqual([]);
    expect(detectCheckConflicts(synthetic, {})).toEqual([]);
  });

  it("never counts skipped, unchecked-adjacent, or groupless boxes", () => {
    const both = {
      pair_yes: fillValueFor("checked"),
      pair_no: fillValueFor("checked"),
      race_box: fillValueFor("checked"),
    };
    // A skipped member (not applicable by the flow's conditional logic)
    // cannot contradict its partner.
    expect(
      detectCheckConflicts(synthetic, both, new Set(["pair_no"])),
    ).toEqual([]);
    // A check-all-that-apply box (no conflict group) never joins a flag.
    const raceOnly = { race_box: fillValueFor("checked") };
    expect(detectCheckConflicts(synthetic, raceOnly)).toEqual([]);
  });

  it("flags check-one groups of any size, naming the checked members in registry order", () => {
    const term5: FormRegistryField = {
      ...yesSide,
      name: "term_5y",
      conflictGroup: { id: "renewal", kind: "single_choice" },
    };
    const term4: FormRegistryField = { ...term5, name: "term_4y" };
    const term1: FormRegistryField = { ...term5, name: "term_1y" };
    const groupEntry: FormRegistryEntry = {
      ...entry(),
      fields: [term5, term4, term1],
    };
    const conflicting = {
      term_5y: fillValueFor("unchecked"),
      term_4y: fillValueFor("checked"),
      term_1y: fillValueFor("checked"),
    };
    expect(detectCheckConflicts(groupEntry, conflicting)).toEqual([
      {
        kind: "single_choice",
        question: term5.question,
        fields: ["term_4y", "term_1y"],
      },
    ]);
  });

  // Property (skills/property-based-testing): over the REAL form's bytes,
  // for every combination of checked states across one registered pair,
  // the fill FLAGS the group exactly when both sides would print checked —
  // and it NEVER silently picks a side: what the person asked checked is
  // what the filled form shows, conflict or not.
  it("flags a real yes/no pair exactly when both sides check, and fills as asked (property)", async () => {
    const { yes, no } = {
      yes: entry().fields.find((field) => field.name === "undefined_80")!,
      no: entry().fields.find((field) => field.name === "undefined_81")!,
    };
    const synthetic: FormRegistryEntry = { ...entry(), fields: [yes, no] };
    await fc.assert(
      fc.asyncProperty(fc.tuple(fc.boolean(), fc.boolean()), async ([yesChecked, noChecked]) => {
        const values: Record<string, FillValue> = {};
        if (yesChecked) {
          values["undefined_80"] = fillValueFor("checked");
        }
        if (noChecked) {
          values["undefined_81"] = fillValueFor("checked");
        }
        const outcome = await fillFormPdf(realBytes(), synthetic, values);
        expect(outcome.conflicts).toEqual(
          yesChecked && noChecked
            ? [
                {
                  kind: "yes_no",
                  question: yes.question,
                  fields: ["undefined_80", "undefined_81"],
                },
              ]
            : [],
        );
        // Fill-as-asked: the flag never alters the printed boxes.
        const form = (await PDFDocument.load(outcome.bytes)).getForm();
        expect(form.getCheckBox("undefined_80").isChecked()).toBe(yesChecked);
        expect(form.getCheckBox("undefined_81").isChecked()).toBe(noChecked);
      }),
      // Each run fills + re-parses the 21-page PDF (~0.5 s) - few runs.
      { numRuns: 4 },
    );
  }, 30000);
});

describe("the full-form persona round-trip (VAL-FIX-007)", () => {
  it("flags a contradictory yes/no pair at full-form scale and still fills the rest (conflict case)", async () => {
    const registry = entry();
    const values = fullFormValues();
    // The persona's coherent answer flips: BOTH sides of the Person 4
    // foster-care pair ride the request (a contradictory review submission).
    values["undefined_80"] = fillValueFor("checked");
    const outcome = await fillFormPdf(
      realBytes(),
      registry,
      values,
      SPEC_ANSWER_MAP,
    );
    // The conflict is FLAGGED for the person to resolve — never silently
    // picked a side, never dropped silently either.
    expect(outcome.conflicts).toEqual([
      {
        kind: "yes_no",
        question: registry.fields.find((field) => field.name === "undefined_80")!
          .question,
        fields: ["undefined_80", "undefined_81"],
      },
    ]);
    // Fill-as-asked: both sides print checked (the person's own answers,
    // faithfully rendered) — the flag tells them to resolve before submitting.
    const form = (await PDFDocument.load(outcome.bytes)).getForm();
    expect(form.getCheckBox("undefined_80").isChecked()).toBe(true);
    expect(form.getCheckBox("undefined_81").isChecked()).toBe(true);
    // Nothing else changed: every mapped field still filled, nothing
    // to-resolve.
    expect(outcome.filled.length).toBe(
      registry.fields.filter((field) => field.disposition === "mapped").length,
    );
    expect(outcome.toResolve).toEqual([]);
  }, 60000);

  it("flags two renewal-term boxes checked (single-choice conflict case)", async () => {
    const registry = entry();
    const values = fullFormValues();
    // A second term box joins the persona's 1-year election.
    values["4 years"] = fillValueFor("checked");
    const outcome = await fillFormPdf(
      realBytes(),
      registry,
      values,
      SPEC_ANSWER_MAP,
    );
    expect(outcome.conflicts).toEqual([
      {
        kind: "single_choice",
        // The flagged question is the first checked member's (registry
        // order): the "4 years" box, not the unchecked 5-year box.
        question: registry.fields.find((field) => field.name === "4 years")!
          .question,
        fields: ["4 years", "1 year"],
      },
    ]);
    const form = (await PDFDocument.load(outcome.bytes)).getForm();
    expect(form.getCheckBox("1 year").isChecked()).toBe(true);
    expect(form.getCheckBox("4 years").isChecked()).toBe(true);
  }, 60000);
});
