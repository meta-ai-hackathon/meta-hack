// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { PDFDocument } from "@cantoo/pdf-lib";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The step-by-step page to the end (HACK-115), driven through the DOM: a
// person answers every question, sees the match and the review of the
// filled form, types the answers the questions don't ask, and shows the
// filled DHB-5200 on the page to print it or download a copy. Everything is
// computed in the browser. The only requests the page makes are the
// cookie-only check for answers saved on the server before
// (server-answers-notice.tsx) and the GET for the blank form, and no request
// URL or body carries an answer. Nothing is saved to the device but the
// copy the person downloads, only when they press Download a copy: no
// object URL or download before that, nothing that embeds the PDF, and
// nothing new in the browser's storage. The copy is the very form the pages
// show, its URL is revoked a moment after the press, and the bytes kept for
// it are wiped whenever the pages go. A reload resumes from IndexedDB,
// straight back to the review, and the form fills again from the answers
// kept on the device. The print rules in globals.css are matched against
// the page as it renders, so only the filled pages go on paper, and leaving
// the page, by any route, takes them off the screen.
//
// pdf.js itself is a stand-in here (jsdom has no canvas): it reads the page
// count and sizes of the bytes it is given with pdf-lib, records them, and
// draws nothing. The real print module runs around it, so the test sees the
// filled bytes exactly as pdf.js would get them, the canvases the page
// makes, and what becomes of them. device-print.test.ts covers the drawing.

type Handler = ((event: unknown) => void) | null;

/** A small IndexedDB stand-in that follows the event contract (see device-kv.test.ts). */
function fakeIndexedDb() {
  const stores = new Map<string, Map<string, unknown>>();
  let version = 0;
  function handle() {
    const db: Record<string, unknown> = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: (name: string) => stores.set(name, new Map()),
      close: () => undefined,
      transaction: (name: string) => {
        const store = stores.get(name)!;
        const transaction: Record<string, unknown> & { oncomplete: Handler } = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: null,
          abort: () => undefined,
        };
        let pending = 0;
        let finished = false;
        const settle = () =>
          queueMicrotask(() => {
            if (pending === 0 && !finished) {
              finished = true;
              transaction.oncomplete?.({});
            }
          });
        const request = (operation: () => unknown) => {
          const req: Record<string, unknown> & { onsuccess: Handler } = { result: undefined, onsuccess: null };
          pending += 1;
          queueMicrotask(() => {
            req.result = operation();
            req.onsuccess?.({});
            pending -= 1;
            settle();
          });
          return req;
        };
        transaction.objectStore = () => ({
          get: (key: string) => request(() => structuredClone(store.get(key))),
          put: (value: unknown, key: string) => request(() => store.set(key, structuredClone(value))),
          delete: (key: string) => request(() => store.delete(key)),
        });
        return transaction;
      },
    };
    return db;
  }
  const factory = {
    open: (_name: string, wanted = 1) => {
      const request: Record<string, unknown> & { onsuccess: Handler; onupgradeneeded: Handler } = {
        result: undefined,
        onsuccess: null,
        onupgradeneeded: null,
        onerror: null,
        onblocked: null,
      };
      queueMicrotask(() => {
        request.result = handle();
        if (wanted > version) {
          version = wanted;
          request.onupgradeneeded?.({});
        }
        request.onsuccess?.({});
      });
      return request;
    },
  };
  return { factory, stores };
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const BLANK_FORM = new Uint8Array(readFileSync(path.join(REPO_ROOT, "public/forms/dhb-5200.pdf")));

/**
 * A synthetic person (no real data): a self-employed applicant in North
 * Carolina who also left a job, reached by phone. Questions not listed
 * here are answered "I'm not sure".
 */
const PERSONA: Readonly<Record<string, unknown>> = {
  application_role: "self",
  main_goal: "healthcare",
  state: "NC",
  county: "Quillfeather County",
  household_size: "2",
  household_children: "0",
  household_seniors: "0",
  income_sources: ["job", "self_employed"],
  income_kind: "both",
  self_employment_statements_offer: "will_type",
  prior_employer_current: "no_longer_there",
  prior_employer_last_month: "Larkspur Diner LLC",
  job_income_amount: "1200",
  job_income_frequency: "monthly",
  housing_status: "staying_with_others",
  id_status: "have_id",
  date_of_birth: "1984-07-19",
  citizenship_status: "us_citizen",
  disability_status: "no",
  student_status: "not_student",
  veteran_status: false,
  received_benefits_before: false,
  mailing_situation: "family_or_friend",
  contact_preference: "call",
  phone_contact: "704-555-0142",
  best_time_to_reach: "morning",
};

/** What the person types into the review for the name, which no question asks. */
const TYPED_NAME = "Jordan Q. Tamarind";
const NAME_FIELD = "1 First name Middle name Last name  Suffix";

/** Private values that must never be shown on the page or ride a request. */
const PRIVATE_VALUES = [
  "Quillfeather County",
  "Larkspur Diner LLC",
  "1984-07-19",
  "07/19/1984",
  "704-555-0142",
];

/**
 * The end of /intake's status line, which announces what the show and
 * print buttons did. Each answer's status badge is a status too, so the
 * line is found by where it sits: right in the review section.
 */
const STATUS_LINE = "[data-review-section] > [role='status']";

/** What the stand-in pdf.js was given and made, and how it is set to behave. */
const pdfjs = {
  /** Whether importing pdf.js fails, as a dropped connection would make it. */
  failLoad: false,
  /** Held drawings: a page draws only once this resolves, when set. */
  drawGate: null as Promise<void> | null,
  /** Each document pdf.js opened: what it was given, and a copy of the bytes. */
  documents: [] as { options: Readonly<Record<string, unknown>>; bytes: Uint8Array; destroyed: number }[],
  /** Every canvas a page was drawn on, in order. */
  drawnOn: [] as HTMLCanvasElement[],
};

/**
 * Put the stand-in pdf.js where the print module imports it. Registered
 * again on each visit: Vitest keeps a mocked module once it has loaded, and
 * a visit that fails to load pdf.js must see the failure.
 */
function mockPdfJs(): void {
  vi.doMock("pdfjs-dist/legacy/build/pdf.mjs", () => {
    if (pdfjs.failLoad) {
      throw new TypeError("Failed to fetch dynamically imported module");
    }
    return {
      getDocument(options: Readonly<Record<string, unknown>>) {
        const record = { options, bytes: new Uint8Array(options.data as Uint8Array), destroyed: 0 };
        pdfjs.documents.push(record);
        const opened = PDFDocument.load(record.bytes).then((pdf) => ({
          numPages: pdf.getPageCount(),
          async getPage(pageNumber: number) {
            const size = pdf.getPage(pageNumber - 1).getSize();
            return {
              getViewport: ({ scale }: { scale: number }) => ({
                width: size.width * scale,
                height: size.height * scale,
              }),
              render({ canvas }: { canvas: HTMLCanvasElement }) {
                pdfjs.drawnOn.push(canvas);
                return { promise: pdfjs.drawGate ?? Promise.resolve(), cancel: () => undefined };
              },
              cleanup: () => true,
            };
          },
        }));
        return {
          promise: opened,
          async destroy() {
            record.destroyed += 1;
          },
        };
      },
    };
  });
  vi.doMock("pdfjs-dist/legacy/build/pdf.worker.mjs", () => {
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = { WorkerMessageHandler: {} };
    return { WorkerMessageHandler: {} };
  });
}

let device: ReturnType<typeof fakeIndexedDb>;
let requests: { url: string; init?: RequestInit }[];
/** Every attempt to hand the browser a file: object URLs and clicked download links. */
let saves: string[];
/** Each file a clicked download link handed the browser, by name, with the object URL it was handed by. */
let downloads: { name: string; url: string; blob: Blob }[];
/**
 * Every object URL made, with the file behind it. Each one is new, so a
 * test checks that its own URL was revoked rather than counting revokes.
 */
let objectUrls: Map<string, Blob>;
/** Every object URL revoked. */
let revoked: string[];
/** The filled bytes of every fill, as the page got them, to see what becomes of them. */
let filledBytes: Uint8Array[];
let printed: number;
/** Whether window.print() starts printing, as a browser does, or is ignored, as some in-app browsers do. */
let printOpens: boolean;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  device = fakeIndexedDb();
  requests = [];
  saves = [];
  downloads = [];
  objectUrls = new Map();
  revoked = [];
  filledBytes = [];
  printed = 0;
  printOpens = true;
  pdfjs.failLoad = false;
  pdfjs.drawGate = null;
  pdfjs.documents = [];
  pdfjs.drawnOn = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url === "/api/intake/state") {
        // No answers left on the server from before device mode.
        return Response.json({ progress: { answered: 0, remaining: 0, total: 0 } });
      }
      if (url === "/forms/dhb-5200.pdf") {
        return new Response(BLANK_FORM, { headers: { "content-type": "application/pdf" } });
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
  vi.stubGlobal("indexedDB", device.factory);
  vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  // Anything that would hand the browser a file is recorded, so a test can
  // show nothing did until the person asked, and what the browser got then.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      saves.push("createObjectURL");
      const url = `blob:filled-form-${objectUrls.size + 1}`;
      objectUrls.set(url, blob);
      return url;
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    if (this.hasAttribute("download") || this.href.startsWith("blob:")) {
      saves.push(`download ${this.download}`);
      const blob = objectUrls.get(this.href);
      if (blob !== undefined) {
        downloads.push({ name: this.download, url: this.href, blob });
      }
    }
  });
  // A browser that prints fires beforeprint as its print window opens, and
  // afterprint once it closes.
  vi.stubGlobal("print", () => {
    printed += 1;
    if (printOpens) {
      window.dispatchEvent(new Event("beforeprint"));
      window.dispatchEvent(new Event("afterprint"));
    }
  });
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("pdfjs-dist/legacy/build/pdf.mjs");
  vi.doUnmock("pdfjs-dist/legacy/build/pdf.worker.mjs");
  vi.doUnmock("../../lib/intake/device-fill");
  vi.doUnmock("../../lib/intake/device-print");
  delete (navigator as { userActivation?: unknown }).userActivation;
  document.body.replaceChildren();
});

