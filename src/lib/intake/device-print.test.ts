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
// worker hook and the built-ins pdf.js needs in place first, a pdf.js that
// stops answering given up on, and nothing kept when anything goes wrong.

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

/** A point where the fake pdf.js stops answering. */
type Stall =
  | { readonly at: "open" | "destroy" }
  | { readonly at: "page" | "render"; readonly pageNumber: number };

/** A promise that never settles: pdf.js that has stopped answering. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function stallsAt(at: Stall["at"], pageNumber?: number): boolean {
  const { stall } = engine;
  return stall !== null && stall.at === at && (!("pageNumber" in stall) || stall.pageNumber === pageNumber);
}

/** Whether the built-ins pdf.js 6.4.x calls without bringing are there right now. */
function builtinsNow() {
  return {
    withResolvers: typeof Promise.withResolvers === "function",
    transferToFixedLength: typeof ArrayBuffer.prototype.transferToFixedLength === "function",
  };
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
  /**
   * Where pdf.js stops answering, if anywhere: opening the document,
   * getting or drawing a page (by number), or tearing the document down.
   * What stops answering never settles, unless it is cancelled.
   */
  stall: null as Stall | null,
  /** Called while a page draws, after its render task is handed back. */
  whileRendering: null as ((pageNumber: number) => void) | null,
  /** Whether each built-in pdf.js needs was there when its modules loaded. */
  builtinsAtLoad: [] as { module: "engine" | "worker"; withResolvers: boolean; transferToFixedLength: boolean }[],
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
      // A page takes a moment to draw, as in pdf.js, and may be cancelled
      // meanwhile. A stalled page never finishes on its own.
      setTimeout(() => {
        if (stallsAt("render", pageNumber)) {
          return;
        }
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
        getPage(pageNumber: number) {
          engine.pagesRequested.push(pageNumber);
          return stallsAt("page", pageNumber)
            ? never<ReturnType<typeof fakePage>>()
            : Promise.resolve(fakePage(pageNumber, pages[pageNumber - 1]));
        },
      };
      return {
        promise: stallsAt("open") ? never<typeof document>() : Promise.resolve(document),
        destroy() {
          record.destroyed += 1;
          return stallsAt("destroy") ? never<void>() : Promise.resolve();
        },
      };
    },
  };
}

