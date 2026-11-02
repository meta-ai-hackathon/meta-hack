import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  isPdfEnvironmentFailure,
  PDFJS_FAKE_WORKER_FAILURE_PREFIX,
  parse1040Pdf,
  PdfEnvironmentError,
} from "./tax-parse";

// Engine-layer failure contract (the VAL-INC-007/010/012 live repair):
// failing to LOAD the PDF engine is bundler/runtime breakage and must
// surface as a distinct PdfEnvironmentError — NEVER as the honest-
// unreadable verdict (readable:false), which is reserved for genuine
// content findings about the bytes. This file simulates the module itself
// failing to resolve (the Turbopack route-bundle failure mode); the
// worker-chunk failure mode lives in tax-parse-worker-failure.test.ts.

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => {
  throw new TypeError(
    "Cannot find module 'pdfjs-dist/legacy/build/pdf.mjs' (simulated bundler breakage)",
  );
});

const FIXTURE_URL = new URL("./fixtures/f1040.pdf", import.meta.url);

describe("engine module-load failure (never masquerades as unreadable)", () => {
  it("surfaces a module-load failure as PdfEnvironmentError, not readable:false", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE_URL));
    let outcome: "no-error" | "environment" | "other" = "no-error";
    try {
      const result = await parse1040Pdf(bytes);
      // The old bug: the swallow produced an honest-looking unreadable
      // verdict for perfectly good bytes. ANY resolved result here is the
      // failure under test.
      outcome = "other";
      void result;
    } catch (error) {
      outcome = error instanceof PdfEnvironmentError ? "environment" : "other";
    }
    expect(outcome).toBe("environment");
  });

  it("property: the engine-failure classifier is total and exact", () => {
    // Four disjoint construction classes; the predicate must decide each
    // one exactly — never a false engine error for content failures
    // (those stay honest unreadable verdicts), never a miss for the
    // version-pinned pdf.js worker-failure signature.
    const prefixed = fc
      .string({ maxLength: 120 })
      .map(
        (reason) =>
          `${PDFJS_FAKE_WORKER_FAILURE_PREFIX}: "${reason}".` as string,
      );
    const nearMiss = fc
      .string({ minLength: 0, maxLength: 60 })
      .map(
        (tail) =>
          `x${PDFJS_FAKE_WORKER_FAILURE_PREFIX.slice(1)}${tail}` as string,
      );
    const nonError = fc.oneof(
      fc.integer(),
      fc.double(),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
    );
    fc.assert(
      fc.property(
        fc.oneof(
          prefixed.map((message) => new Error(message)),
          nearMiss.map((message) => new Error(message)),
          fc.string({ maxLength: 200 }).map((message) => new Error(message)),
          nonError,
          fc.string({ maxLength: 80 }).map((message) => new PdfEnvironmentError(message)),
        ),
        (error) => {
          const expected =
            error instanceof PdfEnvironmentError ||
            (error instanceof Error &&
              error.message.startsWith(PDFJS_FAKE_WORKER_FAILURE_PREFIX));
          expect(isPdfEnvironmentFailure(error)).toBe(expected);
        },
      ),
    );
  });
});
