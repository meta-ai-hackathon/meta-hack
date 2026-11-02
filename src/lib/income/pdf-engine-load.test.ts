import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// The deployed-lambda failure behind this file (VAL-SPRINT-004, the Nov 2
// prod-parity run): the 1040 upload 500s on production while every local
// mode parses the same bytes fine. Root cause, proven by materializing the
// built lambda from its .vc-config.json filePathMap: pdfjs-dist is a
// serverExternalPackages entry, so Turbopack externalizes it into
// .next/node_modules/pdfjs-dist-<hash>/ and rewrites the import into the
// externals chunk — and that copied tree does not survive the lambda
// packaging, so the engine module load itself fails at runtime
// (PdfEnvironmentError → the route's honest internal 500). Local modes
// never see this: dev/next start/vitest all resolve the real node_modules.
//
// The repaired contract has two halves, both pinned here:
//
// 1. BUNDLED, not externalized: the engine and its worker ship inside the
//    server chunk, so no node_modules path or Turbopack copy directory
//    needs to exist in the deployed lambda.
// 2. The worker hook: with the engine bundled, pdf.js's own fake-worker
//    setup would `import("./pdf.worker.mjs")` module-relatively — the
//    original dev-mode failure (VAL-INC-007/010/012). pdf.js 6.4.x consults
//    `globalThis.pdfjsWorker` FIRST and skips that import when it is set,
//    so the loader must install the worker module there, once, from a
//    statically traceable literal specifier.

const WORKER_HOOK = "pdfjsWorker";

interface PdfJsWorkerHook {
  WorkerMessageHandler?: unknown;
}

function globalHook(): PdfJsWorkerHook | undefined {
  return (globalThis as Record<string, unknown>)[WORKER_HOOK] as
    | PdfJsWorkerHook
    | undefined;
}

describe("the PDF engine's deployed-runtime load contract", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("bundles the engine for the server: pdfjs-dist is not externalized", async () => {
    // Imported as a module (not regex over the file text) so the pin is
    // about the resolved config object, not its comment prose.
    const config = (await import("../../../next.config")).default;
    expect(config.serverExternalPackages ?? []).not.toContain("pdfjs-dist");
  });

  it("installs pdf.js's main-thread worker hook before any content verdict", async () => {
    // A fresh module graph per test run: the engine loader memoizes its
    // single load in module scope, and this file owns that lifecycle here.
    vi.resetModules();
    expect(globalHook()).toBeUndefined();

    const { parse1040Pdf } = await import("./tax-parse");
    const bytes = new Uint8Array(
      readFileSync(new URL("./fixtures/f1040.pdf", import.meta.url)),
    );
    const result = await parse1040Pdf(bytes);

    // The parse ran to a content verdict (the pinned fixture identifies as
    // a readable 1040) — and the hook must be installed regardless of what
    // the bytes were: the hook's job is engine availability, not findings.
    expect(result.readable).toBe(true);
    const hook = globalHook();
    expect(hook).toBeDefined();
    // pdf.js 6.4.x reads exactly this member off the global (version-pinned
    // surface — see PDFWorker.#mainThreadWorkerMessageHandler).
    expect(
      typeof (hook as { WorkerMessageHandler?: unknown }).WorkerMessageHandler,
    ).not.toBe("undefined");
  });

  it("loads the engine exactly once: repeated parses share one hook reference", async () => {
    vi.resetModules();
    const { parse1040Pdf } = await import("./tax-parse");
    const bytes = new Uint8Array(
      readFileSync(new URL("./fixtures/f1040.pdf", import.meta.url)),
    );
    await parse1040Pdf(bytes);
    const first = globalHook();
    await parse1040Pdf(bytes);
    expect(globalHook()).toBe(first);
  });
});
