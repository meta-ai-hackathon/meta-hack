import type * as PdfJs from "pdfjs-dist/legacy/build/pdf.mjs";

// Drawing the filled application for printing, in the browser (HACK-115).
//
// The step-by-step page fills the official form in memory (device-fill.ts)
// and hands the filled bytes here. This draws each page onto a canvas with
// pdf.js, so the person can check the form on screen and print it to sign
// and send in. Nothing here saves anything: the person's own downloaded
// copy goes only through device-download.ts, when they press Download a
// copy. The pages are canvases in the page's memory, never a file, a Blob
// or object URL, a frame or embed showing the PDF (Android Chrome turns a
// PDF frame into a download, and desktop PDF viewers offer one), or
// anything in the browser's storage, and whoever shows them releases them
// as soon as they stop showing them. They are drawn at about 150 DPI, and
// at about 110 DPI within a smaller pixel budget on a phone or tablet with
// little memory and on every iPhone and iPad, whose Safari caps the memory
// all of a page's canvases may use (printBudgetFor).
//
// The page loads this module only on demand, and this module loads pdf.js
// only on demand, from literal paths the device path's boundary check can
// read (device-path-boundary.test.ts), so the questions never wait on
// either. pdf.js runs on the page's own thread: importing its worker module
// installs globalThis.pdfjsWorker, which pdf.js 6.4.x consults before it
// would start a Worker, so it never starts one and never requests a worker
// script (tax-parse.ts uses the same hook on the server). It gets the
// filled bytes directly and none of the locations it would request files
// from: no worker source, standard fonts, CMaps, ICC profiles, or wasm. A
// font the form doesn't embed is drawn with the system's own.
//
// pdf.js 6.4.x also calls two built-ins without bringing its own copies:
// Promise.withResolvers, new in Safari 17.4 and Chrome 119, and
// ArrayBuffer.prototype.transferToFixedLength, new in Safari 17.4 and
// Chrome 114. Next.js builds this page for Safari 16.4 and Chrome 111 and
// up. Without the first, pdf.js throws on every document, and without the
// second it draws nothing and never finishes, so the engine load fills in
// whichever is missing first. A browser's own versions are left alone. And
// because a pdf.js that stops answering would otherwise leave the person
// waiting forever, the drawing gives up after DRAW_TIMEOUT_MS and fails
// the way any other failure does.

/** The pdf.js module, as this file uses it. */
type PdfJsEngine = typeof PdfJs;

/** What pdf.js takes to open a document. */
type DocumentOptions = NonNullable<Parameters<PdfJsEngine["getDocument"]>[0]>;

/** A page's size: in PDF points at scale 1, or in pixels at a print scale. */
export interface PageSize {
  readonly width: number;
  readonly height: number;
}

/** Makes the canvas one page is drawn on, at its size in whole pixels. */
export type PrintCanvasFactory = (width: number, height: number) => HTMLCanvasElement;

/** One page of the filled form, drawn for printing. */
export interface PrintPage {
  /** Counted from 1, in the form's order. */
  readonly pageNumber: number;
  readonly pageCount: number;
  /** What a screen reader says for the page. */
  readonly label: string;
  readonly canvas: HTMLCanvasElement;
}

/** The filled form's pages, and the way to let go of them. */
export interface PrintPreview {
  readonly pages: readonly PrintPage[];
  /**
   * Shrink every canvas to nothing and take it off the page. A canvas at
   * zero size frees its pixels at once, where a dropped one waits for the
   * browser to collect it. Safe to call more than once.
   */
  readonly release: () => void;
}

/** About 150 dots per inch: small print stays legible on paper. */
export const PRINT_DPI = 150;

/** PDF points per inch. */
const POINTS_PER_INCH = 72;

/**
 * The most pixels one page's canvas may hold. A US Letter page at 150 DPI
 * is about 2.1 million, so a larger page draws at a lower resolution
 * instead of growing one canvas past what a phone handles well.
 */
export const MAX_PAGE_PIXELS = 2_500_000;

/**
 * The most pixels all of a form's pages may hold together on a device with
 * memory to spare, about 190 MB of canvas memory. The DHB-5200's 21 Letter
 * pages come to about 44 million at 150 DPI, so a much longer form draws at
 * a lower resolution rather than exhaust the device's memory.
 */
export const MAX_TOTAL_PIXELS = 48_000_000;

