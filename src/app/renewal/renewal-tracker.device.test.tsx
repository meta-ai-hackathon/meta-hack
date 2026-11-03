// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { addDays, deviceToday, formatIsoDate } from "../../lib/renewal/calendar-date";
import { CALENDAR_FILE_TYPE } from "../../lib/renewal/download";
import { AGE_ANSWERS, type AgeAnswerValue } from "../../lib/renewal/estimate";
import { RENEWAL_CALENDAR_FILENAME } from "../../lib/renewal/reminder-calendar";

// The renewal tracker's request to keep this site's storage (HACK-50,
// following HACK-113's rule), driven through the DOM. Saving asks the
// browser to keep the saved date, and some browsers, Firefox among them,
// answer with a permission prompt. So the page says first, by the save
// button and as its description, that the browser may ask and what saying
// yes does. It asks only once a date is saved, at most once a visit (the
// note goes once it has), and never when it can't save a reminder at all.
//
// The calendar file download is gated (calendar-file-gate.ts, HACK-50
// review) until a person records whether a plaintext calendar file is
// allowed, so every test here renders the tracker with the download off,
// as the page ships, and with it on, as it was before the gate.

type Handler = ((event: unknown) => void) | null;

/** A small IndexedDB stand-in that follows the event contract (see src/lib/device-kv.test.ts). */
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

/** Any line that would point to a calendar file. */
const CALENDAR_FILE_MENTION = /calendar|\.ics\b/i;

const REVOKE_OBJECT_URL = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
const CREATE_OBJECT_URL = Object.getOwnPropertyDescriptor(URL, "createObjectURL");

let device: ReturnType<typeof fakeIndexedDb>;
let persist: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;
/** Stands in for the blob: URL the download makes (jsdom has none). */
let createObjectURL: Mock<(blob: Blob) => string>;
/** The file names of the download links clicked, which the browser would save. */
let handedOver: string[];

/** Records a download link's click and keeps jsdom from trying to follow it. */
function catchDownload(event: Event) {
  const link = event.target;
  if (link instanceof HTMLAnchorElement && link.hasAttribute("download")) {
    event.preventDefault();
    handedOver.push(link.download);
  }
}

beforeAll(() => {
  // The download revokes its blob: URL ten seconds after the click, which
  // can land in a later test, so this stays in place for the whole file.
  Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true, writable: true });
});

afterAll(() => {
  for (const [name, descriptor] of [
    ["revokeObjectURL", REVOKE_OBJECT_URL],
    ["createObjectURL", CREATE_OBJECT_URL],
  ] as const) {
    if (descriptor) {
      Object.defineProperty(URL, name, descriptor);
    } else {
      Reflect.deleteProperty(URL, name);
    }
  }
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  device = fakeIndexedDb();
  persist = vi.fn(async () => true);
  fetchSpy = vi.fn(() => Promise.reject(new Error("the tracker never makes a request")));
  createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:renewal-test");
  handedOver = [];
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("indexedDB", device.factory);
  vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true, writable: true });
  Object.defineProperty(navigator, "storage", { value: { persist }, configurable: true });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.addEventListener("click", catchDownload, true);
});

afterEach(() => {
  document.removeEventListener("click", catchDownload, true);
  Reflect.deleteProperty(navigator, "storage");
  vi.unstubAllGlobals();
  vi.doUnmock("../../lib/renewal/reminder-calendar");
  vi.resetModules();
  document.body.replaceChildren();
});

/**
 * Load the tracker's modules as a fresh visit: new modules, so no storage
 * connection is cached between visits. The calendar builder is wrapped so
 * a test can see whether the file was ever built.
 */
