import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { displayValueFor } from "./display";
import type { FormRegistryField } from "./registry";

// displayValueFor's display_format (review P2 on the real-form export):
// a registry field that declares a printed-date format renders ISO date
// answers the way the form prints them — the person hands the agency a
// legible date, not an ISO string the form's mmddyyyy box mislabels.

function fieldWithFormat(displayFormat?: string): FormRegistryField {
  return {
    name: "3 Date of Birth mmddyyyy",
    type: "text",
    label: "3. Date of Birth (mm/dd/yyyy):",
    question: "What is this person's date of birth?",
    specQuestionId: "date_of_birth",
    ...(displayFormat === undefined ? {} : { displayFormat }),
    piiLikely: true,
    required: true,
    pages: [3],
    disposition: "mapped",
  };
}

/** Zero-padded ISO date for generated parts (no Date/timezone drift). */
function isoDate(parts: { y: number; m: number; d: number }): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}`;
}

describe("displayValueFor display_format", () => {
  it("renders an ISO date answer in the field's printed format", () => {
    expect(displayValueFor(fieldWithFormat("mm/dd/yyyy"), "1980-02-03")).toBe(
      "02/03/1980",
    );
  });

  it("falls back to the raw string without a format, or on non-ISO values", () => {
    expect(displayValueFor(fieldWithFormat(undefined), "1980-02-03")).toBe(
      "1980-02-03",
    );
    expect(displayValueFor(fieldWithFormat("mm/dd/yyyy"), "not a date")).toBe(
      "not a date",
    );
  });

  it("maps every generated date's parts, zero-padded, into the printed order", async () => {
    await fc.assert(
      fc.property(
        fc.integer({ min: 1900, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (y, m, d) => {
          const iso = isoDate({ y, m, d });
          const pad = (n: number) => String(n).padStart(2, "0");
          const formatted = displayValueFor(fieldWithFormat("mm/dd/yyyy"), iso);
          return formatted === `${pad(m)}/${pad(d)}/${y}`;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("displayValueFor yes/no widget pairs (full-form mapping part 1)", () => {
  // The DHB-5200's yes/no pairs are radio GROUPS (two kid widgets with
  // Yes_x/No_x export values). A boolean answer must render the same
  // checked/unchecked display a checkbox gets, so the fill can select the
  // right export value (the checked/unchecked semantics, not the raw
  // boolean's string form).
  const radioField: FormRegistryField = {
    name: "a sample yes/no question pair",
    type: "radio",
    label: "a sample yes/no question pair",
    question: "A sample yes/no question pair?",
    specQuestionId: null,
    piiLikely: true,
    required: false,
    pages: [4],
    disposition: "not_collected_by_interview",
    dispositionReason:
      "Display-shape fixture for the radio checked/unchecked mapping.",
  };

  it("renders boolean answers as checked/unchecked for radio fields", () => {
    expect(displayValueFor(radioField, true)).toBe("checked");
    expect(displayValueFor(radioField, false)).toBe("unchecked");
  });

  it("renders the vault's stringified booleans too", () => {
    expect(displayValueFor(radioField, "true")).toBe("checked");
    expect(displayValueFor(radioField, "false")).toBe("unchecked");
  });

  it("returns null for anything that is not a boolean", () => {
    expect(displayValueFor(radioField, "maybe")).toBeNull();
    expect(displayValueFor(radioField, 1)).toBeNull();
    expect(displayValueFor(radioField, null)).toBeNull();
  });
});
