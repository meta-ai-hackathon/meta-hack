// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { PDFDocument } from "@cantoo/pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The step-by-step page to the end (HACK-115), driven through the DOM: a
// person answers every question, sees the match and the review of the
// filled form, types the answers the questions don't ask, and downloads the
// filled DHB-5200. Everything is computed in the browser. The only requests
// the page makes are the cookie-only check for answers saved on the server
// before (server-answers-notice.tsx) and the GET for the blank form, and no
// request URL or body carries an answer. A reload resumes from IndexedDB,
// straight back to the review, and the form fills again from the answers
// kept on the device.

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

let device: ReturnType<typeof fakeIndexedDb>;
let requests: { url: string; init?: RequestInit }[];
let downloads: { name: string; blob: Blob }[];
let pendingBlob: Blob | null;
let revoked: string[];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  device = fakeIndexedDb();
  requests = [];
  downloads = [];
  pendingBlob = null;
  revoked = [];
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
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      pendingBlob = blob;
      return "blob:filled-form";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });
  // The browser saves the file; here the click records what it would save.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    if (this.href === "blob:filled-form" && pendingBlob) {
      downloads.push({ name: this.download, blob: pendingBlob });
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Open /intake as a fresh visit: new modules, so nothing is cached between visits. */
async function visit() {
  vi.resetModules();
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
  /** Answer whatever question is on screen, from the persona or with "I'm not sure". */
  async function answerCurrent(): Promise<boolean> {
    const question = container.querySelector<HTMLElement>("[data-intake-question]");
    if (!question) {
      return false;
    }
    const id = question.dataset.intakeQuestion!;
    const answer = PERSONA[id];
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
  async function answerEverything() {
    for (let step = 0; step < 60 && (await answerCurrent()); step += 1) {
      // one question per screen
    }
  }
  async function download() {
    const before = downloads.length;
    const button = container.querySelector<HTMLButtonElement>('[data-action="download"]');
    if (!button) {
      throw new Error("no download button");
    }
    await click(button);
    await waitFor(() => downloads.length > before, "the download");
    await waitFor(() => text().includes(DEVICE_RESULTS_COPY.downloaded), "the announcement");
    const { name, blob } = downloads[downloads.length - 1];
    return { name, form: (await PDFDocument.load(await blobBytes(blob))).getForm() };
  }
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, text, byId, type, waitFor, answerEverything, download, unmount, copy: DEVICE_RESULTS_COPY };
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
  it("shows the match and the review, downloads the filled DHB-5200, and resumes after a reload", async () => {
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

    // The name isn't asked by the questions: it is typed into the review.
    const nameInput = field(NAME_FIELD)?.querySelector<HTMLInputElement>("input");
    expect(nameInput).toBeTruthy();
    await page.type(nameInput!, TYPED_NAME);

    const first = await page.download();
    expect(first.name).toBe("dhb-5200.pdf");
    // The file's URL outlives the click, so a browser that starts the
    // download a moment later still gets it, and then it is let go.
    expect(revoked).toEqual([]);
    await page.waitFor(() => revoked.includes("blob:filled-form"), "the download URL to be revoked");
    expect(first.form.getTextField("3 Date of Birth mmddyyyy").getText()).toBe("07/19/1984");
    expect(first.form.getTextField("14 Phone Number").getText()).toBe("704-555-0142");
    expect(first.form.getTextField("undefined_10").getText()).toBe("1200");
    expect(first.form.getTextField(NAME_FIELD).getText()).toBe(TYPED_NAME);
    // Nothing guessed: what no one answered stays blank, and the page says so.
    expect(first.form.getTextField("5 Social Security Number SSN").getText() ?? "").toBe("");
    expect(page.container.querySelector("[data-left-blank]")?.textContent).toContain("Social Security number");

    // The only requests: the cookie-only check, then the blank form, bodiless and cookieless.
    expect(requests.map((request) => request.url)).toEqual(["/api/intake/state", "/forms/dhb-5200.pdf"]);
    expect(requests[1].init).toEqual({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer" });
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME, "1200", "Quillfeather"]);
    expect(device.stores.get("kv")?.has("intake-answers")).toBe(true);
    await page.unmount();

    // A reload: the answers come back from IndexedDB, straight to the review.
    const again = await visit();
    expect(again.text()).toContain("Welcome back. These are the answers you saved in this browser.");
    expect(again.text()).toContain("All questions answered for now");
    expect(again.container.querySelector("[data-match-card='nc_medicaid']")).not.toBeNull();
    const second = await again.download();
    expect(second.form.getTextField("3 Date of Birth mmddyyyy").getText()).toBe("07/19/1984");
    expect(second.form.getTextField("14 Phone Number").getText()).toBe("704-555-0142");
    // The typed name was for that one download: it isn't kept anywhere.
    expect(second.form.getTextField(NAME_FIELD).getText() ?? "").toBe("");
    expect(requests.map((request) => request.url)).toEqual([
      "/api/intake/state",
      "/forms/dhb-5200.pdf",
      "/api/intake/state",
      "/forms/dhb-5200.pdf",
    ]);
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME, "1200", "Quillfeather"]);
    await again.unmount();
  }, 60_000);

  it("prints both boxes of a check-one line as typed and says to fix them", async () => {
    // The full DHB-5200 mapping (VAL-FIX-007): the fill never picks a side
    // when two boxes of one check-one group are checked. The form shows
    // both, and the page names the question after the download.
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
    const filled = await page.download();
    expect(filled.form.getCheckBox(employed.name).isChecked()).toBe(true);
    expect(filled.form.getCheckBox(selfEmployed.name).isChecked()).toBe(true);
    const flagged = page.container.querySelectorAll("[data-check-conflicts] li");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].getAttribute("data-check-conflict")).toBe("single_choice");
    expect(flagged[0].textContent).toContain(employed.question);
    expect(page.container.querySelector("[data-check-conflicts]")?.textContent).toContain(
      page.copy.conflictsHeading,
    );
    expectNoAnswerInRequests([...PRIVATE_VALUES, "1200", "Quillfeather"]);
    await page.unmount();
  }, 60_000);

  it("after a download, deletes the answers without claiming the downloaded file is gone", async () => {
    const page = await visit();
    await page.answerEverything();
    await page.type(page.container.querySelector<HTMLInputElement>(`[data-review-field="${NAME_FIELD}"] input`)!, TYPED_NAME);
    const filled = await page.download();
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

    // The answers and their key are gone from the browser, and the typed name with the screen.
    expect(device.stores.get("kv")?.has("intake-answers")).toBe(false);
    expect(device.stores.get("kv")?.has("intake-answers-key")).toBe(false);
    expect(page.container.querySelector("[data-device-results]")).toBeNull();
    expect(page.text()).not.toContain(TYPED_NAME);
    // The file already saved to the device is outside the delete, and the page says so.
    expect(downloads).toHaveLength(1);
    expect(DEVICE_INTAKE_COPY.deleted).toContain("downloaded the filled form");
    expect(page.text()).not.toContain("left on this device");
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
    const button = page.container.querySelector<HTMLButtonElement>('[data-action="download"]')!;
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
    expect(downloads).toHaveLength(0);
    expect(requests.at(-1)?.url).toBe("/forms/dhb-5200.pdf");
    expectNoAnswerInRequests([...PRIVATE_VALUES, TYPED_NAME]);
    await page.unmount();
  }, 60_000);
});
