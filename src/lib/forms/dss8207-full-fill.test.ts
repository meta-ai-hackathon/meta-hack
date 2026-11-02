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
import fullPersonaJson from "./fixtures/dss8207-full-persona.json";

// The full-form proof for the second real form (the milestone's part-3
// round, contract ids 007/008/011 of its area): the fill-time consistency
// check over the
// registry's conflict groups — the eleven independent Yes/No checkbox
// pairs and the check-one living-situation group — plus the FULL-form
// round-trip: the complete synthetic persona (fixture, tests only) + the
// spec answers fill EVERY mapped field and read back exactly what the
// persona carries, so CI proves the full-coverage fill without any
// Desktop artifact. Mirrors the dhb5200-full-fill pattern; the fill
// machinery itself is the same form-agnostic code both forms share.

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const REAL_FORM_PATH = path.join(FIXTURES, "dss-8207-fns-app-10-2024.pdf");
const realBytes = () => new Uint8Array(readFileSync(REAL_FORM_PATH));

const entry = () => getFormRegistryEntry("dss-8207");

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
 * The spec answers the full-form persona rides (the 8 questions the
 * dss-8207 registry links): pii values cross the vault through the
 * entry's allowlist (date of birth, phone, email), the costs/state ride
 * the answer table, and the two booleans map onto the checkbox ("A
 * veteran") and radio (prior-benefits pair) widgets. The displays are
 * what displayValueFor renders for these raw answers (the registry
 * declares no display_format on this form's date field, so the ISO date
 * is what fills the printed birth-date box).
 */
/**
 * The prior-benefits radio pair's registry name, looked up by its spec
 * link — this file sits inside src/lib/forms where the pilot-name scan
 * runs, so the template's own printed question (which names the program
 * twice) is never spelled out here.
 */
const PRIOR_BENEFITS_RADIO_NAME = entry().fields.find(
  (field) => field.specQuestionId === "received_benefits_before",
)!.name;

const SPEC_ANSWER_DISPLAYS: readonly {
  field: string;
  display: string;
  source: "vault" | "spec_answer";
}[] = [
  {
    field: "AmountWhat are the total monthly shelter costs rent or mortgage that the household pays",
    display: "950",
    source: "spec_answer",
  },
  {
    field: "AmountWhat is the total monthly utility cost heat electricity LPNatural Gas WaterSewage GarbageTrash TelephoneCell Phone and Utility Excess Public Housing",
    display: "180",
    source: "spec_answer",
  },
  { field: "Birth DateSelf", display: "1979-07-08", source: "vault" },
  {
    field: PRIOR_BENEFITS_RADIO_NAME,
    display: "unchecked",
    source: "spec_answer",
  },
  { field: "A veteran", display: "checked", source: "spec_answer" },
  { field: "Message Number", display: "555-010-9911", source: "vault" },
  {
    field: "Email Address voluntary",
    display: "alex.rivera@example.com",
    source: "vault",
  },
  { field: "Text5", display: STATE_OPTION_LABEL, source: "spec_answer" },
];

/** The skip-logic answer map those spec answers produce (nothing skips:
 * the two skip-conditioned questions' gate answers are absent, which
 * fails open and keeps every linked field visible). */
const SPEC_ANSWER_MAP = {
  housing_cost: { status: "known" as const, value: 950 },
  utilities_cost: { status: "known" as const, value: 180 },
  date_of_birth: { status: "known" as const, value: "1979-07-08" },
  received_benefits_before: { status: "known" as const, value: false },
  veteran_status: { status: "known" as const, value: true },
  phone_contact: { status: "known" as const, value: "555-010-9911" },
  email_contact: {
    status: "known" as const,
    value: "alex.rivera@example.com",
  },
  state: { status: "known" as const, value: "NC" },
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

describe("the full-form persona round-trip (contract 007/011)", () => {
  it("fills EVERY mapped field from the fixture and reads back exactly what it carries", async () => {
    const registry = entry();
    const values = fullFormValues();
    // Self-checking: the value set covers EXACTLY the mapped fields (525),
    // no padding, no omissions.
    const mappedNames = registry.fields
      .filter((field) => field.disposition === "mapped")
      .map((field) => field.name)
      .sort();
    expect(Object.keys(values).sort()).toEqual(mappedNames);

    const outcome = await fillFormPdf(
      realBytes(),
      registry,
      values,
      SPEC_ANSWER_MAP,
    );
    // Every mapped field filled; nothing left to resolve; and the clean
    // persona carries ZERO conflicts (its checkbox answers never check two
    // sides of one group).
    expect(outcome.filled.length).toBe(mappedNames.length);
    expect(outcome.toResolve).toEqual([]);
    expect(outcome.conflicts).toEqual([]);

    // Read-back of EVERY mapped field: text and date values as the value
    // set carries them, checkbox states, radios by their discovered export
    // values — what the fixture carries is what the filled form shows.
    const reparsed = await PDFDocument.load(outcome.bytes, {
      ignoreEncryption: true,
    });
    const form = reparsed.getForm();
    for (const field of registry.fields) {
      if (field.disposition !== "mapped") {
        continue;
      }
      const expected = values[field.name]!.display;
      if (field.type === "checkbox") {
        expect(form.getCheckBox(field.name).isChecked(), field.name).toBe(
          expected === "checked",
        );
      } else if (field.type === "radio") {
        expect(form.getRadioGroup(field.name).getSelected(), field.name).toBe(
          expected === "checked"
            ? field.exportValues!.yes
            : field.exportValues!.no,
        );
      } else {
        expect(form.getTextField(field.name).getText(), field.name).toBe(
          expected,
        );
      }
    }
    // The typed signature block arrives exactly as the real typed-signature
    // step sends it (in-request only) and reads back byte for byte — the
    // printed name and date lines the form's signature page carries.
    expect(form.getTextField("Text1").getText()).toBe(
      FULL_PERSONA.Text1,
    );
    expect(
      form.getTextField("First Name Middle Initial Last Name").getText(),
    ).toBe(FULL_PERSONA["First Name Middle Initial Last Name"]);
    expect(form.getTextField("Date Signed").getText()).toBe(
      FULL_PERSONA["Date Signed"],
    );
  }, 60000);

  it("flags a contradictory yes/no pair at full-form scale and still fills the rest (conflict case)", async () => {
    const registry = entry();
    const values = fullFormValues();
    // The persona's coherent answer flips: BOTH sides of the benefits-card
    // pair ride the request (a contradictory review submission).
    values["undefined_2"] = fillValueFor("checked");
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
        question: registry.fields.find((field) => field.name === "Yes_9")!
          .question,
        fields: ["Yes_9", "undefined_2"],
      },
    ]);
    // Fill-as-asked: both sides print checked (the person's own answers,
    // faithfully rendered) — the flag tells them to resolve before submitting.
    const form = (await PDFDocument.load(outcome.bytes)).getForm();
    expect(form.getCheckBox("Yes_9").isChecked()).toBe(true);
    expect(form.getCheckBox("undefined_2").isChecked()).toBe(true);
    // Nothing else changed: every mapped field still filled, nothing
    // to-resolve.
    expect(outcome.filled.length).toBe(
      registry.fields.filter((field) => field.disposition === "mapped").length,
    );
    expect(outcome.toResolve).toEqual([]);
  }, 60000);

  it("flags two living-situation boxes checked (single-choice conflict case)", async () => {
    const registry = entry();
    const values = fullFormValues();
    // A second living-situation box joins the persona's Home election.
    values["Hotel"] = fillValueFor("checked");
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
        // order): the "Home" box, not the unchecked homeless box.
        question: registry.fields.find((field) => field.name === "Home")!
          .question,
        fields: ["Home", "Hotel"],
      },
    ]);
    const form = (await PDFDocument.load(outcome.bytes)).getForm();
    expect(form.getCheckBox("Home").isChecked()).toBe(true);
    expect(form.getCheckBox("Hotel").isChecked()).toBe(true);
    // The rest of the fill is unchanged.
    expect(outcome.filled.length).toBe(
      registry.fields.filter((field) => field.disposition === "mapped").length,
    );
    expect(outcome.toResolve).toEqual([]);
  }, 60000);
});

