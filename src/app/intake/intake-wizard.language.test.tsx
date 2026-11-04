// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientQuestion,
  IntakeClientState,
} from "../../lib/intake/client-state";

// HACK-131 on the /intake wizard path: the picker switches the question and
// the chrome, the wizard's root is tagged with the chosen language and
// direction (Arabic is right-to-left), the stored choice applies after mount,
// and the failure screen is labelled with the language of the text it shows —
// English for a server message, the chosen language for the generic fallback.

const STATE_QUESTION: ClientQuestion = {
  id: "state",
  prompt: "Which state do you live in?",
  help: "We ask because the programs are run state by state.",
  type: "single_select",
  required: true,
  pii: false,
  options: [
    { value: "NC", label: "North Carolina" },
    { value: "SC", label: "South Carolina" },
  ],
};

const NEXT_QUESTION: ClientQuestion = {
  id: "city",
  prompt: "The next question's prompt",
  help: "",
  type: "text",
  required: false,
  pii: false,
};

function stateWith(): IntakeClientState {
  return {
    questions: [STATE_QUESTION, NEXT_QUESTION],
    answers: {},
    progress: { answered: 0, remaining: 2, total: 2 },
    currentIndex: 0,
    complete: false,
    quickQuestions: {
      programs: [],
      requiredIds: [],
      requiredCount: 0,
      remainingIds: [],
      remainingCount: 0,
      complete: false,
    },
    income: {
      questionIds: [],
      answeredCount: 0,
      confirmedCount: 0,
      totalCount: 0,
      handled: true,
    },
  };
}

function stubState(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(stateWith()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })),
  );
}

describe("IntakeWizard language picker (HACK-131)", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    localStorage.clear();
    document.body.replaceChildren();
  });

  async function visit(): Promise<{
    container: HTMLElement;
    click: (label: string) => Promise<void>;
  }> {
    vi.resetModules();
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { IntakeWizard } = await import("./intake-wizard");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const act = async (fn: () => Promise<void> | void) => {
      await React.act(async () => {
        await fn();
        for (let i = 0; i < 30; i += 1) {
          await new Promise((done) => setTimeout(done, 0));
        }
      });
    };
    await act(() => {
      root.render(React.createElement(IntakeWizard));
    });
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      if (!button) {
        throw new Error(`no button labelled ${label}`);
      }
      await act(() => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    return { container, click };
  }

  function wizardRoot(container: HTMLElement): HTMLElement {
    const root = container.querySelector<HTMLElement>("[data-intake-wizard]");
    if (!root) {
      throw new Error("no wizard root");
    }
    return root;
  }

  it("switches the prompt, the chrome, and the root language when Spanish is picked", async () => {
    stubState();
    const { container, click } = await visit();
    // English until a choice is made.
    expect(wizardRoot(container).getAttribute("lang")).toBe("en");
    expect(container.textContent).toContain("Which state do you live in?");

    await click("Español");

    expect(wizardRoot(container).getAttribute("lang")).toBe("es");
    expect(wizardRoot(container).getAttribute("dir")).toBe("ltr");
    expect(container.textContent).toContain("¿En qué estado vive?");
    expect(container.textContent).not.toContain("Which state do you live in?");
    expect(localStorage.getItem("bn_language_v1")).toBe("es");
    // The chrome follows the question, not just the prompt.
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Continuar",
      ),
    ).toBe(true);
    // Nine pills of long names have to wrap on a phone screen instead of
    // running off it.
    expect(container.querySelector('[role="group"]')?.className).toContain("flex-wrap");
  });

  it("applies a stored Arabic choice after mount and lays the wizard out right-to-left", async () => {
    localStorage.setItem("bn_language_v1", "ar");
    stubState();
    const { container } = await visit();
    expect(wizardRoot(container).getAttribute("lang")).toBe("ar");
    expect(wizardRoot(container).getAttribute("dir")).toBe("rtl");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.getAttribute("aria-pressed") === "true" && button.textContent === "العربية",
      ),
    ).toBe(true);
  });

  it("follows a language change made in another tab", async () => {
    // The browser's storage event is how another tab's choice reaches an open
    // wizard; without it the picker would only follow this page's own writes.
    const { LANGUAGE_STORAGE_KEY, subscribeLanguage } = await import("../../lib/intake/i18n");
    let calls = 0;
    const unsubscribe = subscribeLanguage(() => {
      calls += 1;
    });
    window.dispatchEvent(
      new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "fr" }),
    );
    expect(calls).toBe(1);
    unsubscribe();
    window.dispatchEvent(
      new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "es" }),
    );
    expect(calls).toBe(1);
  });

  it("forgets the stored language when the answers are deleted, keeping it on screen", async () => {
    // On a shared computer the stored choice would hint at the last person's
    // language, so deleting the answers clears it; this visit keeps what it shows.
    const { LANGUAGE_STORAGE_KEY, clearStoredLanguage, storeLanguage, storedLanguageSnapshot } =
      await import("../../lib/intake/i18n");
    storeLanguage("es", window.localStorage);
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("es");
    clearStoredLanguage(window.localStorage);
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
    expect(storedLanguageSnapshot(window.localStorage)).toBe("es");
    window.localStorage.clear();
  });

  it("keeps a language that came from an earlier visit when the answers are deleted", async () => {
    // Nobody picked a language this visit, so the page is showing the stored
    // one; deleting the answers must not flip it to English mid-visit.
    const { LANGUAGE_STORAGE_KEY, clearStoredLanguage, storedLanguageSnapshot } = await import(
      "../../lib/intake/i18n"
    );
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "ar");
    expect(storedLanguageSnapshot(window.localStorage)).toBe("ar");
    clearStoredLanguage(window.localStorage);
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
    expect(storedLanguageSnapshot(window.localStorage)).toBe("ar");
    // Another tab's later choice still reaches this visit.
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "fr");
    window.dispatchEvent(
      new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "fr" }),
    );
    expect(storedLanguageSnapshot(window.localStorage)).toBe("fr");
    window.localStorage.clear();
  });

  it("labels a server failure as English and the translated fallback as the chosen language", async () => {
    // A server-supplied message arrives in English, so that text is labelled
    // English even though the rest of the screen is in the chosen language.
    localStorage.setItem("bn_language_v1", "es");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "The server could not load your answers." } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })),
    );
    const serverFailure = await visit();
    expect(wizardRoot(serverFailure.container).getAttribute("lang")).toBe("es");
    expect(serverFailure.container.querySelector('[lang="en"]')?.textContent).toContain(
      "The server could not load your answers.",
    );
    // The failure screen still offers the picker, so a wrong language is not a
    // dead end.
    expect(
      [...serverFailure.container.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "English",
      ),
    ).toBe(true);

    // A request that never lands has only the translated generic text.
    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const noResponse = await visit();
    expect(wizardRoot(noResponse.container).getAttribute("lang")).toBe("es");
    expect(noResponse.container.textContent).toContain(
      "Algo salió mal de nuestro lado. Inténtelo de nuevo.",
    );
  });
});
