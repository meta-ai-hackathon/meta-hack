// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUESTIONS } from "../../lib/intake/spec";

// The wizard in device mode (HACK-99), driven through the DOM: what the
// person sees, clicks, and hears. The answer path never makes a request;
// a reload resumes; a double-click can't answer a question the person never
// saw; the delete flow keeps focus and says what happened; "Save and finish
// later" saves the answer on screen, and is the only thing that asks the
// browser to keep its storage; and a delete in another tab shows up when the
// page comes back into view.

// The wizard's honest total is the spec's question count — derived, never
// a literal pinned to one spec generation (the work-questions addition
// grew the spec from 37 to 56; the counter assertions below track the
// spec, which is the stronger pin).
const SPEC_TOTAL = QUESTIONS.length;

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
  /** A mouse or touch press: the pointer goes down on the element, then it clicks. */
  const press = async (element: HTMLElement) => {
    await act(async () => {
      element.dispatchEvent(new Event("pointerdown", { bubbles: true }));
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
    press,
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
    expect(page.status()).toBe(`Saved on this device. 1 of ${SPEC_TOTAL} answered.`);
    expect(page.text()).toContain(`Answered 1 of ${SPEC_TOTAL}`);
    expect(device.stores.get("kv")?.has("intake-answers")).toBe(true);
    await page.unmount();

    const again = await visit();
    expect(again.status()).toBe(again.copy.resumedOnLoad);
    expect(again.text()).toContain(`Answered 1 of ${SPEC_TOTAL}`);
    expect(fetchSpy).not.toHaveBeenCalled();
    await again.unmount();
  });

  it("ignores the second click of a double-click, so it can't answer the next question", async () => {
    const page = await visit();
    await page.choose("Me");
    await page.press(page.button("Continue"));
    // The double-click's second press lands on the next question's buttons.
    await page.press(page.button("I'm not sure"));
    expect(page.text()).toContain(`Answered 1 of ${SPEC_TOTAL}`);
    await pause(450);
    await page.press(page.button("I'm not sure"));
    expect(page.text()).toContain("Answered 2 of");
    await page.unmount();
  });

  it("can't start a delete while Save and finish later is still saving", async () => {
    const page = await visit();
    await page.choose("Me");
    // Click without waiting for the save to finish: the first render after
    // the click is what the person can press next.
    page.act(() => {
      page.button("Save and finish later").click();
    });
    const deleteButton = page.button(page.copy.deleteButton);
    expect(deleteButton.disabled).toBe(true);
    await page.settle();
    expect(page.status()).toBe(page.copy.savedForLaterKept);
    expect(page.button(page.copy.deleteButton).disabled).toBe(false);
    await page.unmount();
  });

  it("never holds back a fast keyboard answer right after the screen changes", async () => {
    const page = await visit();
    await page.choose("Me");
    await page.press(page.button("Continue"));
    // Enter on a focused button clicks it with no pointer press first.
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
    expect(page.text()).toContain(`Answered 0 of ${SPEC_TOTAL}`);
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

  it("keeps an answer in progress when another tab's change comes in", async () => {
    const page = await visit();
    // Picked but not saved yet: the person hasn't pressed Continue.
    await page.choose("Me");
    // Another tab saves a different answer on this device.
    const { openIndexedDbKv } = await import("../../lib/device-kv");
    const { recordDeviceAnswer } = await import("../../lib/intake/device-answer-store");
    const otherTab = {
      kv: await openIndexedDbKv(device.factory as unknown as IDBFactory),
      subtle: globalThis.crypto.subtle,
    };
    const saved = await recordDeviceAnswer(
      otherTab,
      { questionId: "main_goal", status: "known", provenance: "user_supplied", value: "food" },
      { expectStored: false },
    );
    expect(saved.status).toBe("saved");
    await page.act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await page.settle();
    expect(page.status()).toBe(page.copy.updatedElsewhere);
    expect(page.question()).toContain("Who is this application for?");
    expect(page.checked("Me")).toBe(true);
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
    expect(page.text()).toContain(`Answered 0 of ${SPEC_TOTAL}`);
    await page.click(page.button("Save and finish later"));
    expect(page.status()).toBe(page.copy.savedForLaterKept);
    expect(page.text()).toContain(`Answered 0 of ${SPEC_TOTAL}`);
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

// Asking the browser to keep this site's storage can show a permission
// prompt (Firefox does), so the page never asks while the person answers.
// It asks once, when they press Save and finish later, and the note by the
// button says so before the press (HACK-113).
describe("asking the browser to keep the answers", () => {
  let persist: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    persist = vi.fn(async () => true);
    Object.defineProperty(navigator, "storage", { value: { persist }, configurable: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "storage");
  });

  it("never asks while answering, says before the press that it may ask, and asks once on Save and finish later", async () => {
    const page = await visit();
    await page.choose("Me");
    await page.click(page.button("Continue"));
    await page.click(page.button("I'm not sure"));
    expect(page.text()).toContain("Answered 2 of");
    expect(persist).not.toHaveBeenCalled();

    // The note is on screen before the press, and is the button's description for screen readers.
    const save = page.button("Save and finish later");
    const note = document.getElementById(save.getAttribute("aria-describedby") ?? "");
    expect(note?.textContent).toBe(page.copy.keepPrompt);
    await page.click(save);
    expect(page.status()).toBe(page.copy.savedForLaterKept);
    expect(persist).toHaveBeenCalledTimes(1);

    // Once it has asked, the note goes, and pressing again on this visit doesn't ask again.
    expect(page.text()).not.toContain(page.copy.keepPrompt);
    expect(page.button("Save and finish later").hasAttribute("aria-describedby")).toBe(false);
    await page.click(page.button("Save and finish later"));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    await page.unmount();
  });

  it("asks for the answer on screen when that is the first one saved, after saying it may", async () => {
    const page = await visit();
    // Nothing is stored yet, but the press saves the answer on screen and
    // then asks, so the note has to be there before it.
    expect(page.text()).toContain(page.copy.keepPrompt);
    await page.choose("A family member");
    await page.click(page.button("Save and finish later"));
    expect(page.status()).toBe(page.copy.savedForLaterKept);
    expect(persist).toHaveBeenCalledTimes(1);
    await page.unmount();
  });

  it("doesn't ask when nothing is saved, and doesn't say it might when the browser can't keep anything", async () => {
    // Nothing answered yet: there is nothing to keep, so the press doesn't ask.
    const empty = await visit();
    await empty.click(empty.button("Save and finish later"));
    expect(persist).not.toHaveBeenCalled();
    await empty.unmount();

    // A browser that can't store anything: no note, and no request.
    vi.stubGlobal("indexedDB", undefined);
    const page = await visit();
    expect(page.text()).not.toContain(page.copy.keepPrompt);
    expect(page.button("Save and finish later").hasAttribute("aria-describedby")).toBe(false);
    await page.choose("Me");
    await page.click(page.button("Continue"));
    await page.click(page.button("Save and finish later"));
    expect(persist).not.toHaveBeenCalled();
    await page.unmount();
  });
});