/** Put the fake pdf.js, and its worker module, where the print module imports them. */
function mockEngine(): void {
  vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => {
    engine.loads += 1;
    engine.builtinsAtLoad.push({ module: "engine", ...builtinsNow() });
    if (engine.failLoad) {
      throw engine.failLoad;
    }
    return fakeEngine();
  });
  vi.doMock("pdfjs-dist/legacy/build/pdf.worker.mjs", () => {
    engine.workerLoads += 1;
    engine.builtinsAtLoad.push({ module: "worker", ...builtinsNow() });
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
  engine.stall = null;
  engine.whileRendering = null;
  engine.builtinsAtLoad = [];
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

/**
 * A drawing run on a fake clock, so how busy the machine is can't move the
 * watchdog. Every task due now runs, round after round, until nothing but
 * the watchdog is left waiting (or nothing at all, once the drawing is
 * done), and only then does the clock move on by `ms`. pdf.js must already
 * be loaded: loading it isn't timed, and it doesn't run on this clock.
 */
async function drawOnFakeClock(
  draw: () => Promise<DevicePrint.PrintPreview>,
  ms: number,
): Promise<{ readonly preview: DevicePrint.PrintPreview | null; readonly failure: unknown }> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const outcome = draw().then(
      (preview) => ({ preview, failure: null }),
      (failure: unknown) => ({ preview: null, failure }),
    );
    for (let round = 0; round < 100; round += 1) {
      await vi.advanceTimersByTimeAsync(0);
      if (vi.getTimerCount() <= 1) {
        break;
      }
    }
    await vi.advanceTimersByTimeAsync(ms);
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

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

  it("gives up on a pdf.js that stops answering, wherever it stops, and keeps nothing", async () => {
    // A browser missing something pdf.js needs can leave it waiting
    // forever (one without transferToFixedLength never finishes a page).
    // The watchdog turns that into a failure, so the person isn't left
    // waiting on a button that never comes back.
    const { renderPrintPreview } = await freshModule();
    // pdf.js loads first, on the real clock.
    await renderPrintPreview(new Uint8Array([1]), canvasMaker().make);
    const stallArb = pageOfArb.chain(([count, page]) =>
      fc.tuple(
        fc.constant(count),
        fc.constantFrom<Stall>({ at: "open" }, { at: "page", pageNumber: page }, { at: "render", pageNumber: page }),
      ),
    );
    await fc.assert(
      fc.asyncProperty(stallArb, async ([count, stall]) => {
        resetEngine(Array.from({ length: count }, () => LETTER));
        engine.stall = stall;
        const canvases = canvasMaker();
        const { failure } = await drawOnFakeClock(
          () => renderPrintPreview(new Uint8Array([1]), canvases.make, undefined, 20),
          20,
        );
        expect((failure as DOMException | null)?.name).toBe("TimeoutError");
        // Every page started was drawn up to the stall, and nothing after it.
        const stalledPage = "pageNumber" in stall ? stall.pageNumber : 0;
        expect(engine.pagesRequested).toEqual(Array.from({ length: stalledPage }, (_, index) => index + 1));
        expect(canvases.made).toHaveLength(stall.at === "render" ? stalledPage : Math.max(0, stalledPage - 1));
        expectReleased(canvases.made);
        // The stuck page was told to stop, and the document was torn down.
        expect(engine.renders.map((render) => render.cancelled)).toEqual(
          canvases.made.map((_, index) => (stall.at === "render" && index + 1 === stalledPage ? 1 : 0)),
        );
        expect(engine.documents[0].destroyed).toBe(1);
      }),
      { numRuns: 30 },
    );
  });

  it("hands back the drawn pages when only the teardown stops answering", async () => {
    const { renderPrintPreview } = await freshModule();
    await renderPrintPreview(new Uint8Array([1]), canvasMaker().make);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (count) => {
        resetEngine(Array.from({ length: count }, () => LETTER));
        engine.stall = { at: "destroy" };
        const canvases = canvasMaker();
        const { preview, failure } = await drawOnFakeClock(
          () => renderPrintPreview(new Uint8Array([1]), canvases.make, undefined, 20),
          20,
        );
        expect(failure).toBeNull();
        if (preview === null) {
          throw new Error("no pages");
        }
        expect(preview.pages).toHaveLength(count);
        expect(engine.documents[0].destroyed).toBe(1);
        for (const canvas of canvases.made) {
          expect(canvas.removed).toBe(0);
        }
        preview.release();
        expectReleased(canvases.made);
      }),
      { numRuns: 10 },
    );
  });

  it("never fails or touches a drawing that finishes in time, even once its time is up", async () => {
    const { DRAW_TIMEOUT_MS, renderPrintPreview } = await freshModule();
    // A minute, many times what the DHB-5200 takes on a slow phone.
    expect(DRAW_TIMEOUT_MS).toBe(60_000);
    await renderPrintPreview(new Uint8Array([1]), canvasMaker().make);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (count) => {
        resetEngine(Array.from({ length: count }, () => LETTER));
        const canvases = canvasMaker();
        // Past the watchdog's time, the pages are still whole: it stopped
        // when the drawing finished.
        const { preview, failure } = await drawOnFakeClock(
          () => renderPrintPreview(new Uint8Array([1]), canvases.make, undefined, 250),
          300,
        );
        expect(failure).toBeNull();
        expect(preview?.pages).toHaveLength(count);
        expect(canvases.made.every((canvas) => canvas.width > 0 && canvas.removed === 0)).toBe(true);
        expect(engine.renders.every((render) => render.cancelled === 0)).toBe(true);
      }),
      { numRuns: 3 },
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

describe("the built-ins pdf.js needs", () => {
  // pdf.js 6.4.x calls Promise.withResolvers and
  // ArrayBuffer.prototype.transferToFixedLength without bringing them, and
  // Safari before 17.4 has neither. Node has both, so these tests take them
  // away the way such a browser would, and put the real ones back after.
  const REAL = {
    withResolvers: Object.getOwnPropertyDescriptor(Promise, "withResolvers")!,
    transferToFixedLength: Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "transferToFixedLength")!,
  };

  async function inOlderBrowser<T>(body: () => Promise<T>): Promise<T> {
    delete (Promise as { withResolvers?: unknown }).withResolvers;
    delete (ArrayBuffer.prototype as { transferToFixedLength?: unknown }).transferToFixedLength;
    try {
      return await body();
    } finally {
      Object.defineProperty(Promise, "withResolvers", REAL.withResolvers);
      Object.defineProperty(ArrayBuffer.prototype, "transferToFixedLength", REAL.transferToFixedLength);
    }
  }

  /** The stand-ins the print module installs, taken from a browser without the real ones. */
  async function standIns() {
    return inOlderBrowser(async () => {
      const { installMissingBuiltins } = await freshModule();
      expect(builtinsNow()).toEqual({ withResolvers: false, transferToFixedLength: false });
      installMissingBuiltins();
      return {
        withResolvers: Object.getOwnPropertyDescriptor(Promise, "withResolvers")!,
        transferToFixedLength: Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "transferToFixedLength")!,
      };
    });
  }

  it("puts both in place before either pdf.js module loads, in a browser without them", async () => {
    await inOlderBrowser(async () => {
      const { renderPrintPreview } = await freshModule();
      const preview = await renderPrintPreview(new Uint8Array([1]), canvasMaker().make);
      expect(preview.pages).toHaveLength(1);
      expect(engine.builtinsAtLoad).toEqual([
        { module: "engine", withResolvers: true, transferToFixedLength: true },
        { module: "worker", withResolvers: true, transferToFixedLength: true },
      ]);
    });
  });

  it("defines them the way built-in methods are, so nothing that lists a promise's or a buffer's keys meets them", async () => {
    const installed = await standIns();
    for (const descriptor of [installed.withResolvers, installed.transferToFixedLength]) {
      expect(descriptor).toMatchObject({ writable: true, enumerable: false, configurable: true });
      expect(typeof descriptor.value).toBe("function");
    }
  });

  it("leaves a browser's own built-ins alone", async () => {
    const { installMissingBuiltins, renderPrintPreview } = await freshModule();
    installMissingBuiltins();
    await renderPrintPreview(new Uint8Array([1]), canvasMaker().make);
    expect(Promise.withResolvers).toBe(REAL.withResolvers.value);
    expect(ArrayBuffer.prototype.transferToFixedLength).toBe(REAL.transferToFixedLength.value);
  });

  it("settles a promise exactly as Promise.withResolvers does, however it is settled", async () => {
    const { withResolvers: standIn } = await standIns();
    const steps = fc.array(fc.record({ settle: fc.constantFrom("resolve", "reject"), value: fc.anything() }), {
      minLength: 1,
      maxLength: 4,
    });
    async function outcome(make: () => PromiseWithResolvers<unknown>, settles: readonly { settle: "resolve" | "reject"; value: unknown }[]) {
      const deferred = make();
      for (const { settle, value } of settles) {
        deferred[settle](value);
      }
      return deferred.promise.then(
        (value) => ({ settled: "resolved", value }),
        (value: unknown) => ({ settled: "rejected", value }),
      );
    }
    await fc.assert(
      fc.asyncProperty(steps, async (settles) => {
        const real = await outcome(() => REAL.withResolvers.value.call(Promise), settles);
        const filled = await outcome(() => standIn.value.call(Promise), settles);
        expect(filled.settled).toBe(real.settled);
        expect(Object.is(filled.value, real.value)).toBe(true);
      }),
    );
  });

  it("gives the same new buffer as transferToFixedLength, for any buffer and length", async () => {
    const { transferToFixedLength: standIn } = await standIns();
    const lengthArb = fc.oneof(
      fc.constant(undefined),
      fc.integer({ min: 0, max: 96 }),
      fc.double({ min: 0, max: 96, noNaN: true }),
      fc.constant(Number.NaN),
    );
    await fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), fc.boolean(), lengthArb, (bytes, resizable, newLength) => {
        const source = () => {
          const buffer = resizable
            ? new ArrayBuffer(bytes.length, { maxByteLength: bytes.length + 16 })
            : new ArrayBuffer(bytes.length);
          new Uint8Array(buffer).set(bytes);
          return buffer;
        };
        const real = (REAL.transferToFixedLength.value as ArrayBuffer["transferToFixedLength"]).call(source(), newLength);
        const original = source();
        const filled = (standIn.value as ArrayBuffer["transferToFixedLength"]).call(original, newLength);
        expect(filled.byteLength).toBe(real.byteLength);
        expect(filled.resizable).toBe(false);
        expect([...new Uint8Array(filled)]).toEqual([...new Uint8Array(real)]);
        expect(filled).not.toBe(original);
        // A copy: the original is still readable, which pdf.js never needs
        // but doesn't mind.
        expect([...new Uint8Array(original)]).toEqual([...bytes]);
      }),
    );
  });

  it("refuses what transferToFixedLength refuses: a negative length, a detached buffer, or no buffer", async () => {
    const { transferToFixedLength: standIn } = await standIns();
    const transfer = standIn.value as (this: unknown, newLength?: number) => ArrayBuffer;
    await fc.assert(
      fc.property(fc.uint8Array({ maxLength: 16 }), fc.integer({ min: -64, max: -1 }), (bytes, negative) => {
        const buffer = new Uint8Array(bytes).buffer;
        expect(() => transfer.call(buffer, negative)).toThrow(RangeError);
        expect(() => REAL.transferToFixedLength.value.call(buffer, negative)).toThrow(RangeError);
        structuredClone(buffer, { transfer: [buffer] });
        expect(() => transfer.call(buffer)).toThrow(TypeError);
        expect(() => REAL.transferToFixedLength.value.call(buffer)).toThrow(TypeError);
      }),
    );
    expect(() => transfer.call(new Uint8Array(4))).toThrow(TypeError);
    expect(() => transfer.call({ byteLength: 4 })).toThrow(TypeError);
  });
});

