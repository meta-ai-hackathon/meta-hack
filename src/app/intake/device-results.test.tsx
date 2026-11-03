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
// filled DHB-5200 on the page to print it. Everything is computed in the
// browser. The only requests the page makes are the cookie-only check for
// answers saved on the server before (server-answers-notice.tsx) and the
// GET for the blank form, and no request URL or body carries an answer.
// Nothing is saved to the device: no object URL, no download, nothing that
// embeds the PDF, and nothing new in the browser's storage. A reload resumes
// from IndexedDB, straight back to the review, and the form fills again
// from the answers kept on the device.
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
let printed: number;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  device = fakeIndexedDb();
  requests = [];
  saves = [];
  printed = 0;
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
  // show nothing ever did.
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: () => {
      saves.push("createObjectURL");
      return "blob:filled-form";
    },
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    if (this.hasAttribute("download") || this.href.startsWith("blob:")) {
      saves.push(`download ${this.download}`);
    }
  });
  vi.stubGlobal("print", () => {
    printed += 1;
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
  document.body.replaceChildren();
});

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

/** Nothing anywhere on the page could save the filled form or show it as a document. */
function expectNothingSaved() {
  expect(saves).toEqual([]);
  expect(document.querySelectorAll("a[download], iframe, frame, embed, object")).toHaveLength(0);
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
    return { options, form: (await PDFDocument.load(bytes)).getForm(), pages: pages() };
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
    unmount,
    copy: DEVICE_RESULTS_COPY,
  };
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
  it("shows the match, the review, and the filled DHB-5200 to print, saves nothing, and resumes after a reload", async () => {
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
    // number alone, each one canvas at 150 DPI for a Letter page.
    const preview = page.container.querySelector("[data-print-preview]");
    expect(preview?.querySelector("h2")?.textContent).toBe(page.copy.previewHeading);
    expect(first.pages).toHaveLength(21);
    first.pages.forEach(({ frame, canvases }, index) => {
      expect(frame.getAttribute("role")).toBe("img");
      expect(frame.getAttribute("aria-label")).toBe(`Page ${index + 1} of 21, filled application`);
      expect(canvases).toHaveLength(1);
      expect([canvases[0].width, canvases[0].height]).toEqual([1275, 1650]);
    });
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

    // A change to a typed answer drops the pages: they no longer match.
    const shown = first.pages.map(({ canvases }) => canvases[0]);
    await page.type(nameInput!, `${TYPED_NAME} Jr.`);
    expect(page.pages()).toEqual([]);
    expect(page.container.querySelector("[data-print-preview]")).toBeNull();
    expectReleased(shown);

    // The only requests: the cookie-only check, then the blank form, bodiless and cookieless.
    expect(requests.map((request) => request.url)).toEqual(["/api/intake/state", "/forms/dhb-5200.pdf"]);
    expect(requests[1].init).toEqual({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer" });
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME, "1200", "Quillfeather"]);
    expect(device.stores.get("kv")?.has("intake-answers")).toBe(true);

    // Shown again, then the page goes away: its pages go with it.
    const again = await page.showForm();
    await page.unmount();
    expectReleased(again.pages.map(({ canvases }) => canvases[0]));

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
    expectNothingSaved();
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

  it("with the filled form shown, a delete takes its pages too and claims only what it did", async () => {
    const page = await visit();
    await page.answerEverything();
    await page.type(page.container.querySelector<HTMLInputElement>(`[data-review-field="${NAME_FIELD}"] input`)!, TYPED_NAME);
    const filled = await page.showForm();
    expect(filled.form.getTextField(NAME_FIELD).getText()).toBe(TYPED_NAME);

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
    // name and the filled pages with the screen.
    expect(device.stores.get("kv")?.has("intake-answers")).toBe(false);
    expect(device.stores.get("kv")?.has("intake-answers-key")).toBe(false);
    expect(page.container.querySelector("[data-device-results]")).toBeNull();
    expect(page.text()).not.toContain(TYPED_NAME);
    expectReleased(filled.pages.map(({ canvases }) => canvases[0]));
    // Nothing was ever saved to the device, so the confirmation has no
    // file to warn about, and it claims only this browser.
    expectNothingSaved();
    expect(DEVICE_INTAKE_COPY.deleted).not.toMatch(/download|file/i);
    expect(DEVICE_INTAKE_COPY.deleted).toContain("in this browser");
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME, "1200", "Quillfeather"]);
    await page.unmount();
  }, 60_000);

  it("in a browser that can't save, a clear takes the filled pages and says none were kept", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const page = await visit();
    const { DEVICE_INTAKE_COPY } = await import("../../lib/intake/device-intake");
    expect(page.text()).toContain(DEVICE_INTAKE_COPY.unsupportedOnLoad);
    await page.answerEverything();
    await page.type(page.container.querySelector<HTMLInputElement>(`[data-review-field="${NAME_FIELD}"] input`)!, TYPED_NAME);
    const filled = await page.showForm();
    expect(filled.form.getTextField(NAME_FIELD).getText()).toBe(TYPED_NAME);

    await page.click(page.container.querySelector<HTMLButtonElement>("[data-delete-from-device]")!);
    const confirm = [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === DEVICE_INTAKE_COPY.deleteYes,
    )!;
    await page.click(confirm);
    await page.waitFor(() => page.text().includes(DEVICE_INTAKE_COPY.clearedNothingStored), "the clear");
    expect(page.container.querySelector("[data-device-results]")).toBeNull();
    expect(page.text()).not.toContain(TYPED_NAME);
    expectReleased(filled.pages.map(({ canvases }) => canvases[0]));
    expectNothingSaved();
    expect(DEVICE_INTAKE_COPY.clearedNothingStored).not.toMatch(/download|file/i);
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
    expect(page.container.querySelector<HTMLButtonElement>('[data-action="show-form"]')?.disabled).toBe(false);
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
    await page.click(page.container.querySelector<HTMLButtonElement>('[data-action="show-form"]')!);
    await page.waitFor(() => pdfjs.drawnOn.length > 0, "the first page to start drawing");

    // The name changes while the first page draws, and then the drawing finishes.
    await page.type(nameInput, `${TYPED_NAME} Jr.`);
    pdfjs.drawGate = null;
    await page.act(async () => {
      gate.resolve();
    });
    await page.waitFor(
      () => !page.container.querySelector<HTMLButtonElement>('[data-action="show-form"]')?.disabled,
      "the drawing to stop",
    );
    expect(page.pages()).toEqual([]);
    expect(pdfjs.drawnOn).toHaveLength(1);
    expectReleased(pdfjs.drawnOn);
    // Nothing failed: the person changed an answer.
    expect(page.text()).not.toContain(page.copy.failed);
    expect(page.text()).not.toContain(page.copy.ready);

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
    expectNothingSaved();
    await act(async () => root.unmount());
    container.remove();
  }, 60_000);
});
