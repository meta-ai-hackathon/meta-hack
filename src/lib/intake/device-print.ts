import type * as PdfJs from "pdfjs-dist/legacy/build/pdf.mjs";

// Drawing the filled application for printing, in the browser (HACK-115).
//
// The step-by-step page fills the official form in memory (device-fill.ts)
// and hands the filled bytes here. This draws each page onto a canvas with
// pdf.js, so the person can check the form on screen and print it to sign
// and send in. Paper is the one way the filled form leaves the page: the
// owner decided on HACK-115 (Nov 3) to replace the download, which saved
// every answer to the device as an unencrypted file, with this print
// preview. So nothing here saves anything. The pages are canvases in the
// page's memory, never a file, a Blob or object URL, a frame or embed
// showing the PDF (Android Chrome turns a PDF frame into a download, and
// desktop PDF viewers offer one), or anything in the browser's storage,
// and whoever shows them releases them as soon as they stop showing them.
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
 * The most pixels all of a form's pages may hold together, about 190 MB of
 * canvas memory. The DHB-5200's 21 Letter pages come to about 44 million
 * at 150 DPI, so a much longer form draws at a lower resolution rather
 * than exhaust a phone's memory.
 */
export const MAX_TOTAL_PIXELS = 48_000_000;

/** The longest side a page's canvas may have, within every browser's limit. */
export const MAX_CANVAS_SIDE = 8_192;

/**
 * The scale one page is drawn at, from its size at scale 1 and how many
 * pages the form has: 150 DPI unless that would break one of the limits
 * above, in which case the largest scale that keeps to all of them.
 */
export function printScale(size: PageSize, pageCount: number): number {
  const pixelBudget = Math.min(MAX_PAGE_PIXELS, MAX_TOTAL_PIXELS / pageCount);
  return Math.min(
    PRINT_DPI / POINTS_PER_INCH,
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

let engineLoad: Promise<PdfJsEngine> | null = null;

/**
 * pdf.js, loaded once, with its worker hook installed before anything can
 * open a document. A load that fails (a dropped connection while the chunk
 * downloads, say) is not kept, so the next try loads it again.
 */
function loadEngine(): Promise<PdfJsEngine> {
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
 * Draw every page of the filled form onto its own canvas, in order. The
 * bytes are the person's filled application, read here and never kept:
 * pdf.js gets a copy, and the loading task, and the document with it, is
 * destroyed before this returns, whatever happens.
 *
 * Rejects when pdf.js can't load or can't draw the form, and when `signal`
 * aborts (the answers changed, or the page closed). Either way it releases
 * whatever it drew first, so only a full set of pages is ever handed back.
 */
export async function renderPrintPreview(
  bytes: Uint8Array,
  createCanvas: PrintCanvasFactory,
  signal?: AbortSignal,
): Promise<PrintPreview> {
  const engine = await loadEngine();
  signal?.throwIfAborted();
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
    const pdf = await task.promise;
    const pageCount = pdf.numPages;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: printScale(page.getViewport({ scale: 1 }), pageCount) });
      const size = canvasSize(viewport);
      const canvas = createCanvas(size.width, size.height);
      pages.push({ pageNumber, pageCount, label: printPageLabel(pageNumber, pageCount), canvas });
      // The print intent draws what a printer gets: every field the form
      // marks for printing, in the appearance pdf-lib wrote for its answer
      // (the default annotation mode draws those), without the form's own
      // on-screen Print Form button.
      const render = page.render({ canvas, viewport, intent: "print" });
      const cancel = () => render.cancel();
      signal?.addEventListener("abort", cancel);
      try {
        await render.promise;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
      page.cleanup();
      await nextTask();
    }
    signal?.throwIfAborted();
  } catch (error) {
    releasePages(pages);
    throw error;
  } finally {
    // Destroying the loading task destroys the document with it (pdf.js
    // 6.4.x has no separate destroy on the document). A failure to tear
    // down can't hide the pages or the error above.
    await task.destroy().catch(() => undefined);
  }
  return { pages, release: () => releasePages(pages) };
}