/**
 * About 110 dots per inch on a small device (see printBudgetFor): the
 * form's small print still reads on paper.
 */
export const SMALL_DEVICE_PRINT_DPI = 110;

/**
 * The most pixels all of a form's pages may hold together on a small
 * device, about 88 MB of canvas memory. iOS Safari caps the memory all of
 * a page's canvases may use, and 190 MB comes near that cap on many
 * iPhones, so a small device stays well under 100 MB. The DHB-5200's 21
 * Letter pages come to about 23.8 million at 110 DPI, so on a small device
 * they draw at about 106 DPI.
 */
export const SMALL_DEVICE_MAX_TOTAL_PIXELS = 22_000_000;

/** The longest side a page's canvas may have, within every browser's limit. */
export const MAX_CANVAS_SIDE = 8_192;

/** How sharp a device draws the pages, and how many pixels their canvases may hold. */
export interface PrintBudget {
  /** The sharpest the pages are drawn, in dots per inch. */
  readonly dpi: number;
  /** The most pixels one page's canvas may hold. */
  readonly pagePixels: number;
  /** The most pixels all of a form's pages may hold together. */
  readonly totalPixels: number;
}

/** A device with memory to spare. */
export const FULL_PRINT_BUDGET: PrintBudget = {
  dpi: PRINT_DPI,
  pagePixels: MAX_PAGE_PIXELS,
  totalPixels: MAX_TOTAL_PIXELS,
};

/** A phone or tablet with little memory, and every iPhone and iPad. */
export const SMALL_DEVICE_PRINT_BUDGET: PrintBudget = {
  dpi: SMALL_DEVICE_PRINT_DPI,
  pagePixels: MAX_PAGE_PIXELS,
  totalPixels: SMALL_DEVICE_MAX_TOTAL_PIXELS,
};

/** What the print size needs to know about the device it draws on. */
export interface PrintDevice {
  /**
   * The device's memory in gigabytes, as navigator.deviceMemory gives it
   * (Chromium browsers say 0.25, 0.5, 1, 2, 4, or 8), or undefined where
   * the browser doesn't say.
   */
  readonly memoryGb: number | undefined;
  /** Whether the device is an iPhone, iPad, or iPod, whose Safari caps canvas memory. */
  readonly appleMobile: boolean;
}

/** A device with at most this much memory, in gigabytes, is a small device. */
export const SMALL_DEVICE_MEMORY_GB = 4;

/**
 * How sharp `device` draws the pages: a small device, one that says it has
 * at most SMALL_DEVICE_MEMORY_GB of memory or is an iPhone, iPad, or iPod
 * (whose browsers don't say), gets the small budget, and every other the
 * full one.
 */
export function printBudgetFor(device: PrintDevice): PrintBudget {
  const small =
    device.appleMobile || (device.memoryGb !== undefined && device.memoryGb <= SMALL_DEVICE_MEMORY_GB);
  return small ? SMALL_DEVICE_PRINT_BUDGET : FULL_PRINT_BUDGET;
}

/** The parts of a browser's navigator the print size reads. */
export interface DeviceNavigator {
  readonly userAgent: string;
  readonly maxTouchPoints?: number;
  readonly deviceMemory?: unknown;
}

/**
 * A device, from what its browser says. An iPhone or iPod says so in its
 * user agent, as an iPad did before iPadOS 13. Since then an iPad's Safari
 * says it is a Mac, so a Mac with a touch screen is taken for an iPad. Every
 * browser on iOS and iPadOS draws with WebKit, so this holds for Chrome and
 * Firefox there too. With no navigator at all, the device is taken to have
 * memory to spare.
 */
export function printDeviceOf(browser: DeviceNavigator | undefined): PrintDevice {
  if (browser === undefined) {
    return { memoryGb: undefined, appleMobile: false };
  }
  const memory = browser.deviceMemory;
  const touchMac = /\bMacintosh\b/.test(browser.userAgent) && (browser.maxTouchPoints ?? 0) > 1;
  return {
    memoryGb: typeof memory === "number" && Number.isFinite(memory) && memory > 0 ? memory : undefined,
    appleMobile: /\b(?:iPhone|iPad|iPod)\b/.test(browser.userAgent) || touchMac,
  };
}

