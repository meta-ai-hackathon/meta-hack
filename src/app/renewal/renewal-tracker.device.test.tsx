// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The renewal tracker's request to keep this site's storage (HACK-50,
// following HACK-113's rule), driven through the DOM. Saving asks the
// browser to keep the saved date, and some browsers, Firefox among them,
// answer with a permission prompt. So the page says first, by the save
// button and as its description, that the browser may ask and what saying
// yes does. It asks only once a date is saved, at most once a visit, and
// never when it can't save a reminder at all.

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

let device: ReturnType<typeof fakeIndexedDb>;
let persist: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  device = fakeIndexedDb();
  persist = vi.fn(async () => true);
  fetchSpy = vi.fn(() => Promise.reject(new Error("the tracker never makes a request")));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("indexedDB", device.factory);
  vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(navigator, "storage", { value: { persist }, configurable: true });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, "storage");
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

/** Load the tracker as a fresh visit: new modules, so no storage connection is cached between visits. */
async function visit() {
  vi.resetModules();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RenewalTracker } = await import("./renewal-tracker");
  const { PILOT_RENEWAL_FACTS } = await import("../../lib/renewal/renewal-facts");
  const copy = await import("../../lib/renewal/copy");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const { act } = React;
  async function settle() {
    await act(async () => {
      for (let i = 0; i < 30; i += 1) {
        await new Promise((done) => setTimeout(done, 0));
      }
    });
  }
  await act(async () => {
    root.render(React.createElement(RenewalTracker, { facts: PILOT_RENEWAL_FACTS }));
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
  /** Pick a due date from a renewal letter and type the date, as a person would. */
  const enterDueDate = async (date: string) => {
    const kind = container.querySelector<HTMLInputElement>("#renewal-kind-renewal_due");
    if (!kind) {
      throw new Error(`no date choice in: ${text()}`);
    }
    await click(kind);
    const input = container.querySelector<HTMLInputElement>("#renewal-date")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, date);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
  };
  const status = () => container.querySelector('[role="status"]')?.textContent ?? "";
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { text, button, click, enterDueDate, status, unmount, copy, container };
}

describe("asking the browser to keep the saved date", () => {
  it("says beforehand that the browser may ask, asks once the date is saved, and only once a visit", async () => {
    const page = await visit();
    const save = page.button(page.copy.SAVE_BUTTON);
    expect(save).toBeDefined();
    // The note is on screen before the press, and is the save button's description.
    const note = document.getElementById(save!.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe(page.copy.KEEP_PROMPT_NOTE);
    await page.enterDueDate("2027-04-30");
    expect(persist).not.toHaveBeenCalled();

    await page.click(page.button(page.copy.SAVE_BUTTON)!);
    expect(page.status()).toBe(page.copy.savedNotice("renewal_due"));
    expect(device.stores.get("kv")?.has("renewal-reminder")).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);

    // Changing the date and saving again on this visit doesn't ask again.
    await page.click(page.button(page.copy.CHANGE_BUTTON)!);
    await page.enterDueDate("2027-05-31");
    await page.click(page.button(page.copy.SAVE_BUTTON)!);
    expect(page.status()).toBe(page.copy.savedNotice("renewal_due"));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await page.unmount();
  });

  it("doesn't ask when the form doesn't save", async () => {
    const page = await visit();
    // No kind of date chosen: the form says so and saves nothing.
    await page.click(page.button(page.copy.SAVE_BUTTON)!);
    expect(page.text()).toContain(page.copy.ERROR_CHOOSE_KIND);
    expect(device.stores.get("kv")?.has("renewal-reminder") ?? false).toBe(false);
    expect(persist).not.toHaveBeenCalled();
    await page.unmount();
  });

  it("neither asks nor says it might when this browser can't save a reminder", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const page = await visit();
    expect(page.text()).toContain(page.copy.STORAGE_UNAVAILABLE_NOTE);
    expect(page.text()).not.toContain(page.copy.KEEP_PROMPT_NOTE);
    expect(page.button(page.copy.SAVE_BUTTON)).toBeUndefined();
    await page.enterDueDate("2027-04-30");
    expect(page.text()).not.toContain(page.copy.KEEP_PROMPT_NOTE);
    expect(persist).not.toHaveBeenCalled();
    await page.unmount();
  });
});