/**
 * Keep the bytes of every fill the page makes, as the fill hands them over,
 * so a test can see the page wipe them. The fill itself is the real one.
 * Registered again on each visit, as the stand-in pdf.js is.
 */
function mockFill(): void {
  vi.doMock("../../lib/intake/device-fill", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../lib/intake/device-fill")>();
    return {
      ...real,
      async fillFormOnDevice(...args: Parameters<typeof real.fillFormOnDevice>) {
        const result = await real.fillFormOnDevice(...args);
        if (result.kind === "filled") {
          filledBytes.push(result.outcome.bytes);
        }
        return result;
      },
    };
  });
}

/** A file's bytes, read the way a page reads a Blob (jsdom's Blob has no arrayBuffer()). */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** What the browser keeps for this site: storage keys, by where they are kept. */
function browserStorage(): Record<string, string[]> {
  const keys = (storage: Storage) => Array.from({ length: storage.length }, (_, index) => storage.key(index) ?? "");
  return {
    indexedDB: [...device.stores.entries()]
      .flatMap(([store, entries]) => [...entries.keys()].map((key) => `${store}/${key}`))
      .sort(),
    localStorage: keys(window.localStorage).sort(),
    sessionStorage: keys(window.sessionStorage).sort(),
  };
}

/**
 * Nothing anywhere on the page saved the filled form, since the first
 * `since` saves (the person's own downloads, when a test makes any), and
 * nothing could save it or show it as a document.
 */
function expectNothingSaved(since = 0) {
  expect(saves.slice(since)).toEqual([]);
  expect(document.querySelectorAll("a[download], iframe, frame, embed, object")).toHaveLength(0);
}

/** Filled bytes let go of: every byte wiped, so nothing of the form is left in them. */
function expectWiped(bytes: Uint8Array | undefined) {
  expect(bytes?.length ?? 0).toBeGreaterThan(0);
  expect(bytes?.every((byte) => byte === 0)).toBe(true);
}

/** A canvas let go of: shrunk to nothing and off the page. */
function expectReleased(canvases: readonly HTMLCanvasElement[]) {
  expect(canvases.length).toBeGreaterThan(0);
  for (const canvas of canvases) {
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(canvas.isConnected).toBe(false);
  }
}

/** Open /intake as a fresh visit: new modules, so nothing is cached between visits. */
async function visit() {
  vi.resetModules();
  mockPdfJs();
  mockFill();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: IntakePage } = await import("./page");
  const { DEVICE_RESULTS_COPY } = await import("./device-results");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const { act } = React;
  async function settle(rounds = 30) {
    await act(async () => {
      for (let i = 0; i < rounds; i += 1) {
        await new Promise((done) => setTimeout(done, 0));
      }
    });
  }
  async function waitFor(check: () => boolean, what: string) {
    for (let i = 0; i < 400 && !check(); i += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 10));
      });
    }
    if (!check()) {
      throw new Error(`timed out waiting for ${what}`);
    }
  }
  await act(async () => {
    root.render(React.createElement(IntakePage));
  });
  await settle();
  const text = () => container.textContent ?? "";
  const byId = <T extends HTMLElement>(id: string) => {
    const found = container.querySelector<T>(`[id="${id}"]`);
    if (!found) {
      throw new Error(`no #${id} in: ${text().slice(0, 400)}`);
    }
    return found;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
    });
    await settle();
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  /**
   * Answer whatever question is on screen, from the persona or with "I'm
   * not sure", which is also the answer to every question in `notSure`.
   */
  async function answerCurrent(notSure: ReadonlySet<string>): Promise<boolean> {
    const question = container.querySelector<HTMLElement>("[data-intake-question]");
    if (!question) {
      return false;
    }
    const id = question.dataset.intakeQuestion!;
    const answer = notSure.has(id) ? undefined : PERSONA[id];
    if (answer === undefined) {
      await click(byId(`${id}-not-sure`));
      return true;
    }
    if (Array.isArray(answer)) {
      for (const value of answer) {
        await click(byId(`${id}-${value}`));
      }
    } else if (typeof answer === "boolean") {
      await click(byId(`${id}-${answer}`));
    } else if (container.querySelector(`[id="intake-${id}"]`)) {
      await type(byId<HTMLInputElement>(`intake-${id}`), String(answer));
    } else {
      await click(byId(`${id}-${answer}`));
    }
    await click(byId(`${id}-continue`));
    return true;
  }
  async function answerEverything(notSure: ReadonlySet<string> = new Set()) {
    for (let step = 0; step < 60 && (await answerCurrent(notSure)); step += 1) {
      // one question per screen
    }
  }
  /** The filled pages on screen: each page's frame and the canvas in it. */
  const pages = () =>
    [...container.querySelectorAll<HTMLElement>("[data-print-page]")].map((frame) => ({
      frame,
      canvases: [...frame.querySelectorAll("canvas")],
    }));
  /**
   * Show the filled form, wait for its pages, and read the form pdf.js was
   * given, which is the form the person prints.
   */
  async function showForm() {
    const before = pdfjs.documents.length;
    const button = container.querySelector<HTMLButtonElement>('[data-action="show-form"]');
    if (!button) {
      throw new Error("no show-form button");
    }
    await click(button);
    await waitFor(() => pdfjs.documents.length > before, "the fill");
    await waitFor(() => text().includes(DEVICE_RESULTS_COPY.ready), "the announcement");
    await waitFor(() => pages().length > 0, "the pages");
    const { options, bytes } = pdfjs.documents[pdfjs.documents.length - 1];
    return { options, bytes, form: (await PDFDocument.load(bytes)).getForm(), pages: pages() };
  }
  /**
   * Press Download a copy, and read the form the browser was handed, with
   * the object URLs revoked by the end of the press. It returns once the
   * page has revoked that URL, so no revoke the page has still to make
   * lands in a later test.
   */
  async function download() {
    const before = downloads.length;
    const button = container.querySelector<HTMLButtonElement>('[data-action="download-copy"]');
    if (!button) {
      throw new Error("no download button");
    }
    await act(async () => {
      button.click();
    });
    const revokedAtPress = [...revoked];
    await settle();
    expect(downloads).toHaveLength(before + 1);
    const { name, url, blob } = downloads[downloads.length - 1];
    await waitFor(() => revoked.includes(url), "the download URL to be revoked");
    const bytes = await blobBytes(blob);
    return { name, url, type: blob.type, bytes, revokedAtPress, form: (await PDFDocument.load(bytes)).getForm() };
  }
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return {
    container,
    text,
    byId,
    act,
    click,
    type,
    waitFor,
    answerEverything,
    pages,
    showForm,
    download,
    unmount,
    copy: DEVICE_RESULTS_COPY,
  };
}

/**
 * The style rules globals.css applies when printing, read with the
 * browser's own CSS parser. The file opens with Tailwind's directives,
 * which only the build reads, so just its one print block is parsed.
 */
function printRules(): CSSStyleRule[] {
  const css = readFileSync(path.join(REPO_ROOT, "src/app/globals.css"), "utf8");
  const start = css.indexOf("@media print {");
  expect(start, "globals.css has a print block").toBeGreaterThan(-1);
  expect(css.indexOf("@media print", start + 1), "globals.css has one print block").toBe(-1);
  let depth = 0;
  let end = start;
  for (; end < css.length; end += 1) {
    depth += css[end] === "{" ? 1 : css[end] === "}" ? -1 : 0;
    if (depth === 0 && css[end] === "}") {
      break;
    }
  }
  const style = document.createElement("style");
  style.textContent = css.slice(start, end + 1);
  document.head.append(style);
  const media = style.sheet!.cssRules[0] as CSSMediaRule;
  style.remove();
  expect(media.media.mediaText).toBe("print");
  return [...media.cssRules].filter((rule): rule is CSSStyleRule => "selectorText" in rule);
}