async function loadTracker() {
  vi.resetModules();
  const built = vi.fn();
  vi.doMock("../../lib/renewal/reminder-calendar", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../lib/renewal/reminder-calendar")>();
    return {
      ...actual,
      buildReminderCalendar: (input: Parameters<typeof actual.buildReminderCalendar>[0]) => {
        built(input);
        return actual.buildReminderCalendar(input);
      },
    };
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RenewalTracker } = await import("./renewal-tracker");
  const { PILOT_RENEWAL_FACTS } = await import("../../lib/renewal/renewal-facts");
  const copy = await import("../../lib/renewal/copy");
  const { act } = React;
  async function settle() {
    await act(async () => {
      for (let i = 0; i < 30; i += 1) {
        await new Promise((done) => setTimeout(done, 0));
      }
    });
  }

  /** Mount the tracker with the calendar file download on or off. */
  async function mount(calendarFileDownload: boolean) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(RenewalTracker, { facts: PILOT_RENEWAL_FACTS, calendarFileDownload }));
    });
    await settle();
    const text = () => container.textContent ?? "";
    const button = (label: string) =>
      [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
    const click = async (element: HTMLElement) => {
      await act(async () => {
        element.click();
      });
      await settle();
    };
    /** Type a date into the date field, as a person would. */
    const typeDate = async (date: string) => {
      const input = container.querySelector<HTMLInputElement>("#renewal-date");
      if (!input) {
        throw new Error(`no date field in: ${text()}`);
      }
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, date);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();
    };
    /** Pick a due date from a renewal letter and type the date, as a person would. */
    const enterDueDate = async (date: string) => {
      const kind = container.querySelector<HTMLInputElement>("#renewal-kind-renewal_due");
      if (!kind) {
        throw new Error(`no date choice in: ${text()}`);
      }
      await click(kind);
      await typeDate(date);
    };
    const status = () => container.querySelector('[role="status"]')?.textContent ?? "";
    const unmount = async () => {
      await act(async () => root.unmount());
      container.remove();
    };
    return {
      text,
      button,
      click,
      typeDate,
      enterDueDate,
      status,
      unmount,
      copy,
      lines: copy.calendarFileLines(calendarFileDownload),
      container,
      built,
    };
  }

  return { mount, copy, built, facts: PILOT_RENEWAL_FACTS };
}

/** Load the tracker as a fresh visit and mount it. */
async function visit(calendarFileDownload: boolean) {
  return (await loadTracker()).mount(calendarFileDownload);
}

describe.each([
  { download: "off", calendarFileDownload: false },
  { download: "on", calendarFileDownload: true },
])("asking the browser to keep the saved date (calendar file download $download)", ({ calendarFileDownload }) => {
  it("says beforehand that the browser may ask, asks once the date is saved, and only once a visit", async () => {
    const page = await visit(calendarFileDownload);
    const save = page.button(page.copy.SAVE_BUTTON);
    expect(save).toBeDefined();
    // The note is on screen before the press, and is the save button's description.
    const note = document.getElementById(save!.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe(page.copy.KEEP_PROMPT_NOTE);
    await page.enterDueDate("2027-04-30");
    expect(persist).not.toHaveBeenCalled();

    await page.click(page.button(page.copy.SAVE_BUTTON)!);
    expect(page.status()).toBe(page.lines.savedNotice("renewal_due"));
    expect(device.stores.get("kv")?.has("renewal-reminder")).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);

    // Changing the date and saving again on this visit doesn't ask again,
    // so the note that says it may is gone from the form.
    await page.click(page.button(page.copy.CHANGE_BUTTON)!);
    await page.enterDueDate("2027-05-31");
    expect(page.text()).not.toContain(page.copy.KEEP_PROMPT_NOTE);
    expect(page.button(page.copy.SAVE_BUTTON)!.hasAttribute("aria-describedby")).toBe(false);
    await page.click(page.button(page.copy.SAVE_BUTTON)!);
    expect(page.status()).toBe(page.lines.savedNotice("renewal_due"));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await page.unmount();
  });

  it("doesn't ask when the form doesn't save", async () => {
    const page = await visit(calendarFileDownload);
    // No kind of date chosen: the form says so and saves nothing.
    await page.click(page.button(page.copy.SAVE_BUTTON)!);
    expect(page.text()).toContain(page.copy.ERROR_CHOOSE_KIND);
    expect(device.stores.get("kv")?.has("renewal-reminder") ?? false).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    await page.unmount();
  });
});

describe("asking the browser to keep the saved date where it can't save a reminder", () => {
  it("neither asks nor says it might, and the form still offers the calendar file while the download is on", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const page = await visit(true);
    expect(page.text()).toContain(page.copy.STORAGE_UNAVAILABLE_NOTE);
    expect(page.text()).not.toContain(page.copy.KEEP_PROMPT_NOTE);
    expect(page.button(page.copy.SAVE_BUTTON)).toBeUndefined();
    await page.enterDueDate("2027-04-30");
    expect(page.text()).not.toContain(page.copy.KEEP_PROMPT_NOTE);
    expect(page.button(page.copy.DOWNLOAD_BUTTON)).toBeDefined();
    expect(persist).not.toHaveBeenCalled();
    await page.unmount();
  });

  it("neither asks nor says it might, and shows no form while the download is off, since it could neither save nor offer a file", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const page = await visit(false);
    expect(page.text()).toContain(page.lines.storageUnavailableNote);
    expect(page.text()).not.toContain(page.copy.KEEP_PROMPT_NOTE);
    expect(page.button(page.copy.SAVE_BUTTON)).toBeUndefined();
    expect(page.container.querySelector("[data-renewal-form]")).toBeNull();
    expect(page.text()).not.toMatch(CALENDAR_FILE_MENTION);
    expect(persist).not.toHaveBeenCalled();
    await page.unmount();
  });
});