/** This browser's device. */
function currentPrintDevice(): PrintDevice {
  return printDeviceOf(typeof navigator === "undefined" ? undefined : navigator);
}

/**
 * How long pdf.js may take to open and draw the whole form, once it has
 * loaded. The DHB-5200 takes a few seconds even on a slow phone, so a
 * drawing still running after this has stopped answering, and it fails.
 */
export const DRAW_TIMEOUT_MS = 60_000;

/**
 * The scale one page is drawn at, from its size at scale 1, how many pages
 * the form has, and the device's budget: the budget's DPI unless that
 * would break one of its pixel limits or the longest canvas side, in which
 * case the largest scale that keeps to all of them.
 */
export function printScale(size: PageSize, pageCount: number, budget: PrintBudget = FULL_PRINT_BUDGET): number {
  const pixelBudget = Math.min(budget.pagePixels, budget.totalPixels / pageCount);
  return Math.min(
    budget.dpi / POINTS_PER_INCH,
    Math.sqrt(pixelBudget / (size.width * size.height)),
    MAX_CANVAS_SIDE / Math.max(size.width, size.height),
  );
}

/** A canvas's size for a page drawn at its print scale, in whole pixels. */
export function canvasSize(viewport: PageSize): PageSize {
  return {
    width: Math.max(1, Math.floor(viewport.width)),
    height: Math.max(1, Math.floor(viewport.height)),
  };
}

/** The screen reader label for one page of the filled form. */
export function printPageLabel(pageNumber: number, pageCount: number): string {
  return `Page ${pageNumber} of ${pageCount}, filled application`;
}

function releasePages(pages: readonly PrintPage[]): void {
  for (const { canvas } of pages) {
    canvas.width = 0;
    canvas.height = 0;
    canvas.remove();
  }
}

/** Promise.withResolvers, for a browser without it: a promise and the two functions that settle it. */
function withResolvers<T>(): PromiseWithResolvers<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * ArrayBuffer.prototype.transferToFixedLength, for a browser without it: a
 * new fixed-length buffer of `newLength` bytes (this buffer's length when
 * left out) holding as much of this buffer as fits, and zeros after. It
 * copies instead of moving, so this buffer stays as it was, which is all
 * pdf.js needs: it only reads the new buffer.
 */
function transferToFixedLength(this: ArrayBuffer, newLength?: number): ArrayBuffer {
  if (!(this instanceof ArrayBuffer)) {
    throw new TypeError("transferToFixedLength needs an ArrayBuffer");
  }
  const moved = new ArrayBuffer(newLength === undefined ? this.byteLength : newLength);
  new Uint8Array(moved).set(new Uint8Array(this, 0, Math.min(moved.byteLength, this.byteLength)));
  return moved;
}

/**
 * Fill in the built-ins pdf.js 6.4.x calls but doesn't bring, where the
 * browser lacks them (see the top of this file). Each goes where the
 * browser's own would be, defined the way built-in methods are, and only
 * when missing, so a browser that has them keeps its own.
 */
export function installMissingBuiltins(): void {
  const define = (target: object, name: string, value: unknown) =>
    Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  if (typeof Promise.withResolvers !== "function") {
    define(Promise, "withResolvers", withResolvers);
  }
  if (typeof ArrayBuffer.prototype.transferToFixedLength !== "function") {
    define(ArrayBuffer.prototype, "transferToFixedLength", transferToFixedLength);
  }
}

let engineLoad: Promise<PdfJsEngine> | null = null;

/**
 * pdf.js, loaded once, with the built-ins it needs and its worker hook in
 * place before anything can open a document. A load that fails (a dropped
 * connection while the chunk downloads, say) is not kept, so the next try
 * loads it again.
 */
function loadEngine(): Promise<PdfJsEngine> {
  installMissingBuiltins();
  engineLoad ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    // Imported for what it does when it loads: it sets
    // globalThis.pdfjsWorker, so pdf.js runs here instead of in a Worker.
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]).then(
    ([engine]) => engine,
    (error: unknown) => {
      engineLoad = null;
      throw error;
    },
  );
  return engineLoad;
}

/** Wait for the browser's next task, so the page can paint and take input between pages. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * `promise`, unless `stop` aborts first, in which case this rejects with
 * the reason at once. Whatever `promise` was doing is left to finish or
 * fail on its own.
 */
