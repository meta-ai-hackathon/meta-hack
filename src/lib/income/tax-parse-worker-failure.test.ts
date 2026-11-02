import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse1040Pdf, PdfEnvironmentError } from "./tax-parse";

// The live failure mode behind VAL-INC-007/010/012: pdf.js's fake-worker
// setup (Node has no DOM worker) does a runtime import of its sibling
// pdf.worker.mjs; under the Turbopack route bundle that import resolved
// against .next/dev/server/chunks/ and rejected the loading task with
// pdf.js's "Setting up fake worker failed: ..." — which the identity
// try/catch then swallowed into readable:false for good bytes. This file
// simulates exactly that rejection and pins the repaired contract: a
// worker-setup failure is ENGINE breakage (PdfEnvironmentError), never an
// honest-unreadable verdict about the document. (The next.config.ts
// serverExternalPackages entry is what makes the real worker resolve;
// this test pins the classifier so any recurrence is loud.)

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: () => ({
    promise: Promise.reject(
      new Error(
        'Setting up fake worker failed: "Cannot find module ' +
          "'.../.next/dev/server/chunks/pdf.worker.mjs'\".",
      ),
    ),
    destroy: () => Promise.resolve(),
  }),
}));

const FIXTURE_URL = new URL("./fixtures/f1040.pdf", import.meta.url);

describe("engine worker-setup failure (never masquerades as unreadable)", () => {
  it("surfaces a fake-worker setup failure as PdfEnvironmentError, not readable:false", async () => {
    const bytes = new Uint8Array(readFileSync(FIXTURE_URL));
    let outcome: "no-error" | "environment" | "other" = "no-error";
    try {
      const result = await parse1040Pdf(bytes);
      // The exact live bug: a resolved readable:false verdict for bytes
      // the engine never got to read. ANY resolved result here is the
      // failure under test.
      outcome = "other";
      void result;
    } catch (error) {
      outcome = error instanceof PdfEnvironmentError ? "environment" : "other";
    }
    expect(outcome).toBe("environment");
  });
});