/**
 * What a person can do on the tracker, in any order. "fill and save" is
 * choosing a kind of date, typing one, and pressing save in one go, so
 * that about half the runs reach a saved date and its summary, where
 * single steps alone rarely would.
 */
type Step =
  | { readonly kind: "choose"; readonly value: "renewal_due" | "approval" | "unknown" }
  | { readonly kind: "type date"; readonly daysFromToday: number }
  | { readonly kind: "answer age"; readonly value: AgeAnswerValue }
  | { readonly kind: "press"; readonly control: "save" | "change" | "keep" | "remove" | "download" }
  | { readonly kind: "fill and save"; readonly value: "renewal_due" | "approval"; readonly daysFromToday: number };

const daysFromToday = fc.integer({ min: -400, max: 400 });

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant("fill and save" as const),
      value: fc.constantFrom("renewal_due" as const, "approval" as const),
      daysFromToday,
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant("choose" as const),
      value: fc.constantFrom("renewal_due" as const, "approval" as const, "unknown" as const),
    }),
    weight: 1,
  },
  { arbitrary: fc.record({ kind: fc.constant("type date" as const), daysFromToday }), weight: 1 },
  { arbitrary: fc.record({ kind: fc.constant("answer age" as const), value: fc.constantFrom(...AGE_ANSWERS) }), weight: 1 },
  {
    arbitrary: fc.record({
      kind: fc.constant("press" as const),
      control: fc.constantFrom("save" as const, "change" as const, "keep" as const, "remove" as const, "download" as const),
    }),
    weight: 3,
  },
);