/** A selector list split at its top-level commas, the ones outside any parentheses. */
function selectorsIn(list: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index] === "(") {
      depth += 1;
    } else if (list[index] === ")") {
      depth -= 1;
    } else if (list[index] === "," && depth === 0) {
      selectors.push(list.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(list.slice(start).trim());
  return selectors;
}

/** A selector's specificity: its ids, its classes, attributes, and pseudo-classes, and its types. */
type Specificity = readonly [number, number, number];

function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * A selector's specificity, for what the print block writes: type,
 * universal, attribute, id, class, and pseudo-class selectors, with
 * combinators between them, and :not(), :has(), and :is() counting as
 * their most specific argument.
 */
function specificity(selector: string): Specificity {
  const count = [0, 0, 0];
  for (let index = 0; index < selector.length; ) {
    const rest = selector.slice(index);
    if (rest.startsWith("[")) {
      count[1] += 1;
      index = selector.indexOf("]", index) + 1;
    } else if (rest.startsWith(":")) {
      const name = /^:+([a-z-]+)/.exec(rest)![1];
      index += rest.indexOf(name) + name.length;
      if (selector[index] !== "(") {
        count[1] += 1;
        continue;
      }
      let depth = 0;
      let end = index;
      for (; end < selector.length; end += 1) {
        depth += selector[end] === "(" ? 1 : selector[end] === ")" ? -1 : 0;
        if (depth === 0) {
          break;
        }
      }
      if (name === "not" || name === "has" || name === "is") {
        const most = selectorsIn(selector.slice(index + 1, end)).map(specificity).sort(compareSpecificity).at(-1)!;
        most.forEach((part, place) => (count[place] += part));
      } else if (name !== "where") {
        count[1] += 1;
      }
      index = end + 1;
    } else if (/^[#.]/.test(rest)) {
      count[rest.startsWith("#") ? 0 : 1] += 1;
      index += /^[#.][\w-]+/.exec(rest)![0].length;
    } else if (/^[a-z]/i.test(rest)) {
      count[2] += 1;
      index += /^[a-z][\w-]*/i.exec(rest)![0].length;
    } else {
      // The universal selector, a combinator, or the space between.
      index += 1;
    }
  }
  return [count[0], count[1], count[2]];
}

/**
 * What the print rules set `property` to on `element`, as the cascade
 * picks it: of the rules that set it with a selector that matches, an
 * important one over the rest, then the most specific selector, then the
 * rule that comes last.
 */
function printValue(rules: readonly CSSStyleRule[], element: Element, property: string): string {
  let winner: { important: boolean; specificity: Specificity; value: string } | null = null;
  for (const rule of rules) {
    const value = rule.style.getPropertyValue(property);
    if (rule.selectorText.startsWith("@") || value === "") {
      continue;
    }
    const matching = selectorsIn(rule.selectorText).filter((selector) => element.matches(selector));
    if (matching.length === 0) {
      continue;
    }
    const candidate = {
      important: rule.style.getPropertyPriority(property) === "important",
      specificity: matching.map(specificity).sort(compareSpecificity).at(-1)!,
      value,
    };
    if (
      winner === null ||
      (candidate.important && !winner.important) ||
      (candidate.important === winner.important && compareSpecificity(candidate.specificity, winner.specificity) >= 0)
    ) {
      winner = candidate;
    }
  }
  return winner?.value ?? "";
}

/** The print rules a browser without :has() keeps: it drops every rule that uses it, whole. */
function withoutHas(rules: readonly CSSStyleRule[]): CSSStyleRule[] {
  return rules.filter((rule) => !rule.selectorText.includes(":has("));
}

/** Whether the page carries no print marks: nothing on <html>, and nothing on what held the pages. */
function expectNoPrintMarks() {
  expect(document.documentElement.hasAttribute("data-print-filled-form")).toBe(false);
  expect(document.querySelectorAll("[data-print-path]")).toHaveLength(0);
}

/** Every request so far: its URL and body carry none of these values. */
function expectNoAnswerInRequests(values: readonly string[]) {
  for (const { url, init } of requests) {
    const body = init?.body === undefined || init.body === null ? "" : String(init.body);
    for (const value of values) {
      expect(url, `a request URL carries ${value}`).not.toContain(value);
      expect(body, `a request body carries ${value}`).not.toContain(value);
    }
  }
}

describe("/intake to the review and the filled form, on the device", () => {
  it("shows the match, the review, and the filled DHB-5200 to print or download, saves a copy only when asked, and resumes after a reload", async () => {
    const page = await visit();
    await page.answerEverything();
    expect(page.text()).toContain("All questions answered for now");

    // The match, from the knowledge base's own facts and sources.
    const card = page.container.querySelector("[data-match-card='nc_medicaid']");
    expect(card?.textContent).toContain("This may be worth pursuing.");
    expect(card?.textContent).toContain("This explanation quotes the sourced facts above directly.");
    expect(card?.querySelectorAll("a[href^='https://']").length).toBeGreaterThan(0);

    // Where to take the form: the active knowledge base entries' official links, each with its source.
    const { KB_ENTRIES } = await import("../../lib/kb");
    const handoff = page.container.querySelector("[data-handoff-links]");
    expect([...(handoff?.querySelectorAll("li > a") ?? [])].map((link) => link.getAttribute("href"))).toEqual(
      KB_ENTRIES.filter((entry) => entry.status === "active").flatMap((entry) =>
        entry.facts.official_links.items.map((link) => link.url),
      ),
    );
    expect(handoff?.textContent).toContain("Source:");

    // The review: private answers show as known, never by value.
    const field = (name: string) => page.container.querySelector(`[data-review-field="${name}"]`);
    expect(field("3 Date of Birth mmddyyyy")?.querySelector("[data-field-state]")?.getAttribute("data-field-state")).toBe("prefilled");
    expect(field("14 Phone Number")?.querySelector("[data-field-state]")?.getAttribute("data-field-state")).toBe("prefilled");
    expect(field("undefined_10")?.querySelector("[data-field-value]")?.textContent).toBe("1200");
    for (const value of PRIVATE_VALUES) {
      expect(page.text()).not.toContain(value);
    }

    // Every field the fill leaves blank by design is listed with why and
    // where to find it on the printed form (VAL-FIX-007).
    const coverage = page.container.querySelector("[data-field-coverage]");
    expect(coverage?.querySelector("[data-coverage-counts]")?.textContent).toContain(
      "The application has 571 boxes and lines to fill in. 355 of them take your answers.",
    );
    expect(
      coverage?.querySelector('[data-coverage-field="Will you file jointly with a spouse"]')?.textContent,
    ).toContain("These questions don't ask this, page 3 of the form.");
    expect(coverage?.querySelector(`[data-coverage-field="${NAME_FIELD}"]`)).toBeNull();

    // The name isn't asked by the questions: it is typed into the review.
    const nameInput = field(NAME_FIELD)?.querySelector<HTMLInputElement>("input");
    expect(nameInput).toBeTruthy();
    await page.type(nameInput!, TYPED_NAME);

    const storedBefore = browserStorage();
    const first = await page.showForm();
    expect(first.form.getTextField("3 Date of Birth mmddyyyy").getText()).toBe("07/19/1984");
    expect(first.form.getTextField("14 Phone Number").getText()).toBe("704-555-0142");
    expect(first.form.getTextField("undefined_10").getText()).toBe("1200");
    expect(first.form.getTextField(NAME_FIELD).getText()).toBe(TYPED_NAME);
    // Nothing guessed: what no one answered stays blank, and the page says so.
    expect(first.form.getTextField("5 Social Security Number SSN").getText() ?? "").toBe("");
    expect(page.container.querySelector("[data-left-blank]")?.textContent).toContain("Social Security number");

    // pdf.js got the filled bytes and nothing that would make it request
    // anything, and its document is gone once the pages are drawn.
    expect(Object.keys(first.options).sort()).toEqual(["data", "isEvalSupported"]);
    expect(first.options.isEvalSupported).toBe(false);
    expect(pdfjs.documents.every((document) => document.destroyed === 1)).toBe(true);

    // Every page of the form, in order, labeled for a screen reader by its
    // number alone, each one canvas at 150 DPI for a Letter page, all in
    // the one container the print rules put on paper (globals.css).
    const preview = page.container.querySelector("[data-print-preview]");
    expect(preview?.querySelector("h2")?.textContent).toBe(page.copy.previewHeading);
    expect(first.pages).toHaveLength(21);
    const onPaper = preview?.querySelectorAll("[data-print-pages]");
    expect(onPaper).toHaveLength(1);
    first.pages.forEach(({ frame, canvases }, index) => {
      expect(frame.parentElement).toBe(onPaper?.[0]);
      expect(frame.getAttribute("role")).toBe("img");
      expect(frame.getAttribute("aria-label")).toBe(`Page ${index + 1} of 21, filled application`);
      expect(canvases).toHaveLength(1);
      expect([canvases[0].width, canvases[0].height]).toEqual([1275, 1650]);
    });
    // Focus went to the pages' heading, so a screen reader lands on them.
    expect(document.activeElement).toBe(preview?.querySelector("h2"));
    expect(first.pages.map(({ canvases }) => canvases[0])).toEqual(pdfjs.drawnOn);
    // The heading outline still never skips a level.
    const levels = [...page.container.querySelectorAll("[data-device-results] :is(h2, h3, h4)")].map((heading) =>
      Number(heading.tagName.slice(1)),
    );
    levels.forEach((level, index) => expect(level).toBeLessThanOrEqual((levels[index - 1] ?? 1) + 1));

    // Print is the browser's print, and nothing anywhere was saved.
    await page.click(preview!.querySelector<HTMLButtonElement>('[data-action="print"]')!);
    expect(printed).toBe(1);
    expectNothingSaved();
    expect(browserStorage()).toEqual(storedBefore);
    expect(storedBefore.indexedDB).toEqual(["kv/intake-answers", "kv/intake-answers-key"]);

    // Download a copy, beside Print. The note that describes the button
    // says what the file holds, private answers included, that it isn't
    // encrypted, and to delete it on a shared computer.
    const downloadButton = preview!.querySelector<HTMLButtonElement>('[data-action="download-copy"]')!;
    expect(downloadButton.textContent).toBe(page.copy.downloadButton);
    expect(downloadButton.parentElement).toBe(preview!.querySelector('[data-action="print"]')?.parentElement);
    const downloadNote = document.getElementById(downloadButton.getAttribute("aria-describedby") ?? "");
    expect(downloadNote?.textContent).toBe(page.copy.downloadNote);
    expect(preview!.contains(downloadNote)).toBe(true);
    for (const disclosure of ["private ones included", "isn't encrypted", "on a shared computer, delete it"]) {
      expect(downloadNote?.textContent).toContain(disclosure);
    }
    // The press hands the browser one file: the very form the pages show,
    // as a PDF. The link goes at once, the URL a moment later, and no
    // request goes anywhere and nothing goes in the browser's storage.
    const requestsBefore = requests.length;
    const copy = await page.download();
    expect(saves).toEqual(["createObjectURL", "download dhb-5200.pdf"]);
    expect(copy.name).toBe("dhb-5200.pdf");
    expect(copy.type).toBe("application/pdf");
    expect(copy.bytes).toEqual(first.bytes);
    expect(copy.form.getTextField(NAME_FIELD).getText()).toBe(TYPED_NAME);
    expect(copy.form.getTextField("3 Date of Birth mmddyyyy").getText()).toBe("07/19/1984");
    await page.waitFor(() => page.text().includes(page.copy.downloaded), "the word that the copy is downloading");
    expect(document.querySelectorAll("a[download], a[href^='blob:']")).toHaveLength(0);
    expect(copy.revokedAtPress).toEqual([]);
    expect(revoked).toEqual([copy.url]);
    expect(requests).toHaveLength(requestsBefore);
    expect(browserStorage()).toEqual(storedBefore);
    const downloaded = saves.length;

    // A change to a typed answer drops the pages: they no longer match,
    // and the word that they are ready goes with them, and so do the
    // download button and the bytes kept for it.
    const shown = first.pages.map(({ canvases }) => canvases[0]);
    await page.type(nameInput!, `${TYPED_NAME} Jr.`);
    expect(page.pages()).toEqual([]);
    expect(page.container.querySelector("[data-print-preview]")).toBeNull();
    expect(page.container.querySelector('[data-action="download-copy"]')).toBeNull();
    expectReleased(shown);
    expectWiped(filledBytes[0]);
    expectNoPrintMarks();
    expect(page.text()).not.toContain(page.copy.ready);

    // The only requests: the cookie-only check, then the blank form, bodiless and cookieless.
    expect(requests.map((request) => request.url)).toEqual(["/api/intake/state", "/forms/dhb-5200.pdf"]);
    expect(requests[1].init).toEqual({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer" });
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME, "1200", "Quillfeather"]);
    expect(device.stores.get("kv")?.has("intake-answers")).toBe(true);

    // Shown again, then the page goes away: its pages and bytes go with it.
    const again = await page.showForm();
    await page.unmount();
    expectReleased(again.pages.map(({ canvases }) => canvases[0]));
    expectWiped(filledBytes[1]);

    // A reload: the answers come back from IndexedDB, straight to the review.
    const reloaded = await visit();
    expect(reloaded.text()).toContain("Welcome back. These are the answers you saved in this browser.");
    expect(reloaded.text()).toContain("All questions answered for now");
    expect(reloaded.container.querySelector("[data-match-card='nc_medicaid']")).not.toBeNull();
    expect(reloaded.pages()).toEqual([]);
    const second = await reloaded.showForm();
    expect(second.form.getTextField("3 Date of Birth mmddyyyy").getText()).toBe("07/19/1984");
    expect(second.form.getTextField("14 Phone Number").getText()).toBe("704-555-0142");
    // The typed name was for that visit's form: it isn't kept anywhere.
    expect(second.form.getTextField(NAME_FIELD).getText() ?? "").toBe("");
    expect(requests.map((request) => request.url)).toEqual([
      "/api/intake/state",
      "/forms/dhb-5200.pdf",
      "/forms/dhb-5200.pdf",
      "/api/intake/state",
      "/forms/dhb-5200.pdf",
    ]);
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME, "1200", "Quillfeather"]);
    // The one copy saved is the one the person asked for.
    expectNothingSaved(downloaded);
    await reloaded.unmount();
  }, 60_000);

  it("prints both boxes of a check-one line as typed and says to fix them", async () => {
    // The full DHB-5200 mapping (VAL-FIX-007): the fill never picks a side
    // when two boxes of one check-one group are checked. The form shows
    // both, and the page names the question above the filled pages.
    const { DEVICE_FORM_ENTRY } = await import("../../lib/intake/device-form");
    const [employed, selfEmployed] = ["Employed_2", "SelfEmployed_2"].map(
      (name) => DEVICE_FORM_ENTRY.fields.find((field) => field.name === name)!,
    );
    expect(employed.conflictGroup).toEqual({ id: "p2-work-status", kind: "single_choice" });
    expect(selfEmployed.conflictGroup).toEqual(employed.conflictGroup);

    const page = await visit();
    await page.answerEverything();
    for (const field of [employed, selfEmployed]) {
      await page.type(
        page.container.querySelector<HTMLInputElement>(`[data-review-field="${field.name}"] input`)!,
        "checked",
      );
    }
    expect(page.container.querySelector("[data-check-conflicts]")).toBeNull();
    const filled = await page.showForm();
    expect(filled.form.getCheckBox(employed.name).isChecked()).toBe(true);
    expect(filled.form.getCheckBox(selfEmployed.name).isChecked()).toBe(true);
    const flagged = page.container.querySelectorAll("[data-check-conflicts] li");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].getAttribute("data-check-conflict")).toBe("single_choice");
    expect(flagged[0].textContent).toContain(employed.question);
    expect(page.container.querySelector("[data-check-conflicts]")?.textContent).toContain(
      page.copy.conflictsHeading,
    );
    expect(page.container.querySelector("[data-print-preview] [data-check-conflicts]")).not.toBeNull();
    expectNoAnswerInRequests([...PRIVATE_VALUES, "1200", "Quillfeather"]);
    await page.unmount();
  }, 60_000);

  it("after a download, a delete takes the pages and their bytes and says the downloaded copy stays on the device", async () => {
    const page = await visit();
    await page.answerEverything();
    await page.type(page.container.querySelector<HTMLInputElement>(`[data-review-field="${NAME_FIELD}"] input`)!, TYPED_NAME);
    const filled = await page.showForm();
    expect(filled.form.getTextField(NAME_FIELD).getText()).toBe(TYPED_NAME);
    const copy = await page.download();
    expect(copy.form.getTextField(NAME_FIELD).getText()).toBe(TYPED_NAME);

    const { act } = await import("react");
    const { DEVICE_INTAKE_COPY } = await import("../../lib/intake/device-intake");
    const deleteButton = page.container.querySelector<HTMLButtonElement>("[data-delete-from-device]")!;
    await act(async () => {
      deleteButton.click();
    });
    const confirm = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === DEVICE_INTAKE_COPY.deleteYes,
    )!;
    await act(async () => {
      confirm.click();
    });
    await page.waitFor(() => page.text().includes(DEVICE_INTAKE_COPY.deleted), "the delete confirmation");

    // The answers and their key are gone from the browser, and the typed
    // name, the filled pages, and the bytes kept for a download with the
    // screen.
    expect(device.stores.get("kv")?.has("intake-answers")).toBe(false);
    expect(device.stores.get("kv")?.has("intake-answers-key")).toBe(false);
    expect(page.container.querySelector("[data-device-results]")).toBeNull();
    expect(page.text()).not.toContain(TYPED_NAME);
    expectReleased(filled.pages.map(({ canvases }) => canvases[0]));
    expectWiped(filledBytes.at(-1));
    expectNoPrintMarks();
    // The copy downloaded is a file outside the delete. The confirmation
    // claims only this browser and says the copy stays until the person
    // deletes it, and nothing more was saved.
    expect(downloads).toHaveLength(1);
    expectNothingSaved(2);
    expect(DEVICE_INTAKE_COPY.deleted).toContain("None of your answers are left in this browser");
    expect(DEVICE_INTAKE_COPY.deleted).toContain(
      "If you downloaded a copy of the filled form, or saved it as a PDF when printing, that file stays on this device until you delete it.",
    );
    expect(page.text()).toContain(DEVICE_INTAKE_COPY.deleted);
    expect(page.text()).not.toContain("left on this device");
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME, "1200", "Quillfeather"]);
    await page.unmount();
  }, 60_000);

  it("in a browser that can't save, a clear takes the filled pages and their bytes and says a downloaded copy stays", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const page = await visit();
    const { DEVICE_INTAKE_COPY } = await import("../../lib/intake/device-intake");
    expect(page.text()).toContain(DEVICE_INTAKE_COPY.unsupportedOnLoad);
    await page.answerEverything();
    await page.type(page.container.querySelector<HTMLInputElement>(`[data-review-field="${NAME_FIELD}"] input`)!, TYPED_NAME);
    const filled = await page.showForm();
    expect(filled.form.getTextField(NAME_FIELD).getText()).toBe(TYPED_NAME);
    await page.download();

    await page.click(page.container.querySelector<HTMLButtonElement>("[data-delete-from-device]")!);
    const confirm = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === DEVICE_INTAKE_COPY.deleteYes,
    )!;
    await page.click(confirm);
    await page.waitFor(() => page.text().includes(DEVICE_INTAKE_COPY.clearedNothingStored), "the clear");
    expect(page.container.querySelector("[data-device-results]")).toBeNull();
    expect(page.text()).not.toContain(TYPED_NAME);
    expectReleased(filled.pages.map(({ canvases }) => canvases[0]));
    expectWiped(filledBytes.at(-1));
    expect(downloads).toHaveLength(1);
    expectNothingSaved(2);
    // The clear claims only this browser, as the delete does: answers are
    // kept per browser, and the downloaded copy, or a Save as PDF from the
    // print window, is a file on the device the clear can't reach, so it
    // says that file stays and never says there was nothing on the device.
    expect(DEVICE_INTAKE_COPY.clearedNothingStored).toContain(
      "This browser can't save answers, so none were kept in it",
    );
    expect(DEVICE_INTAKE_COPY.clearedNothingStored).toContain(
      "If you downloaded a copy of the filled form, or saved it as a PDF when printing, that file stays on this device until you delete it.",
    );
    expect(page.text()).toContain(DEVICE_INTAKE_COPY.clearedNothingStored);
    expect(page.text()).not.toContain("nothing on the device");
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME, "1200", "Quillfeather"]);
    await page.unmount();
  }, 60_000);

  it("says nothing was filled when the blank form can't be fetched, and sends nothing", async () => {
    const page = await visit();
    await page.answerEverything();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        throw new TypeError("Failed to fetch");
      }),
    );
    const button = page.container.querySelector<HTMLButtonElement>('[data-action="show-form"]')!;
    await page.type(page.container.querySelector<HTMLInputElement>(`[data-review-field="${NAME_FIELD}"] input`)!, TYPED_NAME);
    const { act } = await import("react");
    await act(async () => {
      button.click();
    });
    for (let i = 0; i < 100 && !page.text().includes(page.copy.templateUnavailable); i += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 10));
      });
    }
    expect(page.text()).toContain(page.copy.templateUnavailable);
    expect(pdfjs.documents).toEqual([]);
    expect(page.pages()).toEqual([]);
    expectNothingSaved();
    expect(requests.at(-1)?.url).toBe("/forms/dhb-5200.pdf");
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME]);
    await page.unmount();
  }, 60_000);

  it("holds the filled form back until every box answer reads checked or unchecked", async () => {
    // A box answer the fill can't read would print as an unchecked box that
    // counts as filled, so "yes" for "Is Person 2 employed?" is listed to
    // fix, and nothing is filled or fetched until it is.
    const page = await visit();
    await page.answerEverything();
    const input = (name: string) =>
      page.container.querySelector<HTMLInputElement>(`[data-review-field="${name}"] input`)!;
    await page.type(input(NAME_FIELD), TYPED_NAME);
    await page.type(input("Employed_2"), "yes");
    await page.type(input("SelfEmployed_2"), " Checked ");
    await page.click(page.container.querySelector<HTMLButtonElement>('[data-action="show-form"]')!);
    await page.waitFor(() => page.text().includes(page.copy.unreadableBoxes), "the box answers notice");
    expect(pdfjs.documents).toEqual([]);
    expect(page.pages()).toEqual([]);
    expect(requests.map((request) => request.url)).toEqual(["/api/intake/state"]);
    const listed = [...page.container.querySelectorAll("[data-unreadable-box]")].map((item) =>
      item.getAttribute("data-unreadable-box"),
    );
    expect(listed).toEqual(["Employed_2"]);
    expect(input("Employed_2").getAttribute("aria-invalid")).toBe("true");
    expect(input("SelfEmployed_2").getAttribute("aria-invalid")).toBeNull();

    // Fixed, the list goes away and the form fills as answered.
    await page.type(input("Employed_2"), "unchecked");
    expect(page.container.querySelector("[data-unreadable-boxes]")).toBeNull();
    const filled = await page.showForm();
    expect(filled.form.getCheckBox("Employed_2").isChecked()).toBe(false);
    expect(filled.form.getCheckBox("SelfEmployed_2").isChecked()).toBe(true);
    expect(filled.form.getTextField(NAME_FIELD).getText()).toBe(TYPED_NAME);
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME]);
    await page.unmount();
  }, 60_000);

  it("keeps whatever was typed into the review through trips to a question and back", async () => {
    // The page holds what was typed in its memory, above the review, so
    // answering or rereading a question doesn't wipe the rest. One visit
    // keeps this cheap: each trip after the first rereads the last question.
    const { DEVICE_FORM_ENTRY } = await import("../../lib/intake/device-form");
    const typedFields = DEVICE_FORM_ENTRY.fields
      .filter((field) => field.disposition === "mapped" && field.specQuestionId === null)
      .map((field) => field.name);
    const typedArb = fc.dictionary(
      fc.constantFrom(...typedFields),
      fc.oneof(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,#'-]{0,30}$/), fc.constantFrom("checked", "unchecked")),
      { minKeys: 1, maxKeys: 6 },
    );
    const page = await visit();
    // Not sure of the county, so the review asks for it.
    await page.answerEverything(new Set(["county"]));
    const input = (name: string) =>
      page.container.querySelector<HTMLInputElement>(`[data-review-field="${name}"] input`)!;
    const typedSoFar: Record<string, string> = {};
    async function typeIntoReview(typed: Readonly<Record<string, string>>) {
      for (const [name, value] of Object.entries(typed)) {
        await page.type(input(name), value);
        typedSoFar[name] = value;
      }
    }
    function expectEverythingTyped() {
      expect(page.text()).toContain("All questions answered for now");
      for (const [name, value] of Object.entries(typedSoFar)) {
        expect(input(name).value, name).toBe(value);
      }
    }

    // Answer this question: the county, from the review, and back.
    await typeIntoReview({ [NAME_FIELD]: TYPED_NAME });
    await page.click(page.container.querySelector<HTMLButtonElement>('[data-review-field="7 County"] button')!);
    expect(page.container.querySelector("[data-device-results]")).toBeNull();
    await page.type(page.byId<HTMLInputElement>("intake-county"), "Quillfeather County");
    await page.click(page.byId("county-continue"));
    expect(
      page.container.querySelector('[data-review-field="7 County"] [data-field-state]')?.getAttribute("data-field-state"),
    ).toBe("prefilled");
    expectEverythingTyped();

    // Review this answer, for whatever was typed: everything typed so far survives.
    await fc.assert(
      fc.asyncProperty(typedArb, async (typed) => {
        await typeIntoReview(typed);
        const reviews = [...page.container.querySelectorAll<HTMLButtonElement>("button")].filter(
          (button) => button.textContent === "Review this answer",
        );
        await page.click(reviews[reviews.length - 1]);
        expect(page.container.querySelector("[data-device-results]")).toBeNull();
        const question = page.container.querySelector<HTMLElement>("[data-intake-question]")!;
        await page.click(page.byId(`${question.dataset.intakeQuestion}-continue`));
        expectEverythingTyped();
      }),
      { numRuns: 10 },
    );
    expectNoAnswerInRequests(PRIVATE_VALUES);
    await page.unmount();
  }, 120_000);

  it("drops what was typed into the review with a delete, here, in another tab, or found by a save", async () => {
    const page = await visit();
    const { DEVICE_INTAKE_COPY } = await import("../../lib/intake/device-intake");
    const nameInput = () =>
      page.container.querySelector<HTMLInputElement>(`[data-review-field="${NAME_FIELD}"] input`);
    await page.answerEverything();
    for (const where of ["here", "in another tab", "found by a save"] as const) {
      await page.type(nameInput()!, TYPED_NAME);
      if (where === "here") {
        await page.click(page.container.querySelector<HTMLButtonElement>("[data-delete-from-device]")!);
        const confirm = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === DEVICE_INTAKE_COPY.deleteYes,
        )!;
        await page.click(confirm);
        await page.waitFor(() => page.text().includes(DEVICE_INTAKE_COPY.deleted), "the delete");
      } else if (where === "in another tab") {
        device.stores.get("kv")?.clear();
        await page.act(async () => {
          window.dispatchEvent(new Event("focus"));
        });
        await page.waitFor(
          () => page.text().includes(DEVICE_INTAKE_COPY.purgedElsewhere),
          "the delete in another tab",
        );
      } else {
        // Another tab deletes everything, and this page finds out when the
        // person changes an answer and it saves.
        device.stores.get("kv")?.clear();
        const review = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Review this answer",
        )!;
        await page.click(review);
      }
      expect(page.container.querySelector("[data-device-results]"), where).toBeNull();
      // Answering again brings the review back empty: the typed name went with the answers.
      await page.answerEverything();
      expect(nameInput()?.value, where).toBe("");
      expect(page.text(), where).not.toContain(TYPED_NAME);
    }
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME]);
    await page.unmount();
  }, 120_000);

  it("says something went wrong and shows no pages when pdf.js won't load, then shows them on the next try", async () => {
    pdfjs.failLoad = true;
    const page = await visit();
    await page.answerEverything();
    await page.click(page.container.querySelector<HTMLButtonElement>('[data-action="show-form"]')!);
    await page.waitFor(() => page.text().includes(page.copy.failed), "the failure notice");
    expect(pdfjs.documents).toEqual([]);
    expect(page.pages()).toEqual([]);
    expect(page.container.querySelector("[data-print-preview]")).toBeNull();
    // The button is back, ready for another try, and nothing says the form is still being filled in.
    const button = page.container.querySelector<HTMLButtonElement>('[data-action="show-form"]');
    expect(button?.getAttribute("aria-disabled")).toBeNull();
    expect(button?.textContent).toBe(page.copy.showFormButton);
    expect(page.text()).not.toContain(page.copy.showingForm);
    expectNothingSaved();

    // A dropped connection isn't kept: the next press loads pdf.js and shows the form.
    pdfjs.failLoad = false;
    const filled = await page.showForm();
    expect(filled.pages).toHaveLength(21);
    expect(filled.form.getTextField("3 Date of Birth mmddyyyy").getText()).toBe("07/19/1984");
    expectNothingSaved();
    expectNoAnswerInRequests([...PRIVATE_VALUES, "1200", "Quillfeather"]);
    await page.unmount();
  }, 60_000);

  it("stops drawing when an answer changes partway, and never shows pages from the old answers", async () => {
    const page = await visit();
    await page.answerEverything();
    const nameInput = page.container.querySelector<HTMLInputElement>(`[data-review-field="${NAME_FIELD}"] input`)!;
    await page.type(nameInput, TYPED_NAME);
    const gate = Promise.withResolvers<void>();
    pdfjs.drawGate = gate.promise;
    const show = page.container.querySelector<HTMLButtonElement>('[data-action="show-form"]')!;
    show.focus();
    await page.click(show);
    await page.waitFor(() => pdfjs.drawnOn.length > 0, "the first page to start drawing");
    // While the form is prepared the button is busy, not disabled, so it
    // keeps focus, and the status line says what is happening.
    expect(show.getAttribute("aria-disabled")).toBe("true");
    expect(show.disabled).toBe(false);
    expect(document.activeElement).toBe(show);
    expect(page.container.querySelector(STATUS_LINE)?.textContent).toBe(page.copy.showingForm);
    // A second press meanwhile starts nothing.
    await page.click(show);
    expect(pdfjs.documents).toHaveLength(1);

    // The name changes while the first page draws, and then the drawing finishes.
    await page.type(nameInput, `${TYPED_NAME} Jr.`);
    pdfjs.drawGate = null;
    await page.act(async () => {
      gate.resolve();
    });
    await page.waitFor(() => show.getAttribute("aria-disabled") === null, "the drawing to stop");
    expect(page.pages()).toEqual([]);
    expect(pdfjs.drawnOn).toHaveLength(1);
    expectReleased(pdfjs.drawnOn);
    // The bytes filled from the old answers are wiped, never kept for a download.
    expectWiped(filledBytes[0]);
    expect(page.container.querySelector('[data-action="download-copy"]')).toBeNull();
    // Nothing failed: the person changed an answer. Nothing says the form
    // is being filled in or is ready, either.
    expect(page.text()).not.toContain(page.copy.failed);
    expect(page.text()).not.toContain(page.copy.ready);
    expect(page.container.querySelector(STATUS_LINE)?.textContent).toBe("");

    // Shown again, the form has the new name.
    const filled = await page.showForm();
    expect(filled.form.getTextField(NAME_FIELD).getText()).toBe(`${TYPED_NAME} Jr.`);
    expectNothingSaved();
    await page.unmount();
  }, 60_000);

  it("drops the filled pages when the answers on the device change, and lets go of them", async () => {
    // Another tab can change the answers while the end of /intake is on
    // screen (the wizard picks the change up on focus); the pages drawn
    // from the old answers go at once.
    vi.resetModules();
    mockPdfJs();
    mockFill();
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { DeviceResults } = await import("./device-results");
    const { EMPTY_CLIENT_ANSWERS, saveClientAnswer } = await import("../../lib/intake/client-store");
    const typed = { values: {}, onChange: () => undefined };
    const before = saveClientAnswer(EMPTY_CLIENT_ANSWERS, {
      questionId: "state",
      status: "known",
      provenance: "user_supplied",
      value: "NC",
    });
    const after = saveClientAnswer(before, {
      questionId: "household_size",
      status: "known",
      provenance: "user_supplied",
      value: "2",
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const { act } = React;
    await act(async () => {
      root.render(React.createElement(DeviceResults, { answers: before, typedAnswers: typed }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-action="show-form"]')!.click();
    });
    for (let i = 0; i < 400 && container.querySelectorAll("[data-print-page] canvas").length === 0; i += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 10));
      });
    }
    const shown = [...container.querySelectorAll("canvas")];
    expect(shown).toHaveLength(21);

    await act(async () => {
      root.render(React.createElement(DeviceResults, { answers: after, typedAnswers: typed }));
    });
    expect(container.querySelector("[data-print-preview]")).toBeNull();
    expectReleased(shown);
    expectWiped(filledBytes[0]);
    expectNoPrintMarks();
    expectNothingSaved();
    await act(async () => root.unmount());
    container.remove();
  }, 60_000);

  it("saves a copy only when the person presses Download a copy, never when the browser says no one did", async () => {
    // The rules allow the copy only at the person's own choice. Showing the
    // form, printing it, and leaving it on screen save nothing, and a press
    // the browser says no one made (a script's click, say) saves nothing
    // either, and the page says so.
    const view = await results();
    expect(view.downloadButton()).toBeNull();
    await view.show();
    await view.waitFor(() => view.canvases().length === 21, "the pages");
    await view.act(async () => {
      view.container.querySelector<HTMLButtonElement>('[data-action="print"]')!.click();
      await new Promise((done) => setTimeout(done, 50));
    });
    expect(printed).toBe(1);
    expectNothingSaved();
    expect(view.downloadButton()?.textContent).toBe(view.copy.downloadButton);

    // A browser that won't make the file saves nothing, and the page says so.
    const makeUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL")!;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: () => {
        throw new DOMException("Object URLs are blocked here", "SecurityError");
      },
    });
    await view.act(async () => {
      view.downloadButton()!.click();
    });
    Object.defineProperty(URL, "createObjectURL", makeUrl);
    expectNothingSaved();
    await view.waitFor(() => view.status() === view.copy.downloadNotStarted, "the notice that the file wasn't made");

    const activation = { isActive: false };
    Object.defineProperty(navigator, "userActivation", { value: activation, configurable: true });
    await view.act(async () => {
      view.downloadButton()!.click();
    });
    expectNothingSaved();
    await view.waitFor(() => view.status() === view.copy.downloadNotStarted, "the notice that nothing was saved");

    // The person's own press saves one copy: the form on screen.
    activation.isActive = true;
    await view.act(async () => {
      view.downloadButton()!.click();
    });
    expect(saves).toEqual(["createObjectURL", "download dhb-5200.pdf"]);
    // The URL outlives the press, so a browser that starts the download a
    // moment later still gets it, and then it is revoked.
    expect(revoked).toEqual([]);
    expect(await blobBytes(downloads[0].blob)).toEqual(pdfjs.documents[0].bytes);
    await view.waitFor(() => view.status() === view.copy.downloaded, "the word that the copy is downloading");
    await view.waitFor(() => revoked.includes(downloads[0].url), "the download URL to be revoked");
    expect(revoked).toEqual([downloads[0].url]);
    // Only the blank form was asked for, and leaving takes the bytes too.
    expect(requests.map((request) => request.url)).toEqual(["/forms/dhb-5200.pdf"]);
    await view.unmount();
    expectWiped(filledBytes[0]);
    expectNothingSaved(2);
  }, 60_000);

  it("drops the word that a copy should be saving, or didn't save, when the pages go", async () => {
    // A line about a download, or one that says to press Download a copy
    // again, never outlasts the pages and the button.
    const view = await results();
    await view.show();
    await view.waitFor(() => view.canvases().length === 21, "the pages");
    await view.act(async () => {
      view.downloadButton()!.click();
    });
    await view.waitFor(() => view.status() === view.copy.downloaded, "the word that the browser should save the copy");
    await view.waitFor(() => revoked.includes(downloads[0].url), "the download URL to be revoked");
    await view.act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(view.downloadButton()).toBeNull();
    expect(view.status()).toBe("");

    // Back from the browser's cache, a press the browser says no one made
    // saves nothing, and the line that says to press again goes with the
    // pages too.
    window.dispatchEvent(new Event("pageshow"));
    await view.show();
    await view.waitFor(() => view.canvases().length === 21, "the pages again");
    Object.defineProperty(navigator, "userActivation", { value: { isActive: false }, configurable: true });
    await view.act(async () => {
      view.downloadButton()!.click();
    });
    await view.waitFor(() => view.status() === view.copy.downloadNotStarted, "the notice that nothing was saved");
    await view.act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(view.downloadButton()).toBeNull();
    expect(view.status()).toBe("");
    expect(downloads).toHaveLength(1);
    await view.unmount();
  }, 60_000);

  it("prints only the filled pages, one to a sheet, each sized to fit its sheet both ways, with or without :has()", async () => {
    // Print puts the filled pages on paper and nothing else, so the
    // review's typed answers and the rest of the screen never print, and a
    // page of the form never splits over two sheets. The rules are read
    // from globals.css and matched against the page as it renders, as the
    // cascade applies them. A browser without :has(), such as Firefox
    // before 121, drops every rule that uses it, so the rules without :has()
    // must do all of this on their own, and :has() is only an enhancement
    // in rules of its own.
    const all = printRules();
    const plain = withoutHas(all);
    expect(plain.length, "a rule of its own uses :has()").toBeLessThan(all.length);
    expect(
      plain.some(
        (rule) =>
          rule.style.getPropertyValue("display") === "none" && rule.style.getPropertyPriority("display") === "important",
      ),
      "a rule without :has() hides the screen",
    ).toBe(true);
    // Exactly two rules hide the screen, the one without :has() and the
    // one with it, and each is important, so nothing the page sets on its
    // own elements can show them on paper.
    const hide = all.filter((rule) => rule.style.getPropertyValue("display") === "none");
    expect(hide).toHaveLength(2);
    expect(hide.filter((rule) => rule.selectorText.includes(":has(")), "one hide rule uses :has()").toHaveLength(1);
    for (const rule of hide) {
      expect(rule.style.getPropertyPriority("display"), rule.selectorText).toBe("important");
    }
    const view = await results();
    // The app's own header and footer, around the page.
    const header = document.createElement("header");
    header.textContent = "Tenet";
    const footer = document.createElement("footer");
    footer.textContent = "Footer";
    document.body.prepend(header);
    document.body.append(footer);
    const name = (element: Element) =>
      `${element.tagName.toLowerCase()}${[...element.attributes].map((attribute) => `[${attribute.name}]`).join("")}`;
    const hiddenBy = (rules: readonly CSSStyleRule[]) => (element: Element) =>
      printValue(rules, element, "display") === "none";

    // With no pages drawn, nothing marks the page, and a print is the page
    // as it is, in any browser.
    expectNoPrintMarks();
    const screen = [
      ...document.body.children,
      ...view.container.querySelectorAll("section, button, [role='status']"),
      view.container.querySelector("[data-review-fields] input")!,
    ];
    for (const rules of [plain, all]) {
      expect(screen.filter(hiddenBy(rules)).map(name)).toEqual([]);
    }

    await view.show();
    await view.waitFor(() => view.canvases().length === 21, "the pages");
    const onPaper = view.container.querySelector("[data-print-pages]")!;
    // Hiding an element hides all that is in it, so what prints is decided
    // along the line from the page's body down to the pages: everything on
    // that line and in the pages prints, and everything beside the line is
    // hidden, and with it the rest of the screen. The page marks <html> and
    // that line, and nothing else, while the pages are on screen.
    const line: Element[] = [];
    for (let element: Element | null = onPaper; element !== document.body; element = element!.parentElement) {
      line.push(element!);
    }
    expect(document.documentElement.hasAttribute("data-print-filled-form")).toBe(true);
    expect([...document.querySelectorAll("[data-print-path]")]).toEqual(
      [document.body, ...line.slice(1).reverse()],
    );
    const beside = [document.body, ...line.slice(1)].flatMap((holder) =>
      [...holder.children].filter((child) => !line.includes(child)),
    );
    expect(beside.map(name)).toEqual(expect.arrayContaining(["header", "footer"]));

    /** Everything above holds for these rules: what a browser with them prints. */
    function expectOnlyThePagesPrint(rules: readonly CSSStyleRule[], which: string) {
      const hidden = hiddenBy(rules);
      for (const element of [document.body, ...line]) {
        expect(hidden(element), `${which}: ${name(element)}`).toBe(false);
        // What holds the pages prints as a plain block, so the first page
        // starts at the top of the first sheet.
        expect(printValue(rules, element, "display"), `${which}: ${name(element)}`).toBe("block");
        expect(printValue(rules, element, "padding"), `${which}: ${name(element)}`).toBe("0");
        expect(printValue(rules, element, "margin"), `${which}: ${name(element)}`).toBe("0");
      }
      for (const element of beside) {
        expect(hidden(element), `${which}: ${name(element)}`).toBe(true);
      }
      for (const element of onPaper.querySelectorAll("*")) {
        expect(hidden(element), `${which}: ${name(element)}`).toBe(false);
        expect(printValue(rules, element, "display"), `${which}: ${name(element)}`).toBe("block");
      }
      // Among what stays off the paper: every typed answer, the status
      // line, and the print and download buttons themselves.
      for (const element of view.container.querySelectorAll("input, [role='status'], button")) {
        expect(
          beside.some((hiddenHolder) => hiddenHolder.contains(element)),
          `${which}: ${name(element)}`,
        ).toBe(true);
      }
      // One page to a sheet: never split inside, a break after every page
      // but the last, portrait where the browser lets the page ask.
      const frames = [...onPaper.querySelectorAll("[data-print-page]")];
      expect(frames).toHaveLength(21);
      frames.forEach((frame, index) => {
        expect(printValue(rules, frame, "break-inside"), which).toBe("avoid");
        expect(printValue(rules, frame, "break-after"), which).toBe(index < frames.length - 1 ? "page" : "auto");
      });
      expect(printValue(rules, onPaper, "page"), which).toBe("filled-application");
      expect(
        rules.find((rule) => rule.selectorText === "@page filled-application")?.style.getPropertyValue("size"),
        which,
      ).toBe("portrait");
      // Each page's canvas keeps its shape and fits the printable width
      // and height both, so narrow side margins or headers and footers
      // can't push its bottom onto another sheet.
      for (const canvas of view.canvases()) {
        expect(printValue(rules, canvas, "width"), which).toBe("auto");
        expect(printValue(rules, canvas, "height"), which).toBe("auto");
        expect(printValue(rules, canvas, "max-width"), which).toBe("100%");
        expect(printValue(rules, canvas, "max-height"), which).toMatch(/\b100vh\b/);
      }
    }
    expectOnlyThePagesPrint(plain, "without :has()");
    expectOnlyThePagesPrint(all, "with :has()");

    // Should the marks ever be missing, a browser with :has() still keeps
    // everything beside the pages off the paper.
    const marks = [document.documentElement, ...document.querySelectorAll("[data-print-path]")];
    document.documentElement.removeAttribute("data-print-filled-form");
    document.querySelectorAll("[data-print-path]").forEach((holder) => holder.removeAttribute("data-print-path"));
    for (const element of beside) {
      expect(hiddenBy(all)(element), `with :has(), no marks: ${name(element)}`).toBe(true);
    }
    for (const element of [...line, ...onPaper.querySelectorAll("*")]) {
      expect(hiddenBy(all)(element), `with :has(), no marks: ${name(element)}`).toBe(false);
    }
    document.documentElement.setAttribute("data-print-filled-form", "");
    marks.slice(1).forEach((holder) => holder.setAttribute("data-print-path", ""));

    // The marks go with the pages.
    header.remove();
    footer.remove();
    await view.unmount();
    expectNoPrintMarks();
  }, 60_000);

  it("lets go of the pages the moment the page is left for another site, so Back never shows them", async () => {
    // A browser can keep a page it leaves and show it again on Back, for
    // the next person at a shared computer. pagehide comes just before
    // that, and React may not render again until the page comes back, so
    // the canvases go at once.
    const view = await results();
    await view.show();
    await view.waitFor(() => view.canvases().length === 21, "the pages");
    const shown = view.canvases();
    const saveButton = view.downloadButton()!;
    await view.act(async () => {
      window.dispatchEvent(new Event("pagehide"));
      expectReleased(shown);
      expectWiped(filledBytes[0]);
      // A page brought back from that cache can still show its old screen
      // for a moment before React renders again. A press of Download a
      // copy then has nothing to save: the bytes are wiped, so it saves no
      // file of zeros and says nothing about a copy.
      expect(saveButton.isConnected).toBe(true);
      saveButton.click();
    });
    expectNothingSaved();
    expect(view.status()).not.toContain(view.copy.downloaded);
    expect(view.container.querySelector("[data-print-preview]")).toBeNull();
    expect(view.status()).not.toContain(view.copy.ready);
    expectNoPrintMarks();

    // Back from that cache, the form can be shown again.
    window.dispatchEvent(new Event("pageshow"));
    await view.show();
    await view.waitFor(() => view.canvases().length === 21, "the pages again");
    expectNothingSaved();
    await view.unmount();
  }, 60_000);

  it("never shows pages from a drawing still running when the page was left", async () => {
    const view = await results();
    const gate = Promise.withResolvers<void>();
    pdfjs.drawGate = gate.promise;
    await view.show();
    await view.waitFor(() => pdfjs.drawnOn.length > 0, "the drawing to start");
    await view.act(async () => {
      window.dispatchEvent(new Event("pagehide"));
    });
    // The page comes back from the cache and the drawing carries on to the end.
    pdfjs.drawGate = null;
    await view.act(async () => {
      gate.resolve();
    });
    await view.waitFor(() => view.showButton().getAttribute("aria-disabled") === null, "the drawing to end");
    expect(pdfjs.drawnOn).toHaveLength(21);
    expect(view.container.querySelector("[data-print-preview]")).toBeNull();
    expectReleased(pdfjs.drawnOn);
    expectWiped(filledBytes[0]);
    expect(view.status()).toBe("");
    expectNothingSaved();
    await view.unmount();
  }, 60_000);

  it("lets go of pages drawn just as an answer changes or the page is left, though they never reach the screen", async () => {
    // React puts drawn pages on screen on a later render. A keypress in the
    // review, or leaving the page, can land after the drawing finishes and
    // before that render, so the pages are dropped before they ever show.
    // They are let go of all the same, their canvases released and their
    // bytes wiped, and on leaving at once, before the browser puts the page
    // away. React schedules its renders here as it does in a browser.
    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    for (const between of ["a keypress in the review", "leaving the page"] as const) {
      vi.resetModules();
      mockPdfJs();
      mockFill();
      let finishDrawing: ((preview: unknown) => void) | null = null;
      let releases = 0;
      vi.doMock("../../lib/intake/device-print", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../../lib/intake/device-print")>()),
        renderPrintPreview: () =>
          new Promise((resolve) => {
            finishDrawing = resolve;
          }),
      }));
      const React = await import("react");
      const { createRoot } = await import("react-dom/client");
      const { DeviceResults } = await import("./device-results");
      const { EMPTY_CLIENT_ANSWERS, saveClientAnswer } = await import("../../lib/intake/client-store");
      const answers = saveClientAnswer(EMPTY_CLIENT_ANSWERS, {
        questionId: "state",
        status: "known",
        provenance: "user_supplied",
        value: "NC",
      });
      function Page() {
        const [values, setValues] = React.useState<Readonly<Record<string, string>>>({});
        return React.createElement(DeviceResults, {
          answers,
          typedAnswers: {
            values,
            onChange: (fieldName: string, value: string) => setValues((previous) => ({ ...previous, [fieldName]: value })),
          },
        });
      }
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const { act } = React;
      await act(async () => {
        root.render(React.createElement(Page));
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-action="show-form"]')!.click();
      });
      for (let i = 0; i < 400 && finishDrawing === null; i += 1) {
        await act(async () => {
          await new Promise((done) => setTimeout(done, 10));
        });
      }
      expect(finishDrawing, `${between}: the drawing started`).not.toBeNull();
      const input = container.querySelector<HTMLInputElement>("[data-review-fields] input")!;
      const canvas = document.createElement("canvas");
      const preview = {
        pages: [{ pageNumber: 1, pageCount: 1, label: "Page 1 of 1, filled application", canvas }],
        release: () => {
          releases += 1;
        },
      };

      actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
      const announced: number[] = [];
      const timers = vi.spyOn(globalThis, "setTimeout");
      try {
        finishDrawing!(preview);
        // The page hands the pages to React (and announces them, a 30 ms
        // timer), but React hasn't rendered them yet.
        for (let i = 0; i < 20; i += 1) {
          await Promise.resolve();
        }
        announced.push(...timers.mock.calls.map((call) => Number(call[1])));
        expect(announced, `${between}: the pages were handed over`).toContain(30);
        expect(releases, `${between}: nothing let go of yet`).toBe(0);
        expect(container.querySelector("[data-print-preview]"), between).toBeNull();
        if (between === "leaving the page") {
          window.dispatchEvent(new Event("pagehide"));
          // At once, with no render.
          expect(releases, between).toBeGreaterThan(0);
          expectWiped(filledBytes.at(-1));
        } else {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "A");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        await new Promise((done) => setTimeout(done, 150));
      } finally {
        timers.mockRestore();
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
      }
      expect(container.querySelector("[data-print-preview]"), between).toBeNull();
      expect(canvas.isConnected, between).toBe(false);
      expect(releases, between).toBeGreaterThan(0);
      expectWiped(filledBytes.at(-1));
      await act(async () => root.unmount());
      container.remove();
      vi.doUnmock("../../lib/intake/device-print");
    }
    expectNothingSaved();
  }, 60_000);

  it("says how to print when the browser ignores Print, and takes it back if printing starts after all", async () => {
    // Some in-app browsers ignore window.print(). A button that silently
    // did nothing would leave the person guessing, so the page says what
    // else to do.
    printOpens = false;
    const view = await results();
    await view.show();
    await view.waitFor(() => view.canvases().length === 21, "the pages");
    const print = view.container.querySelector<HTMLButtonElement>('[data-action="print"]')!;
    await view.act(async () => {
      print.click();
    });
    expect(printed).toBe(1);
    // The browser gets a moment to start printing first.
    expect(view.status()).not.toBe(view.copy.printUnavailable);
    await view.waitFor(() => view.status() === view.copy.printUnavailable, "the print notice");
    expect(view.copy.printUnavailable).toContain("open this page in a browser such as Safari or Chrome");
    expect(view.copy.printUnavailable).toContain("Answers saved in this browser don't move to another one");
    expect(view.copy.printUnavailable).toContain("Or try Download a copy, and print the file from another app");
    // A browser that ignores Print may drop a downloaded file too, so the
    // way that works in any case comes first.
    expect(view.copy.printUnavailable.indexOf("Safari or Chrome")).toBeLessThan(
      view.copy.printUnavailable.indexOf("Download a copy"),
    );
    // Printing that starts late takes the notice back.
    await view.act(async () => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(view.status()).toBe("");

    // A browser that prints never shows it.
    printOpens = true;
    await view.act(async () => {
      print.click();
      await new Promise((done) => setTimeout(done, view.printCheckMs + 200));
    });
    expect(printed).toBe(2);
    expect(view.status()).not.toBe(view.copy.printUnavailable);
    expectNothingSaved();
    await view.unmount();
  }, 60_000);
});

