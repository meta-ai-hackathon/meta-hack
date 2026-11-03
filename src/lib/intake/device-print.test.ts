import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DevicePrint from "./device-print";

// The print preview's drawing step (HACK-115), with pdf.js replaced by a
// fake that records what it is asked and draws nothing. The fake follows
// pdf.js 6.4.x's surface: getDocument returns a loading task whose promise
// gives the document, pages give viewports scaled from their size, render
// returns a task with a promise and cancel, and only the loading task has
// a destroy. device-print.ts types its calls against the real module, so
// the compiler holds that surface to the real one; this file holds the
// behavior: every page drawn once, in order, at its print size and label,
// from a copy of the bytes with nothing that makes pdf.js fetch, with the
// worker hook in place first, and nothing kept when anything goes wrong.

interface FakeCanvas {
  width: number;
  height: number;
  removed: number;
  remove(): void;
}

interface RenderCall {
  readonly pageNumber: number;
  readonly params: Readonly<Record<string, unknown>>;
  cancelled: number;
}

/** What the fake pdf.js is set to do, and what it was asked. */
const engine = {
  /** What importing pdf.js, or its worker, throws, if anything. */
  failLoad: null as Error | null,
  failWorkerLoad: null as Error | null,
  loads: 0,
  workerLoads: 0,
  /** The worker module's export, which its load puts on globalThis.pdfjsWorker. */
  handler: { name: "WorkerMessageHandler" },
  globalWorkerOptions: { workerSrc: "", workerPort: null as unknown },
  /** The document's pages, by their size at scale 1. */
  pages: [] as { width: number; height: number }[],
  /** A page whose drawing fails, by number. */
  failRenderAt: null as number | null,
  /** Called while a page draws, after its render task is handed back. */
  whileRendering: null as ((pageNumber: number) => void) | null,
  documents: [] as {
    options: Readonly<Record<string, unknown>>;
    workerHook: unknown;
    destroyed: number;
  }[],
  pagesRequested: [] as number[],
  renders: [] as RenderCall[],
  cleanups: [] as number[],
};

/** One page of the fake document. */
function fakePage(pageNumber: number, size: { readonly width: number; readonly height: number }) {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: size.width * scale,
      height: size.height * scale,
      scale,
    }),
    render(params: Readonly<Record<string, unknown>>) {
      const call: RenderCall = { pageNumber, params, cancelled: 0 };
      engine.renders.push(call);
      const drawn = Promise.withResolvers<void>();
      // A page takes a moment to draw, as in pdf.js, and may be cancelled meanwhile.
      setTimeout(() => {
        if (engine.failRenderAt === pageNumber) {
          drawn.reject(new Error(`page ${pageNumber} failed to draw`));
        } else {
          drawn.resolve();
        }
      }, 0);
      queueMicrotask(() => engine.whileRendering?.(pageNumber));
      return {
        promise: drawn.promise,
        cancel() {
          call.cancelled += 1;
          drawn.reject(new Error(`Rendering cancelled, page ${pageNumber}`));
        },
      };
    },
    cleanup() {
      engine.cleanups.push(pageNumber);
      return true;
    },
  };
}

/** The fake pdf.js module. */
function fakeEngine() {
  return {
    GlobalWorkerOptions: engine.globalWorkerOptions,
    getDocument(options: Readonly<Record<string, unknown>>) {
      const record = {
        options,
        workerHook: (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker,
        destroyed: 0,
      };
      engine.documents.push(record);
      // pdf.js takes over the buffer it is given: detach it, as the
      // transfer to its worker does.
      const data = options.data as Uint8Array;
      structuredClone(data, { transfer: [data.buffer] });
      const pages = [...engine.pages];
      const document = {
        numPages: pages.length,
        async getPage(pageNumber: number) {
          engine.pagesRequested.push(pageNumber);
          return fakePage(pageNumber, pages[pageNumber - 1]);
        },
      };
      return {
        promise: Promise.resolve(document),
        async destroy() {
          record.destroyed += 1;
        },
      };
    },
  };
}

/** Put the fake pdf.js, and its worker module, where the print module imports them. */
function mockEngine(): void {
  vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => {
    engine.loads += 1;
    if (engine.failLoad) {
      throw engine.failLoad;
    }
    return fakeEngine();
  });
  vi.doMock("pdfjs-dist/legacy/build/pdf.worker.mjs", () => {
    engine.workerLoads += 1;
    if (engine.failWorkerLoad) {
      throw engine.failWorkerLoad;
    }
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler: engine.handler };
    return { WorkerMessageHandler: engine.handler };
  });
}