describe("the calendar file download stays behind its gate (HACK-50 review)", () => {
  it.each([
    { download: "off", calendarFileDownload: false },
    { download: "on", calendarFileDownload: true },
  ])(
    "download $download: any sequence of steps shows the download control only where it was before the gate and only with the download on, and saving and the in-app reminder work either way (property)",
    async ({ calendarFileDownload }) => {
      const app = await loadTracker();
      const labels = {
        save: app.copy.SAVE_BUTTON,
        change: app.copy.CHANGE_BUTTON,
        keep: app.copy.KEEP_SAVED_BUTTON,
        remove: app.copy.REMOVE_BUTTON,
        download: app.copy.DOWNLOAD_BUTTON,
      };
      // Runs that reached a saved date's summary, so the property is not vacuous.
      let summaries = 0;
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), async (steps) => {
          // A fresh device for each run; the module's storage connection is reused.
          device.stores.get("kv")?.clear();
          app.built.mockClear();
          createObjectURL.mockClear();
          handedOver = [];
          const page = await app.mount(calendarFileDownload);
          const choose = async (id: string) => {
            const choice = page.container.querySelector<HTMLInputElement>(`#${id}`);
            if (choice) {
              await page.click(choice);
            }
          };
          const typeDate = async (days: number) => {
            if (page.container.querySelector("#renewal-date")) {
              await page.typeDate(formatIsoDate(addDays(deviceToday(), days)));
            }
          };
          const press = async (control: keyof typeof labels) => {
            const found = page.button(labels[control]);
            if (found) {
              await page.click(found);
            }
          };
          let sawSummary = false;
          try {
            for (const next of steps) {
              switch (next.kind) {
                case "choose":
                  await choose(`renewal-kind-${next.value}`);
                  break;
                case "answer age":
                  await choose(`renewal-age-${next.value}`);
                  break;
                case "type date":
                  await typeDate(next.daysFromToday);
                  break;
                case "press":
                  await press(next.control);
                  break;
                case "fill and save":
                  await choose(`renewal-kind-${next.value}`);
                  await typeDate(next.daysFromToday);
                  await press("save");
                  break;
              }
              const summary = page.container.querySelector("[data-renewal-reported]");
              const dateField = page.container.querySelector("#renewal-date") !== null;
              // Before the gate the form offered the file beside the date
              // field and the summary under the saved date; now only with
              // the download on.
              expect(page.button(labels.download) !== undefined).toBe(calendarFileDownload && (summary !== null || dateField));
              if (!calendarFileDownload) {
                expect(page.text()).not.toMatch(CALENDAR_FILE_MENTION);
                expect(app.built).not.toHaveBeenCalled();
                expect(createObjectURL).not.toHaveBeenCalled();
                expect(handedOver).toEqual([]);
              }
              if (summary !== null) {
                sawSummary = true;
                // A saved date's summary means its sealed reminder is on
                // the device, and a due date always gets its reminder line.
                expect(device.stores.get("kv")?.has("renewal-reminder")).toBe(true);
                if (summary.getAttribute("data-renewal-reported") === "renewal_due") {
                  expect(page.container.querySelector("[data-reminder-phase]")).not.toBeNull();
                }
              }
            }
          } finally {
            summaries += sawSummary ? 1 : 0;
            await page.unmount();
          }
        }),
        { numRuns: 20 },
      );
      // About half the runs save a date; none doing so would mean the
      // steps above stopped reaching the summary at all.
      expect(summaries).toBeGreaterThan(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
    60_000,
  );

  it("while it is off, a saved date still gets its in-app reminder, and the banner on other pages reads it", async () => {
    const app = await loadTracker();
    const page = await app.mount(false);
    expect(page.text()).toContain(app.copy.LINES_WITHOUT_CALENDAR_FILE.noDateIntro);
    expect(page.text()).toContain(app.copy.LINES_WITHOUT_CALENDAR_FILE.privacyNote);
    expect(page.text()).toContain(app.copy.LINES_WITHOUT_CALENDAR_FILE.browserCanClearNote);
    const today = deviceToday();
    const due = addDays(today, 10);
    await page.enterDueDate(formatIsoDate(due));
    expect(page.button(app.copy.DOWNLOAD_BUTTON)).toBeUndefined();
    await page.click(page.button(app.copy.SAVE_BUTTON)!);
    expect(page.status()).toBe(app.copy.LINES_WITHOUT_CALENDAR_FILE.savedNotice("renewal_due"));
    expect(page.button(app.copy.DOWNLOAD_BUTTON)).toBeUndefined();

    // The tracker's own reminder line, 10 days out.
    const { reminderStatus } = await import("../../lib/renewal/reminder");
    const status = reminderStatus(today, [due])!;
    expect(status.phase).toBe("soon");
    expect(page.container.querySelector('[data-reminder-phase="soon"]')?.textContent).toContain(
      app.copy.reminderMessage(status, false),
    );

    // The banner reads the reminder this tracker saved, as it does with the
    // download on, and says it on any other page.
    const { readBannerState } = await import("../../components/renewal-reminder-banner");
    const { openDeviceReminderStore } = await import("../../lib/renewal/device-kv");
    const { bannerFacts } = await import("../../lib/renewal/renewal-facts");
    const deps = await openDeviceReminderStore();
    expect(deps).not.toBeNull();
    expect(await readBannerState(deps!, bannerFacts(app.facts), today)).toEqual({
      phase: "soon",
      message: app.copy.bannerMessage(status, false),
    });
    expect(page.text()).not.toMatch(CALENDAR_FILE_MENTION);
    expect(app.built).not.toHaveBeenCalled();
    expect(createObjectURL).not.toHaveBeenCalled();
    await page.unmount();
  });

  it("while it is on, the form and the saved date's summary offer the file and hand it over, as before the gate", async () => {
    const page = await visit(true);
    expect(page.text()).toContain(page.copy.NO_DATE_INTRO);
    expect(page.text()).toContain(page.copy.PRIVACY_NOTE);
    expect(page.text()).toContain(page.copy.BROWSER_CAN_CLEAR_NOTE);
    await page.enterDueDate("2027-04-30");
    await page.click(page.button(page.copy.DOWNLOAD_BUTTON)!);
    expect(page.status()).toBe(page.copy.DOWNLOADED_NOTICE);
    expect(page.built).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0]![0].type).toBe(CALENDAR_FILE_TYPE);
    expect(handedOver).toEqual([RENEWAL_CALENDAR_FILENAME]);

    await page.click(page.button(page.copy.SAVE_BUTTON)!);
    expect(page.status()).toBe(page.copy.savedNotice("renewal_due"));
    await page.click(page.button(page.copy.DOWNLOAD_BUTTON)!);
    expect(page.status()).toBe(page.copy.DOWNLOADED_NOTICE);
    expect(page.built).toHaveBeenCalledTimes(2);
    expect(handedOver).toEqual([RENEWAL_CALENDAR_FILENAME, RENEWAL_CALENDAR_FILENAME]);
    expect(fetchSpy).not.toHaveBeenCalled();
    await page.unmount();
  });
});