/**
 * The end of /intake on its own, for a synthetic person who has answered
 * one question, with ways to show the filled form and read the screen.
 */
async function results() {
  vi.resetModules();
  mockPdfJs();
  mockFill();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { DEVICE_RESULTS_COPY, DeviceResults, PRINT_CHECK_MS } = await import("./device-results");
  const { EMPTY_CLIENT_ANSWERS, saveClientAnswer } = await import("../../lib/intake/client-store");
  const answers = saveClientAnswer(EMPTY_CLIENT_ANSWERS, {
    questionId: "state",
    status: "known",
    provenance: "user_supplied",
    value: "NC",
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const { act } = React;
  await act(async () => {
    root.render(
      React.createElement(DeviceResults, { answers, typedAnswers: { values: {}, onChange: () => undefined } }),
    );
  });
  const showButton = () => container.querySelector<HTMLButtonElement>('[data-action="show-form"]')!;
  return {
    container,
    act,
    copy: DEVICE_RESULTS_COPY,
    printCheckMs: PRINT_CHECK_MS,
    showButton,
    async show() {
      await act(async () => {
        showButton().click();
      });
    },
    async waitFor(check: () => boolean, what: string) {
      for (let i = 0; i < 400 && !check(); i += 1) {
        await act(async () => {
          await new Promise((done) => setTimeout(done, 10));
        });
      }
      if (!check()) {
        throw new Error(`timed out waiting for ${what}`);
      }
    },
    canvases: () => [...container.querySelectorAll<HTMLCanvasElement>("[data-print-page] canvas")],
    downloadButton: () => container.querySelector<HTMLButtonElement>('[data-action="download-copy"]'),
    status: () => container.querySelector(STATUS_LINE)?.textContent ?? "",
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}