describe("the fill-time check-conflict consistency pass (contract 008)", () => {
  // Property (skills/property-based-testing): over the REAL form's bytes,
  // for every combination of checked states across one registered pair,
  // the fill FLAGS the group exactly when both sides would print checked —
  // and it NEVER silently picks a side: what the person asked checked is
  // what the filled form shows, conflict or not.
  it("flags a real yes/no pair exactly when both sides check, and fills as asked (property)", async () => {
    const { yes, no } = {
      yes: entry().fields.find((field) => field.name === "Yes_9")!,
      no: entry().fields.find((field) => field.name === "undefined_2")!,
    };
    const synthetic: FormRegistryEntry = { ...entry(), fields: [yes, no] };
    await fc.assert(
      fc.asyncProperty(
        fc.tuple(fc.boolean(), fc.boolean()),
        async ([yesChecked, noChecked]) => {
          const values: Record<string, FillValue> = {};
          if (yesChecked) {
            values["Yes_9"] = fillValueFor("checked");
          }
          if (noChecked) {
            values["undefined_2"] = fillValueFor("checked");
          }
          const outcome = await fillFormPdf(realBytes(), synthetic, values);
          expect(outcome.conflicts).toEqual(
            yesChecked && noChecked
              ? [
                  {
                    kind: "yes_no",
                    question: yes.question,
                    fields: ["Yes_9", "undefined_2"],
                  },
                ]
              : [],
          );
          // Fill-as-asked: the flag never alters the printed boxes.
          const form = (await PDFDocument.load(outcome.bytes)).getForm();
          expect(form.getCheckBox("Yes_9").isChecked()).toBe(yesChecked);
          expect(form.getCheckBox("undefined_2").isChecked()).toBe(noChecked);
        },
      ),
      // Each run fills + re-parses the 10-page PDF (~0.3 s) - few runs.
      { numRuns: 4 },
    );
  }, 30000);

  it("flags the check-one living-situation group of any checked size, in registry order", () => {
    const group = entry().fields.filter(
      (field) => field.conflictGroup?.id === "p3-living-situation",
    );
    expect(group.length).toBeGreaterThanOrEqual(2);
    const synthetic: FormRegistryEntry = {
      ...entry(),
      fields: group as FormRegistryField[],
    };
    const conflicting: Record<string, FillValue> = {};
    for (const field of group) {
      conflicting[field.name] = fillValueFor(
        field.name === "Home" || field.name === "Hotel" ? "checked" : "unchecked",
      );
    }
    expect(detectCheckConflicts(synthetic, conflicting)).toEqual([
      {
        kind: "single_choice",
        question: "Home?",
        fields: ["Home", "Hotel"],
      },
    ]);
    // A single checked member is never a conflict.
    const single: Record<string, FillValue> = {};
    for (const field of group) {
      single[field.name] = fillValueFor(
        field.name === "Shelter for Battered Women and Children"
          ? "checked"
          : "unchecked",
      );
    }
    expect(detectCheckConflicts(synthetic, single)).toEqual([]);
  });
});
