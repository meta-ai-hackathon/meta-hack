import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseFormPdf } from "./parse";
import { getFormRegistryEntry } from "./registry";
import { setLogSink } from "../telemetry";

// LIVE parse check (Mission v2 M4): the LLM-assisted mapping loop against
// the committed sample form with the real model. Skipped unless
// MODEL_API_KEY is present, so CI without the key stays green — the same
// contract the other *.live.test.ts files follow. The scripted-transport
// suite (parse.test.ts) covers the deterministic behavior.

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");

describe.skipIf(!process.env.MODEL_API_KEY)("live parse (key-gated)", () => {
  beforeAll(() => {
    setLogSink(() => undefined);
  });

  it(
    "maps the committed sample form through the live model",
    { timeout: 120_000 },
    async () => {
      const bytes = new Uint8Array(
        readFileSync(path.join(FIXTURES, "sample-form-acroform.pdf")),
      );
      const parsed = await parseFormPdf(bytes);
      const entry = getFormRegistryEntry("sample-application-form");
      // Every field comes back mapped to a question, one per field.
      expect(parsed.mapping.map((item) => item.fieldName).sort()).toEqual(
        entry.fields.map((field) => field.name).sort(),
      );
      for (const item of parsed.mapping) {
        expect(item.question.length).toBeGreaterThan(3);
        // specQuestionId is null or a real spec id — the parser never
        // trusts an invented id (validated against the committed spec).
        expect([
          null,
          ...entry.fields
            .filter((field) => field.specQuestionId !== null)
            .map((field) => field.specQuestionId),
        ]).toContain(item.specQuestionId);
      }
      // The live model should confidently re-find at least the strongly
      // labeled mappings (the date-of-birth label is verbatim on the form).
      const dob = parsed.mapping.find(
        (item) => item.fieldName === "applicant_date_of_birth",
      );
      expect(dob?.specQuestionId).toBe("date_of_birth");
      expect(dob?.piiLikely).toBe(true);
    },
  );
});
