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