function unlessStopped<T>(promise: Promise<T>, stop: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stopped = () => reject(stop.reason);
    if (stop.aborted) {
      stopped();
      return;
    }
    stop.addEventListener("abort", stopped, { once: true });
    promise.then(
      (value) => {
        stop.removeEventListener("abort", stopped);
        resolve(value);
      },
      (error: unknown) => {
        stop.removeEventListener("abort", stopped);
        reject(error);
      },
    );
  });
}

/**
 * Draw every page of the filled form onto its own canvas, in order. The
 * bytes are the person's filled application, read here and never kept:
 * pdf.js gets a copy, and the loading task, and the document with it, is
 * destroyed whatever happens. This waits for that teardown unless the
 * drawing was stopped, so a stuck pdf.js can't hold it up.
 *
 * The pages are drawn at the print scale for `device`, this browser's
 * unless another is given, so a phone or tablet with little memory draws
 * them at a lower resolution (printBudgetFor).
 *
 * Rejects when pdf.js can't load or can't draw the form, when `signal`
 * aborts (the answers changed, or the page closed), and when pdf.js hasn't
 * finished `timeoutMs` after it loaded (a TimeoutError). Either way it
 * releases whatever it drew first, so only a full set of pages is ever
 * handed back.
 */
export async function renderPrintPreview(
  bytes: Uint8Array,
  createCanvas: PrintCanvasFactory,
  signal?: AbortSignal,
  timeoutMs: number = DRAW_TIMEOUT_MS,
  device: PrintDevice = currentPrintDevice(),
): Promise<PrintPreview> {
  const budget = printBudgetFor(device);
  const engine = await loadEngine();
  signal?.throwIfAborted();
  // One switch for everything that stops the drawing: the caller, or the
  // watchdog. AbortSignal.any would do this, but the browsers that need
  // the built-ins above don't have it either.
  const stop = new AbortController();
  const stopForCaller = () => stop.abort(signal?.reason);
  signal?.addEventListener("abort", stopForCaller, { once: true });
  const watchdog = setTimeout(
    () => stop.abort(new DOMException("pdf.js stopped answering while drawing the form", "TimeoutError")),
    timeoutMs,
  );
  const options: DocumentOptions & { readonly isEvalSupported: false } = {
    // A copy: pdf.js takes over the buffer it is given.
    data: new Uint8Array(bytes),
    // pdf.js 6.4.x never compiles code from a document and ignores this,
    // but a version that still reads it must not use eval either.
    isEvalSupported: false,
  };
  const task = engine.getDocument(options);
  const pages: PrintPage[] = [];
  try {
    const pdf = await unlessStopped(task.promise, stop.signal);
    const pageCount = pdf.numPages;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      stop.signal.throwIfAborted();
      const page = await unlessStopped(pdf.getPage(pageNumber), stop.signal);
      const viewport = page.getViewport({ scale: printScale(page.getViewport({ scale: 1 }), pageCount, budget) });
      const size = canvasSize(viewport);
      const canvas = createCanvas(size.width, size.height);
      pages.push({ pageNumber, pageCount, label: printPageLabel(pageNumber, pageCount), canvas });
      // The print intent draws what a printer gets: every field the form
      // marks for printing, in the appearance pdf-lib wrote for its answer
      // (the default annotation mode draws those). The form's interactive
      // Print Form button has no print flag, so it isn't drawn, but the
      // DHB-5200 also has a gray "Print Form" box in page 1's own content,
      // so that box still shows on the preview and on paper.
      const render = page.render({ canvas, viewport, intent: "print" });
      const cancel = () => render.cancel();
      stop.signal.addEventListener("abort", cancel, { once: true });
      try {
        await unlessStopped(render.promise, stop.signal);
      } finally {
        stop.signal.removeEventListener("abort", cancel);
      }
      page.cleanup();
      await nextTask();
    }
    stop.signal.throwIfAborted();
  } catch (error) {
    releasePages(pages);
    throw error;
  } finally {
    // Destroying the loading task destroys the document with it (pdf.js
    // 6.4.x has no separate destroy on the document). A failure to tear
    // down can't hide the pages or the error above, and the watchdog keeps
    // running until the teardown is done, so a teardown that never ends
    // can't hold this up either.
    await unlessStopped(task.destroy(), stop.signal).catch(() => undefined);
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", stopForCaller);
  }
  return { pages, release: () => releasePages(pages) };
}
