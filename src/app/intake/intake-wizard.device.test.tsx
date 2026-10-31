// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The wizard in device mode (HACK-99), driven through the DOM: what the
// person sees, clicks, and hears. The answer path never makes a request;
// a reload resumes; a double-click can't answer a question the person never
// saw; the delete flow keeps focus and says what happened; "Save and finish
// later" saves the answer on screen; and a delete in another tab shows up
// when the page comes back into view.

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

let device: ReturnType<typeof fakeIndexedDb>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  device = fakeIndexedDb();
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network on the device path")));
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubGlobal("indexedDB", device.factory);
  vi.stubGlobal("crypto", webcrypto);
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

/** Load the page as a fresh visit: new modules, so nothing is cached between visits. */
async function visit() {
  vi.resetModules();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { IntakeWizard } = await import("./intake-wizard");
  const { DEVICE_INTAKE_COPY } = await import("../../lib/intake/device-intake");
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
    const Wizard = IntakeWizard as (props: { persistence?: "server" | "device" }) => ReturnType<typeof IntakeWizard>;
    root.render(React.createElement(Wizard, { persistence: "device" }));
  });
  await settle();
  const text = () => container.textContent ?? "";
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!found) {
      throw new Error(`no button "${label}" in: ${text()}`);
    }
    return found;
  };
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
    });
    await settle();
  };
  const choose = async (label: string) => {
    const option = [...container.querySelectorAll<HTMLInputElement>("input[type=radio]")].find(
      (input) => input.closest("label")?.textContent?.trim() === label,
    );
    if (!option) {
      throw new Error(`no option "${label}"`);
    }
    await click(option);
  };
  const status = () => container.querySelector('[role="status"]')?.textContent ?? "";
  const question = () => container.querySelector("legend")?.textContent ?? "";
  const checked = (label: string) =>
    [...container.querySelectorAll<HTMLInputElement>("input[type=radio]")].find(
      (input) => input.closest("label")?.textContent?.trim() === label,
    )?.checked ?? false;
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return {
    act,
    settle,
    text,
    button,
    click,
    choose,
    status,
    question,
    checked,
    unmount,
    copy: DEVICE_INTAKE_COPY,
    container,
  };
}

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("the wizard in device mode", () => {
  it("keeps answers on the device, resumes on the next visit, and never makes a request", async () => {
    const page = await visit();
    expect(page.text()).toContain(page.copy.keptBlurb);
    await page.choose("Me");
    await page.click(page.button("Continue"));
    expect(page.status()).toBe("Saved on this device. 1 of 37 answered.");
    expect(page.text()).toContain("Answered 1 of 37");
    expect(device.stores.get("kv")?.has("intake-answers")).toBe(true);
    await page.unmount();

    const again = await visit();
    expect(again.status()).toBe(again.copy.resumedOnLoad);
    expect(again.text()).toContain("Answered 1 of 37");
    expect(fetchSpy).not.toHaveBeenCalled();
    await again.unmount();
  });

  it("ignores the second click of a double-click, so it can't answer the next question", async () => {
    const page = await visit();
    await page.choose("Me");
    await page.click(page.button("Continue"));
    // The double-click's second click lands on the next question's buttons.
    await page.click(page.button("I'm not sure"));
    expect(page.text()).toContain("Answered 1 of 37");
    await pause(450);
    await page.click(page.button("I'm not sure"));
    expect(page.text()).toContain("Answered 2 of");
    await page.unmount();
  });

  it("keeps focus inside the delete flow and says what happened", async () => {
    const page = await visit();
    await page.choose("Me");
    await page.click(page.button("Continue"));
    await page.click(page.button(page.copy.deleteButton));
    expect(document.activeElement?.textContent).toBe(page.copy.deleteNo);
    expect(page.text()).toContain(page.copy.deleteConfirm);
    await page.click(page.button(page.copy.deleteYes));
    expect(page.status()).toBe(page.copy.deleted);
    expect(page.text()).toContain("Answered 0 of 37");
    expect(document.activeElement?.tagName).toBe("INPUT");
    expect(device.stores.get("kv")?.size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    await page.unmount();
  });

  it("returns focus to the delete button when the confirmation is cancelled", async () => {
    const page = await visit();
    await page.choose("Me");
    await page.click(page.button("Continue"));
    await page.click(page.button(page.copy.deleteButton));
    expect(document.activeElement?.textContent).toBe(page.copy.deleteNo);
    await page.click(page.button(page.copy.deleteNo));
    expect(page.text()).not.toContain(page.copy.deleteConfirm);
    expect(document.activeElement?.textContent).toBe(page.copy.deleteButton);
    expect(device.stores.get("kv")?.has("intake-answers")).toBe(true);
    await page.unmount();
  });

  it("'Save and finish later' saves the answer on screen before saying it's saved", async () => {
    const page = await visit();
    expect(page.question()).toContain("Who is this application for?");
    await page.choose("A family member");
    await page.click(page.button("Save and finish later"));
    expect(page.status()).toBe(page.copy.savedForLaterKept);
    expect(page.text()).toContain("Answered 1 of");
    // It saves in place: the person stays on the question they were on.
    expect(page.question()).toContain("Who is this application for?");
    expect(page.checked("A family member")).toBe(true);
    await page.unmount();
    const again = await visit();
    expect(again.text()).toContain("Answered 1 of");
    await again.unmount();
  });

  it("shows a delete made in another tab when the page comes back into view", async () => {
    const page = await visit();
    await page.choose("Me");
    await page.click(page.button("Continue"));
    // Another tab deletes everything on this device.
    device.stores.get("kv")?.clear();
    await page.act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await page.settle();
    expect(page.status()).toBe(page.copy.purgedElsewhere);
    expect(page.text()).toContain("Answered 0 of 37");
    await page.click(page.button("Save and finish later"));
    expect(page.status()).toBe(page.copy.savedForLaterKept);
    expect(page.text()).toContain("Answered 0 of 37");
    await page.unmount();
  });

  it("works in memory and says so when the browser can't store anything", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const page = await visit();
    expect(page.status()).toBe(page.copy.unsupportedOnLoad);
    expect(page.text()).toContain(page.copy.unsupportedBlurb);
    await page.choose("Me");
    await page.click(page.button("Continue"));
    expect(page.status()).toMatch(/can't save answers/);
    expect(fetchSpy).not.toHaveBeenCalled();
    await page.unmount();
  });
});