describe("the print size", () => {
  // Sizes from a sliver to the largest page PDF allows (200 inches).
  const anySizeArb = fc.record({
    width: fc.double({ min: 1, max: 14_400, noNaN: true }),
    height: fc.double({ min: 1, max: 14_400, noNaN: true }),
  });

  it("never passes the budget's DPI, its page or form pixel budget, or the longest canvas side, full or small", async () => {
    const {
      FULL_PRINT_BUDGET,
      MAX_CANVAS_SIDE,
      MAX_PAGE_PIXELS,
      MAX_TOTAL_PIXELS,
      PRINT_DPI,
      SMALL_DEVICE_PRINT_BUDGET,
      canvasSize,
      printScale,
    } = await freshModule();
    expect(FULL_PRINT_BUDGET).toEqual({ dpi: PRINT_DPI, pagePixels: MAX_PAGE_PIXELS, totalPixels: MAX_TOTAL_PIXELS });
    fc.assert(
      fc.property(
        fc.array(anySizeArb, { minLength: 1, maxLength: 60 }),
        fc.constantFrom(FULL_PRINT_BUDGET, SMALL_DEVICE_PRINT_BUDGET),
        (sizes, budget) => {
          const count = sizes.length;
          let total = 0;
          for (const size of sizes) {
            const scale = printScale(size, count, budget);
            expect(scale).toBeGreaterThan(0);
            expect(scale).toBeLessThanOrEqual(budget.dpi / 72);
            const canvas = canvasSize({ width: size.width * scale, height: size.height * scale });
            expect(Number.isInteger(canvas.width) && Number.isInteger(canvas.height)).toBe(true);
            expect(Math.min(canvas.width, canvas.height)).toBeGreaterThanOrEqual(1);
            expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(MAX_CANVAS_SIDE);
            expect(canvas.width * canvas.height).toBeLessThanOrEqual(
              Math.min(budget.pagePixels, budget.totalPixels / count),
            );
            total += canvas.width * canvas.height;
          }
          expect(total).toBeLessThanOrEqual(budget.totalPixels);
          // With no budget given, the scale is the full budget's.
          expect(printScale(sizes[0], count)).toBe(printScale(sizes[0], count, FULL_PRINT_BUDGET));
        },
      ),
    );
  });

  it("draws Letter pages at exactly the budget's DPI for any form whose pages fit the budget at that size", async () => {
    const { FULL_PRINT_BUDGET, PRINT_DPI, SMALL_DEVICE_PRINT_BUDGET, SMALL_DEVICE_PRINT_DPI, canvasSize, printScale } =
      await freshModule();
    expect(SMALL_DEVICE_PRINT_BUDGET.dpi).toBe(SMALL_DEVICE_PRINT_DPI);
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.constantFrom(FULL_PRINT_BUDGET, SMALL_DEVICE_PRINT_BUDGET),
        (count, budget) => {
          const sharpest = budget.dpi / 72;
          const atDpi = canvasSize({ width: LETTER.width * sharpest, height: LETTER.height * sharpest });
          const scale = printScale(LETTER, count, budget);
          const canvas = canvasSize({ width: LETTER.width * scale, height: LETTER.height * scale });
          if (count * atDpi.width * atDpi.height <= budget.totalPixels) {
            expect(scale).toBe(sharpest);
            expect(canvas).toEqual(atDpi);
          } else {
            expect(scale).toBeLessThan(sharpest);
            expect(count * canvas.width * canvas.height).toBeLessThanOrEqual(budget.totalPixels);
          }
        },
      ),
    );
    // A Letter page at 150 DPI.
    expect(canvasSize({ width: LETTER.width * (PRINT_DPI / 72), height: LETTER.height * (PRINT_DPI / 72) })).toEqual({
      width: 1275,
      height: 1650,
    });
    // The DHB-5200's 21 pages print at full resolution on a device with memory to spare.
    expect(printScale(LETTER, 21)).toBe(PRINT_DPI / 72);
  });

  it("keeps the DHB-5200's pages well under 100 MB of canvas memory on a small device, still sharp enough to read", async () => {
    // iOS Safari caps the memory all of a page's canvases may use, and the
    // full budget's 48 million pixels, about 190 MB, comes near that cap.
    const { SMALL_DEVICE_PRINT_BUDGET, canvasSize, printScale } = await freshModule();
    const scale = printScale(LETTER, 21, SMALL_DEVICE_PRINT_BUDGET);
    const canvas = canvasSize({ width: LETTER.width * scale, height: LETTER.height * scale });
    const bytes = 21 * canvas.width * canvas.height * 4;
    expect(bytes).toBeLessThanOrEqual(90_000_000);
    // About 106 DPI: small print still reads on paper.
    expect(scale * 72).toBeGreaterThanOrEqual(105);
    expect(scale * 72).toBeLessThanOrEqual(SMALL_DEVICE_PRINT_BUDGET.dpi);
  });
});

