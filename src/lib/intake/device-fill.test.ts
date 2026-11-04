import { readFileSync } from "node:fs";
import path from "node:path";
import { ParseSpeeds, PDFDocument } from "@cantoo/pdf-lib";
import type { LoadOptions, SaveOptions } from "@cantoo/pdf-lib";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_CLIENT_ANSWERS,
  saveClientAnswer,
  type ClientAnswerState,
} from "./client-store";
import { fillFormOnDevice } from "./device-fill";
import { parseCommittedRegistryEntries } from "../forms/registry-core";

// The step-by-step page's browser fill. The value assembly and the drawing
// are pinned in forms/fill.test.ts (the device vehicle); this file pins the
// parse and save SPEED options — the throttled-tab trap the HACK-138 audit
// found here after review-fill.ts got the same two options (PR #150):
//
// @cantoo/pdf-lib's defaults parse a document at ParseSpeeds.Slow — a
// setTimeout tick per ~100 objects — and save 50 objects per tick. A
// browser throttles a background or hidden tab's timers to about one a
// second, so a 21-page fill would stretch to MINUTES of ticks the moment
// the person switched apps with the print preview open. The fill must
// therefore load with parseSpeed Fast (a tick per ~1500 objects instead,
// about 2 on the real 21-page form) and save with objectsPerTick Infinity
// (one go, no ticks) — every load, every save, for any answers, on the
// sample form and the real one alike.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURES = path.join(REPO_ROOT, "src/lib/forms/fixtures");

const SAMPLE_BYTES = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-acroform.pdf")));
const REAL_BYTES = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "dhb-5200-ia-9-2020.pdf")));

const ENTRIES = parseCommittedRegistryEntries((detail) => new Error(detail));
const SAMPLE_ENTRY = ENTRIES.find((entry) => entry.id === "sample-application-form")!;

function deviceState(
  answers: Record<string, { status: "known"; value: unknown }>,
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

describe("fillFormOnDevice — the parse and save speed options", () => {
  // The captured options, with the real load and save still running
  // underneath: the pin observes the calls, it never stubs the fill.
  let loadOptions: (LoadOptions | undefined)[];
  let saveOptions: (SaveOptions | undefined)[];

  beforeEach(() => {
    loadOptions = [];
    saveOptions = [];
    const realLoad = PDFDocument.load.bind(PDFDocument);
    vi.spyOn(PDFDocument, "load").mockImplementation((bytes, options) => {
      loadOptions.push(options);
      return realLoad(bytes, options);
    });
    const realSave = PDFDocument.prototype.save;
    vi.spyOn(PDFDocument.prototype, "save").mockImplementation(function (
      this: PDFDocument,
      options,
    ) {
      saveOptions.push(options);
      return realSave.call(this, options);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fills the real form loaded Fast and saved in one go, empty answers included", async () => {
    const result = await fillFormOnDevice(REAL_BYTES(), deviceState({}));

    // The options, exactly as review-fill.ts passes them — the load must
    // carry parseSpeed Fast (the default Slow ticks per ~100 objects) and
    // the save objectsPerTick Infinity (the default 50 per tick).
    expect(loadOptions).toEqual([{ parseSpeed: ParseSpeeds.Fast }]);
    expect(saveOptions).toEqual([{ objectsPerTick: Infinity }]);
    expect(result.kind).toBe("filled");
  });

  it("parses Fast and saves in one go for any answers — and the fill still reads back", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.integer({ min: 1, max: 15 }), { nil: undefined }),
        fc.option(fc.constant("1990-01-01"), { nil: undefined }),
        fc.constantFrom("shelter", "rental_or_own"),
        async (householdSize, dateOfBirth, housingStatus) => {
          const answers: Record<string, { status: "known"; value: unknown }> = {
            housing_status: { status: "known", value: housingStatus },
          };
          if (householdSize !== undefined) {
            answers.household_size = { status: "known", value: householdSize };
          }
          if (dateOfBirth !== undefined) {
            answers.date_of_birth = { status: "known", value: dateOfBirth };
          }

          // THE INVARIANT: one load, with Fast; one save, in one go —
          // whatever the answers. A regression to the defaults fails here
          // before a throttled tab ever does. The captures are cleared
          // per run: the read-back load below passes no options of its
          // own and must never be mistaken for the fill's.
          loadOptions.length = 0;
          saveOptions.length = 0;
          const result = await fillFormOnDevice(SAMPLE_BYTES(), deviceState(answers), {}, SAMPLE_ENTRY);
          expect(loadOptions).toEqual([{ parseSpeed: ParseSpeeds.Fast }]);
          expect(saveOptions).toEqual([{ objectsPerTick: Infinity }]);
          if (result.kind !== "filled") {
            throw new Error(`expected a fill, got ${result.kind}`);
          }

          // And the speed options changed nothing else: the answers still
          // fill and read back (the private date of birth through the
          // device's own vault view, as always).
          const pdf = await PDFDocument.load(result.outcome.bytes);
          const form = pdf.getForm();
          if (householdSize !== undefined) {
            expect(form.getTextField("household_size_count").getText()).toBe(
              String(householdSize),
            );
          } else {
            expect(form.getTextField("household_size_count").getText() ?? "").toBe("");
          }
          if (dateOfBirth !== undefined) {
            expect(form.getTextField("applicant_date_of_birth").getText()).toBe(dateOfBirth);
          } else {
            expect(form.getTextField("applicant_date_of_birth").getText() ?? "").toBe("");
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