/**
 * A fresh copy of the print module, so each test starts with pdf.js not yet
 * loaded, and a fresh fake pdf.js for it to load. Vitest keeps a mocked
 * module once it has loaded, so the fakes are registered again each time.
 */
async function freshModule(): Promise<typeof DevicePrint> {
  vi.resetModules();
  mockEngine();
  return import("./device-print");
}

function resetEngine(pages: readonly { width: number; height: number }[] = [LETTER]): void {
  engine.failLoad = null;
  engine.failWorkerLoad = null;
  engine.loads = 0;
  engine.workerLoads = 0;
  engine.globalWorkerOptions.workerSrc = "";
  engine.globalWorkerOptions.workerPort = null;
  engine.pages = [...pages];
  engine.failRenderAt = null;
  engine.whileRendering = null;
  engine.documents = [];
  engine.pagesRequested = [];
  engine.renders = [];
  engine.cleanups = [];
  delete (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker;
}

/** A canvas maker that keeps every canvas it makes, so a test can see what became of each. */
function canvasMaker(): { readonly made: FakeCanvas[]; readonly make: DevicePrint.PrintCanvasFactory } {
  const made: FakeCanvas[] = [];
  return {
    made,
    make: (width, height) => {
      const canvas: FakeCanvas = {
        width,
        height,
        removed: 0,
        remove() {
          this.removed += 1;
        },
      };
      made.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    },
  };
}

function expectReleased(canvases: readonly FakeCanvas[]): void {
  for (const canvas of canvases) {
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(canvas.removed).toBeGreaterThan(0);
  }
}

/** US Letter, in points: the DHB-5200's page size. */
const LETTER = { width: 612, height: 792 };

/** Page sizes from a business card to a large drawing, in points. */
const pageSizeArb = fc.record({
  width: fc.integer({ min: 100, max: 2_000 }),
  height: fc.integer({ min: 100, max: 2_000 }),
});

const pagesArb = fc.array(pageSizeArb, { minLength: 1, maxLength: 8 });

const bytesArb = fc.uint8Array({ minLength: 1, maxLength: 64 });

beforeEach(() => {
  resetEngine();
});

describe("drawing the filled form for printing", () => {
  it("draws every page once, in order, at its print size, with its label", async () => {
    const { canvasSize, printPageLabel, printScale, renderPrintPreview } = await freshModule();
    await fc.assert(
      fc.asyncProperty(pagesArb, bytesArb, async (pages, bytes) => {
        resetEngine(pages);
        const canvases = canvasMaker();
        const preview = await renderPrintPreview(bytes, canvases.make);

        const count = pages.length;
        expect(preview.pages.map((page) => page.pageNumber)).toEqual(pages.map((_, index) => index + 1));
        expect(engine.pagesRequested).toEqual(pages.map((_, index) => index + 1));
        expect(engine.renders.map((render) => render.pageNumber)).toEqual(pages.map((_, index) => index + 1));
        pages.forEach((size, index) => {
          const page = preview.pages[index];
          const scale = printScale(size, count);
          const expected = canvasSize({ width: size.width * scale, height: size.height * scale });
          expect(page.pageCount).toBe(count);
          expect(page.label).toBe(printPageLabel(index + 1, count));
          expect(page.canvas).toBe(canvases.made[index]);
          expect({ width: page.canvas.width, height: page.canvas.height }).toEqual(expected);
          // Drawn onto that canvas, at that scale, as it prints. No
          // annotation mode is passed, so pdf.js's default draws the
          // field appearances pdf-lib wrote.
          const { params } = engine.renders[index];
          expect(Object.keys(params).sort()).toEqual(["canvas", "intent", "viewport"]);
          expect(params.canvas).toBe(page.canvas);
          expect(params.intent).toBe("print");
          expect((params.viewport as { scale: number }).scale).toBe(scale);
        });
        expect(canvases.made).toHaveLength(count);
        expect(engine.cleanups).toEqual(pages.map((_, index) => index + 1));
        // One document, and its loading task destroyed once the pages are drawn.
        expect(engine.documents).toHaveLength(1);
        expect(engine.documents[0].destroyed).toBe(1);
        for (const canvas of canvases.made) {
          expect(canvas.removed).toBe(0);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("hands pdf.js a copy of the bytes and nothing that makes it fetch", async () => {
    const { renderPrintPreview } = await freshModule();
    await fc.assert(
      fc.asyncProperty(bytesArb, async (bytes) => {
        resetEngine();
        const before = [...bytes];
        await renderPrintPreview(bytes, canvasMaker().make);
        const { options } = engine.documents[0];
        // The data and the eval switch only: no url, worker, worker port,
        // or standard font, CMap, ICC, or wasm location.
        expect(Object.keys(options).sort()).toEqual(["data", "isEvalSupported"]);
        expect(options.isEvalSupported).toBe(false);
        expect(Object.is(options.data, bytes)).toBe(false);
        // pdf.js took its copy over, and the caller's bytes are as they were.
        expect((options.data as Uint8Array).byteLength).toBe(0);
        expect([...bytes]).toEqual(before);
      }),
      { numRuns: 30 },
    );
  });

  it("puts pdf.js's worker hook in place before it opens the document, and no worker script", async () => {
    const { renderPrintPreview } = await freshModule();
    expect((globalThis as { pdfjsWorker?: unknown }).pdfjsWorker).toBeUndefined();
    await renderPrintPreview(new Uint8Array([1, 2, 3]), canvasMaker().make);
    expect(engine.workerLoads).toBe(1);
    // pdf.js 6.4.x reads exactly this member off the hook, and with it set
    // runs on the page's thread instead of starting a Worker.
    expect(engine.documents[0].workerHook).toEqual({ WorkerMessageHandler: engine.handler });
    expect(engine.globalWorkerOptions).toEqual({ workerSrc: "", workerPort: null });
  });

  it("labels each page with its number and the page count, every label different", async () => {
    const { printPageLabel } = await freshModule();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 300 }), (count) => {
        const labels = Array.from({ length: count }, (_, index) => printPageLabel(index + 1, count));
        expect(new Set(labels).size).toBe(count);
        labels.forEach((label, index) => {
          const parsed = /^Page (\d+) of (\d+), filled application$/.exec(label);
          expect(parsed?.slice(1).map(Number)).toEqual([index + 1, count]);
        });
      }),
    );
  });

  it("lets go of every canvas on release, as often as it is asked", async () => {
    const { renderPrintPreview } = await freshModule();
    await fc.assert(
      fc.asyncProperty(pagesArb, fc.integer({ min: 1, max: 3 }), async (pages, releases) => {
        resetEngine(pages);
        const canvases = canvasMaker();
        const preview = await renderPrintPreview(new Uint8Array([7]), canvases.make);
        for (let index = 0; index < releases; index += 1) {
          preview.release();
        }
        expectReleased(canvases.made);
      }),
      { numRuns: 20 },
    );
  });
});

describe("when the drawing can't finish", () => {
  /** A page count and one of its pages. */
  const pageOfArb = fc
    .integer({ min: 1, max: 8 })
    .chain((count) => fc.tuple(fc.constant(count), fc.integer({ min: 1, max: count })));

  it("releases what it drew and destroys the document when a page fails to draw", async () => {
    const { renderPrintPreview } = await freshModule();
    await fc.assert(
      fc.asyncProperty(pageOfArb, async ([count, failing]) => {
        resetEngine(Array.from({ length: count }, () => LETTER));
        engine.failRenderAt = failing;
        const canvases = canvasMaker();
        await expect(renderPrintPreview(new Uint8Array([1]), canvases.make)).rejects.toThrow(
          `page ${failing} failed to draw`,
        );
        expect(canvases.made).toHaveLength(failing);
        expectReleased(canvases.made);
        expect(engine.pagesRequested).toEqual(Array.from({ length: failing }, (_, index) => index + 1));
        expect(engine.documents[0].destroyed).toBe(1);
      }),
      { numRuns: 30 },
    );
  });

  it("stops the page it is drawing, releases the rest, and destroys the document when aborted", async () => {
    const { renderPrintPreview } = await freshModule();
    await fc.assert(
      fc.asyncProperty(pageOfArb, async ([count, abortAt]) => {
        resetEngine(Array.from({ length: count }, () => LETTER));
        const controller = new AbortController();
        engine.whileRendering = (pageNumber) => {
          if (pageNumber === abortAt) {
            controller.abort();
          }
        };
        const canvases = canvasMaker();
        await expect(
          renderPrintPreview(new Uint8Array([1]), canvases.make, controller.signal),
        ).rejects.toThrow();
        // The page being drawn was told to stop, and no later page was started.
        expect(engine.renders.map((render) => render.cancelled)).toEqual(
          Array.from({ length: abortAt }, (_, index) => (index + 1 === abortAt ? 1 : 0)),
        );
        expect(canvases.made).toHaveLength(abortAt);
        expectReleased(canvases.made);
        expect(engine.documents[0].destroyed).toBe(1);
      }),
      { numRuns: 30 },
    );
  });

  it("opens nothing when it is aborted before it starts", async () => {
    const { renderPrintPreview } = await freshModule();
    const canvases = canvasMaker();
    await expect(
      renderPrintPreview(new Uint8Array([1]), canvases.make, AbortSignal.abort()),
    ).rejects.toThrow();
    expect(engine.documents).toEqual([]);
    expect(canvases.made).toEqual([]);
  });

  it.each(["engine", "worker"] as const)(
    "rejects without drawing when pdf.js's %s won't load, and loads it again on the next try",
    async (failing) => {
      const { renderPrintPreview } = await freshModule();
      const error = new TypeError(`Failed to fetch dynamically imported module (${failing})`);
      if (failing === "engine") {
        engine.failLoad = error;
      } else {
        engine.failWorkerLoad = error;
      }
      const canvases = canvasMaker();
      const failure = await renderPrintPreview(new Uint8Array([1]), canvases.make).then(
        () => null,
        (reason: unknown) => reason,
      );
      // Vitest wraps what a mocked import throws, with the import's own error as the cause.
      expect(failure).toBeInstanceOf(Error);
      expect(String((failure as Error).cause ?? failure)).toContain(error.message);
      expect(canvases.made).toEqual([]);
      expect(engine.documents).toEqual([]);

      // A dropped connection isn't kept: the next try loads it again and draws.
      engine.failLoad = null;
      engine.failWorkerLoad = null;
      const preview = await renderPrintPreview(new Uint8Array([1]), canvasMaker().make);
      expect(failing === "engine" ? engine.loads : engine.workerLoads).toBe(2);
      expect(preview.pages).toHaveLength(1);
      expect(engine.documents).toHaveLength(1);
    },
  );
});

describe("the print size", () => {
  // Sizes from a sliver to the largest page PDF allows (200 inches).
  const anySizeArb = fc.record({
    width: fc.double({ min: 1, max: 14_400, noNaN: true }),
    height: fc.double({ min: 1, max: 14_400, noNaN: true }),
  });

  it("never passes 150 DPI, a page's pixel budget, the form's, or the longest canvas side", async () => {
    const { MAX_CANVAS_SIDE, MAX_PAGE_PIXELS, MAX_TOTAL_PIXELS, PRINT_DPI, canvasSize, printScale } =
      await freshModule();
    fc.assert(
      fc.property(fc.array(anySizeArb, { minLength: 1, maxLength: 60 }), (sizes) => {
        const count = sizes.length;
        let total = 0;
        for (const size of sizes) {
          const scale = printScale(size, count);
          expect(scale).toBeGreaterThan(0);
          expect(scale).toBeLessThanOrEqual(PRINT_DPI / 72);
          const canvas = canvasSize({ width: size.width * scale, height: size.height * scale });
          expect(Number.isInteger(canvas.width) && Number.isInteger(canvas.height)).toBe(true);
          expect(Math.min(canvas.width, canvas.height)).toBeGreaterThanOrEqual(1);
          expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
          expect(canvas.width * canvas.height).toBeLessThanOrEqual(
            Math.min(MAX_PAGE_PIXELS, MAX_TOTAL_PIXELS / count),
          );
          total += canvas.width * canvas.height;
        }
        expect(total).toBeLessThanOrEqual(MAX_TOTAL_PIXELS);
      }),
    );
  });

  it("draws Letter pages at exactly 150 DPI for any form whose pages fit the budget at that size", async () => {
    const { MAX_TOTAL_PIXELS, PRINT_DPI, canvasSize, printScale } = await freshModule();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 60 }), (count) => {
        const scale = printScale(LETTER, count);
        const canvas = canvasSize({ width: LETTER.width * scale, height: LETTER.height * scale });
        if (count * 1275 * 1650 <= MAX_TOTAL_PIXELS) {
          expect(scale).toBe(PRINT_DPI / 72);
          expect(canvas).toEqual({ width: 1275, height: 1650 });
        } else {
          expect(scale).toBeLessThan(PRINT_DPI / 72);
          expect(count * canvas.width * canvas.height).toBeLessThanOrEqual(MAX_TOTAL_PIXELS);
        }
      }),
    );
    // The DHB-5200's 21 pages print at full resolution.
    expect(printScale(LETTER, 21)).toBe(PRINT_DPI / 72);
  });
});