describe("the device the pages are drawn for", () => {
  const IPHONE_SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
  const IPHONE_CHROME =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1";
  const OLD_IPAD = "Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const IPOD = "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  /** What Safari on a Mac says, and what an iPad's Safari has said since iPadOS 13. */
  const MAC_SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
  const ANDROID_CHROME =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
  const WINDOWS_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";
  const LINUX_CHROME =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  /** What navigator.deviceMemory may be: what Chromium says, nothing, or something unusable. */
  const memoryArb = fc.oneof(
    fc.constantFrom(0.25, 0.5, 1, 2, 4, 8),
    fc.constantFrom(undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 0, -2, "8"),
  );

  const deviceArb = fc.record({
    memoryGb: fc.option(fc.constantFrom(0.25, 0.5, 1, 2, 4, 8, 16), { nil: undefined }),
    appleMobile: fc.boolean(),
  });

  it("is an iPhone, iPad, or iPod whatever the browser there says, and an iPad that says it is a Mac by its touch screen", async () => {
    const { printDeviceOf } = await freshModule();
    fc.assert(
      fc.property(
        fc.constantFrom(IPHONE_SAFARI, IPHONE_CHROME, OLD_IPAD, IPOD, MAC_SAFARI, ANDROID_CHROME, WINDOWS_FIREFOX, LINUX_CHROME),
        fc.option(fc.integer({ min: 0, max: 10 }), { nil: undefined }),
        memoryArb,
        (userAgent, maxTouchPoints, deviceMemory) => {
          const device = printDeviceOf({ userAgent, maxTouchPoints, deviceMemory });
          const apple = [IPHONE_SAFARI, IPHONE_CHROME, OLD_IPAD, IPOD].includes(userAgent);
          const touchMac = userAgent === MAC_SAFARI && (maxTouchPoints ?? 0) > 1;
          expect(device.appleMobile).toBe(apple || touchMac);
          const usable = typeof deviceMemory === "number" && Number.isFinite(deviceMemory) && deviceMemory > 0;
          expect(device.memoryGb).toBe(usable ? deviceMemory : undefined);
        },
      ),
    );
    // No navigator at all: a device with memory to spare.
    expect(printDeviceOf(undefined)).toEqual({ memoryGb: undefined, appleMobile: false });
  });

  it("gets the small budget when it is an iPhone, iPad, or iPod, or says it has 4 GB of memory or less", async () => {
    const { FULL_PRINT_BUDGET, SMALL_DEVICE_MEMORY_GB, SMALL_DEVICE_PRINT_BUDGET, printBudgetFor } = await freshModule();
    expect(SMALL_DEVICE_MEMORY_GB).toBe(4);
    fc.assert(
      fc.property(deviceArb, (device) => {
        const small = device.appleMobile || (device.memoryGb !== undefined && device.memoryGb <= 4);
        expect(printBudgetFor(device)).toBe(small ? SMALL_DEVICE_PRINT_BUDGET : FULL_PRINT_BUDGET);
      }),
    );
  });

  it("draws the pages at the print size of the device it's given", async () => {
    const { canvasSize, printBudgetFor, printScale, renderPrintPreview } = await freshModule();
    await fc.assert(
      fc.asyncProperty(pagesArb, deviceArb, async (pages, device) => {
        resetEngine(pages);
        const canvases = canvasMaker();
        await renderPrintPreview(new Uint8Array([1]), canvases.make, undefined, undefined, device);
        pages.forEach((size, index) => {
          const scale = printScale(size, pages.length, printBudgetFor(device));
          const expected = canvasSize({ width: size.width * scale, height: size.height * scale });
          expect({ width: canvases.made[index].width, height: canvases.made[index].height }).toEqual(expected);
          expect((engine.renders[index].params.viewport as { scale: number }).scale).toBe(scale);
        });
      }),
      { numRuns: 30 },
    );
  });

  it("is this browser's own when none is given: smaller pages on an iPhone, full ones on a desktop", async () => {
    const { FULL_PRINT_BUDGET, SMALL_DEVICE_PRINT_BUDGET, canvasSize, printScale, renderPrintPreview } =
      await freshModule();
    const letterAt = (budget: DevicePrint.PrintBudget) => {
      const scale = printScale(LETTER, 21, budget);
      return canvasSize({ width: LETTER.width * scale, height: LETTER.height * scale });
    };
    const drawn = async (browser: Readonly<Record<string, unknown>>) => {
      vi.stubGlobal("navigator", browser);
      try {
        resetEngine(Array.from({ length: 21 }, () => LETTER));
        const canvases = canvasMaker();
        await renderPrintPreview(new Uint8Array([1]), canvases.make);
        return canvases.made.map((canvas) => ({ width: canvas.width, height: canvas.height }));
      } finally {
        vi.unstubAllGlobals();
      }
    };
    const phone = await drawn({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5 });
    expect(new Set(phone.map((size) => `${size.width}x${size.height}`))).toEqual(
      new Set([`${letterAt(SMALL_DEVICE_PRINT_BUDGET).width}x${letterAt(SMALL_DEVICE_PRINT_BUDGET).height}`]),
    );
    const desktop = await drawn({ userAgent: LINUX_CHROME, maxTouchPoints: 0, deviceMemory: 8 });
    expect(desktop).toEqual(Array.from({ length: 21 }, () => letterAt(FULL_PRINT_BUDGET)));
    expect(letterAt(FULL_PRINT_BUDGET)).toEqual({ width: 1275, height: 1650 });
    expect(phone[0].width).toBeLessThan(desktop[0].width);
  });
});
