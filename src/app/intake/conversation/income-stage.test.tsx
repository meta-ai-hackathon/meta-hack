// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBannedClaims } from "../../../lib/honesty";
import type { IntakeClientState } from "../../../lib/intake/serialize";
import { IncomeStage } from "./income-stage";
import { encryptForBrowser } from "../../../lib/plaid/envelope";

const originStoreMock = vi.hoisted(() => ({
  load: vi.fn(async () => ({}) as Record<string, string>),
  save: vi.fn(async (updates: Record<string, string | null>) => ({
    status: "saved" as const,
    origins: Object.fromEntries(
      Object.entries(updates).filter(
        ([, value]) => typeof value === "string" && value !== "",
      ),
    ) as Record<string, string>,
  })),
}));
vi.mock("../../../lib/plaid/origin-store", () => ({
  loadPlaidOriginsFromDevice: originStoreMock.load,
  savePlaidOriginsToDevice: originStoreMock.save,
}));

// The income stage (milestone income-capture part 3; VAL-INC-001/002/003/
// 007/008/010/012/014): three real source cards — the manual card
// (the income spec questions, prefilled, saved with provenance user),
// the tax-return upload (parse → findings with "From your tax return"
// badges → confirm-or-correct before anything saves; a re-upload replaces
// the findings), and the consented Plaid Sandbox bank card (HACK-140;
// Link stubbed in tests). The stage never dead-ends; copy stays banned-claims clean.

function question(
  overrides: Partial<IntakeClientState["questions"][number]> & { id: string },
): IntakeClientState["questions"][number] {
  return {
    prompt: `The ${overrides.id} prompt`,
    help: "",
    type: "text",
    required: true,
    pii: false,
    ...overrides,
  } as IntakeClientState["questions"][number];
}

const INCOME_SOURCES = question({
  id: "income_sources",
  prompt: "Where does money come from for your household?",
  type: "multi_select",
  options: [
    { value: "job", label: "A job" },
    { value: "benefits", label: "Benefits like disability or retirement checks" },
    { value: "none", label: "No money coming in right now" },
  ],
});

const INCOME_KIND = question({
  id: "income_kind",
  prompt: "What kind of income do you have?",
  type: "single_select",
  options: [
    { value: "self_employment_current", label: "I work for myself right now" },
    { value: "prior_employer_only", label: "I had a job before, but not anymore" },
  ],
});

const JOB_AMOUNT = question({
  id: "job_income_amount",
  prompt: "About how much money comes in from jobs each time you get paid?",
  type: "number",
});

const JOB_FREQUENCY = question({
  id: "job_income_frequency",
  prompt: "How often does that job money come in?",
  type: "single_select",
  options: [
    { value: "weekly", label: "Every week" },
    { value: "monthly", label: "Once a month" },
  ],
});

/** The stage's arrival state: talk complete, income visible but unhandled. */
function incomeState(
  overrides?: Partial<IntakeClientState>,
): IntakeClientState {
  return {
    questions: [INCOME_SOURCES, INCOME_KIND, JOB_AMOUNT, JOB_FREQUENCY],
    answers: {
      income_sources: { status: "known", value: ["job"] },
      income_kind: { status: "known", value: "prior_employer_only" },
      job_income_amount: { status: "known", value: 2400 },
      job_income_frequency: { status: "known", value: "biweekly" },
    },
    progress: { answered: 5, remaining: 0, total: 5 },
    currentIndex: null,
    complete: true,
    quickQuestions: {
      programs: ["nc_medicaid"],
      requiredIds: [],
      requiredCount: 0,
      remainingIds: [],
      remainingCount: 0,
      complete: true,
    },
    income: {
      questionIds: [
        "income_sources",
        "income_kind",
        "job_income_amount",
        "job_income_frequency",
      ],
      answeredCount: 4,
      confirmedCount: 0,
      totalCount: 4,
      handled: false,
    },
    ...overrides,
  };
}

/** The state a confirm/manual save returns: the income gate handled. */
function handledState(): IntakeClientState {
  return incomeState({
    answers: {
      ...incomeState().answers,
      job_income_amount: {
        status: "known",
        value: 4017,
        provenance: "tax_return",
      },
    },
    income: {
      ...incomeState().income,
      confirmedCount: 1,
      handled: true,
    },
  });
}

function parseResponse(readable: boolean): Response {
  return new Response(
    JSON.stringify(
      readable
        ? {
            readable: true,
            findings: [
              { field: "wages_line_1a", value: 52500, origin: "acroform_field", confidence: 1 },
              { field: "agi_line_11", value: 48200, origin: "acroform_field", confidence: 1 },
              {
                field: "filing_status",
                value: "married_filing_jointly",
                origin: "acroform_field",
                confidence: 1,
              },
              { field: "dependent_count", value: 2, origin: "acroform_field", confidence: 1 },
            ],
            monthlyDerived: 4017,
            message: null,
          }
        : {
            readable: false,
            findings: [],
            monthlyDerived: null,
            message:
              "We couldn't read a tax return from that file, so nothing was saved. No problem — you can type your income instead. A rough idea is okay.",
          },
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let posts: { url: string; body: string }[] = [];
let pullRemoved = true;
let answerState: IntakeClientState | null = null;
let confirmState: IntakeClientState | null = null;
let uploadResponse: Response = parseResponse(true);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  posts = [];
  pullRemoved = true;
  answerState = null;
  confirmState = null;
  uploadResponse = parseResponse(true);
  originStoreMock.load.mockResolvedValue({});
  originStoreMock.save.mockImplementation(async (updates) => ({
    status: "saved" as const,
    origins: Object.fromEntries(
      Object.entries(updates).filter(
        ([, value]) => typeof value === "string" && value !== "",
      ),
    ) as Record<string, string>,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      posts.push({ url, body: typeof init?.body === "string" ? init.body : "" });
      if (url === "/api/intake/answer") {
        return new Response(JSON.stringify(answerState ?? incomeState()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === "/api/intake/tax-return") {
        return uploadResponse;
      }
      if (url === "/api/intake/tax-return/confirm") {
        return new Response(
          JSON.stringify({ saved: [], state: confirmState ?? handledState() }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/intake/plaid/link-token") {
        return new Response(JSON.stringify({ linkToken: "link-test", pullHandle: "user-test-x.sig" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/intake/plaid/pull") {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { clientPublicKey: string; pullHandle: string };
        // The UI must send the session-bound handle, never a raw Plaid user id.
        if (typeof body.pullHandle !== "string") return new Response("{}", { status: 400 });
        const payload = { pulledAt: "2026-11-03T00:00:00.000Z", dateRange: { start: "2026-08-01", end: "2026-10-31" }, streams: [
          { incomeCategory: "SALARY", isStripePayout: false, payFrequency: "MONTHLY", totalAmount: 6300, transactionCount: 3, startDate: "2026-08-01", endDate: "2026-10-31", historicalMonths: [{ startDate: "2026-08-01", endDate: "2026-08-31", total: 2000 }, { startDate: "2026-09-01", endDate: "2026-09-30", total: 2200 }, { startDate: "2026-10-01", endDate: "2026-10-31", total: 2100 }] },
        ] };
        return new Response(JSON.stringify({ envelope: encryptForBrowser(body.clientPublicKey, JSON.stringify(payload)), removed: pullRemoved }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/intake/plaid/remove") {
        return new Response(JSON.stringify({ removed: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/intake/plaid/confirm") {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { confirmations?: { questionId: string; action: string }[] };
        const saved = (body.confirmations ?? [])
          .filter((entry) => entry.action === "correct")
          .map((entry) => ({ questionId: entry.questionId, status: "known", provenance: "user" }));
        return new Response(
          JSON.stringify({ saved, state: confirmState ?? handledState() }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === "/api/intake/state") {
        return new Response(JSON.stringify(incomeState()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function renderStage(state: IntakeClientState = incomeState()): Promise<{
  container: HTMLElement;
  act: (fn: () => Promise<void> | void) => Promise<void>;
  getNotice: () => string;
}> {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const act = async (fn: () => Promise<void> | void) => {
    await React.act(async () => {
      await fn();
      for (let i = 0; i < 6; i += 1) {
        await new Promise((done) => setTimeout(done, 0));
      }
    });
  };
  let notice = "";
  await act(async () => {
    root.render(
      React.createElement(IncomeStage, {
        state,
        onStateChange: (next: IntakeClientState) => {
          state = next;
        },
        onNotice: (message: string) => {
          notice = message;
        },
      }),
    );
  });
  await act(async () => undefined);
  return { container, act, getNotice: () => notice };
}

const q = (container: HTMLElement, attr: string): Element | null =>
  container.querySelector(`[data-${attr}]`);

async function chooseFile(container: HTMLElement, act: (fn: () => Promise<void> | void) => Promise<void>): Promise<void> {
  await act(async () => {
    const input = q(container, "income-file") as HTMLInputElement;
    const file = new File(["%PDF-fake"], "tax-return.pdf", {
      type: "application/pdf",
    });
    Object.defineProperty(input, "files", {
      value: [file],
      configurable: true,
    });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("the source cards (VAL-INC-002, HACK-140)", () => {
  it("renders three cards: manual, tax-return upload, and Plaid Sandbox bank — no Stripe card, no future promises", async () => {
    const { container } = await renderStage();
    expect(q(container, "income-stage")).not.toBeNull();
    expect(q(container, "income-manual-card")).not.toBeNull();
    expect(q(container, "income-upload-card")).not.toBeNull();
    expect(q(container, "income-plaid-card")).not.toBeNull();
    const cards = container.querySelectorAll("[data-income-manual-card], [data-income-upload-card], [data-income-plaid-card]");
    expect(cards).toHaveLength(3);
    const text = container.textContent ?? "";
    for (const banned of ["Stripe", "coming soon"]) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("keeps the stage copy honest and banned-claims clean, and a seeded stage-phrased promise provably bites", async () => {
    const { container } = await renderStage();
    expect(findBannedClaims(container.textContent ?? "")).toEqual([]);
    // The honest framing is present: rough idea okay, the state decides.
    expect(container.textContent).toContain("A rough idea is okay");
    // The seeded fixture: an eligibility promise phrased as income-stage
    // copy must bite the detector — the gate covers this stage's copy.
    const seeded =
      "Your income is saved — with that income you qualify for assistance.";
    expect(findBannedClaims(seeded).length).toBeGreaterThan(0);
  });

  it("renders an H2 stage heading (the page's H1 stays the page's) and a live status line", async () => {
    const { container } = await renderStage();
    expect(container.querySelectorAll("h1")).toHaveLength(0);
    expect(q(container, "income-heading")?.tagName).toBe("H2");
    const status = q(container, "income-status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("4 of 4 income details are in");
    expect(status?.textContent).toContain("nothing is confirmed yet");
  });
});

describe("the Plaid Sandbox bank card (HACK-140)", () => {
  /** Render the stage and complete a Link success that yields two proposals. */
  async function pullTestBank() {
    (window as unknown as { Plaid: unknown }).Plaid = {
      create: (config: {
        onSuccess: (
          t: string,
          metadata?: { institution?: { name?: string } },
        ) => Promise<void>;
      }) => ({
        open: () => {
          void config.onSuccess("public-test", {
            institution: { name: "First Platypus Bank" },
          });
        },
      }),
    };
    const rendered = await renderStage();
    await rendered.act(async () => {
      (q(rendered.container, "income-plaid-consent") as HTMLInputElement).click();
    });
    await rendered.act(async () => {
      (q(rendered.container, "income-plaid-connect") as HTMLButtonElement).click();
    });
    return rendered;
  }

  it("connect stays disabled until the distinct Plaid consent is checked", async () => {
    const { container, act } = await renderStage();
    const button = q(container, "income-plaid-connect") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const consent = q(container, "income-plaid-consent") as HTMLInputElement;
    await act(async () => { consent.click(); });
    expect((q(container, "income-plaid-connect") as HTMLButtonElement).disabled).toBe(false);
  });

  it("removes the Plaid test user when Link is closed without a pull", async () => {
    (window as unknown as { Plaid: unknown }).Plaid = {
      create: (config: { onExit?: () => void }) => ({
        open: () => config.onExit?.(),
      }),
    };
    const { container, act } = await renderStage();
    await act(async () => { (q(container, "income-plaid-consent") as HTMLInputElement).click(); });
    await act(async () => { (q(container, "income-plaid-connect") as HTMLButtonElement).click(); });
    expect(posts.some((post) => post.url === "/api/intake/plaid/remove")).toBe(true);
    expect(q(container, "income-plaid-status")?.textContent).toContain("test connection was removed");
  });

  it("pulls, decrypts, proposes with basis, and posts the decisions only on save", async () => {
    (window as unknown as { Plaid: unknown }).Plaid = {
      create: (config: {
        onSuccess: (
          t: string,
          metadata?: { institution?: { name?: string } },
        ) => Promise<void>;
      }) => ({
        open: () => {
          void config.onSuccess("public-test", {
            institution: { name: "First Platypus Bank" },
          });
        },
      }),
    };
    const { container, act, getNotice } = await renderStage();
    await act(async () => { (q(container, "income-plaid-consent") as HTMLInputElement).click(); });
    await act(async () => { (q(container, "income-plaid-connect") as HTMLButtonElement).click(); });
    expect(q(container, "income-plaid-proposals")).not.toBeNull();
    expect(container.textContent).toContain("From First Platypus Bank");
    expect(q(container, "income-plaid-basis")?.textContent).toContain("3 deposits");
    expect((container.querySelector('[data-income-plaid-correct="job_income_amount"]') as HTMLInputElement).value).toBe("2100");
    // A pay schedule is a select over the question's spec options, not a
    // numeric field: mobile keyboards cannot type "monthly" (review P2).
    const frequency = container.querySelector(
      '[data-income-plaid-correct="job_income_frequency"]',
    ) as HTMLSelectElement;
    expect(frequency.tagName).toBe("SELECT");
    expect(frequency.value).toBe("monthly");
    expect(Array.from(frequency.options).map((option) => option.value)).toContain("weekly");
    // No owner name crosses the broker any more (review P1): the person
    // names whose income this is, and the save requires that name.
    expect((container.querySelector("[data-income-plaid-member-name]") as HTMLInputElement).value).toBe("");
    expect(q(container, "income-plaid-owner")).toBeNull();
    expect((q(container, "income-plaid-save") as HTMLButtonElement).disabled).toBe(true);
    expect(posts.some((post) => post.url === "/api/intake/plaid/confirm")).toBe(false);
    await act(async () => {
      const input = container.querySelector("[data-income-plaid-member-name]") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Alberta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { (q(container, "income-plaid-save") as HTMLButtonElement).click(); });
    // Untouched proposals never leave the page: no confirm request at all.
    expect(posts.some((post) => post.url === "/api/intake/plaid/confirm")).toBe(false);
    expect(originStoreMock.save).not.toHaveBeenCalled();
    expect(getNotice()).toContain("Nothing was saved");
  });

  it("saves a typed amount with separators as a number, not NaN", async () => {
    const { container, act } = await pullTestBank();
    await act(async () => {
      const input = container.querySelector(
        '[data-income-plaid-correct="job_income_amount"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "1,800");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const input = container.querySelector(
        "[data-income-plaid-member-name]",
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "Alberta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (q(container, "income-plaid-save") as HTMLButtonElement).click();
    });
    const confirm = posts.find((post) => post.url === "/api/intake/plaid/confirm");
    expect(confirm).toBeDefined();
    expect(JSON.parse(confirm?.body ?? "{}").confirmations).toEqual([
      { questionId: "job_income_amount", action: "correct", value: 1800 },
    ]);
    expect(q(container, "income-plaid-another")).toBeNull();
    expect(q(container, "income-plaid-one-member")?.textContent).toContain(
      "One bank connection",
    );
  });

  it("does not treat a reformatted same amount as an edit", async () => {
    const { container, act, getNotice } = await pullTestBank();
    await act(async () => {
      const input = container.querySelector(
        '[data-income-plaid-correct="job_income_amount"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "2,100");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const input = container.querySelector(
        "[data-income-plaid-member-name]",
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "Alberta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (q(container, "income-plaid-save") as HTMLButtonElement).click();
    });
    expect(posts.some((post) => post.url === "/api/intake/plaid/confirm")).toBe(false);
    expect(getNotice()).toContain("Nothing was saved");
  });

  it("says so when the test connection could not be removed", async () => {
    pullRemoved = false;
    const { container } = await pullTestBank();
    expect(q(container, "income-plaid-status")?.textContent).toContain(
      "could not confirm the test connection was removed",
    );
  });

  it("shows a field-level error and saves nothing for a non-numeric amount", async () => {
    const { container, act } = await pullTestBank();
    await act(async () => {
      const input = container.querySelector(
        '[data-income-plaid-correct="job_income_amount"]',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "not a number");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(
      container.querySelector('[data-income-plaid-error="job_income_amount"]'),
    ).not.toBeNull();
    expect((q(container, "income-plaid-save") as HTMLButtonElement).disabled).toBe(true);
    expect(posts.some((post) => post.url === "/api/intake/plaid/confirm")).toBe(false);
  });
});

describe("the manual card (VAL-INC-003/012)", () => {
  it("renders the visible income questions prefilled from the session", async () => {
    const { container } = await renderStage();
    const rows = container.querySelectorAll("[data-income-row]");
    expect(rows).toHaveLength(4);
    const amount = q(container, 'income-row="job_income_amount"')
      ?.querySelector("input") as HTMLInputElement;
    expect(amount.value).toBe("2400");
    // A tax-derived prefill shows its origin badge on the row.
    const withProvenance = incomeState({
      answers: {
        ...incomeState().answers,
        job_income_amount: {
          status: "known",
          value: 4017,
          provenance: "tax_return",
        },
      },
    });
    const { container: badgeContainer } = await renderStage(withProvenance);
    expect(q(badgeContainer, 'income-row="job_income_amount"')?.textContent).toContain(
      "From your tax return",
    );
  });

  it("saves the typed values through the standard answer path with user provenance — the confirm route's correct action", async () => {
    const { container, act } = await renderStage();
    await act(async () => {
      const amount = q(container, 'income-row="job_income_amount"')
        ?.querySelector("input") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(amount, "2600");
      amount.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      q(container, "income-save-manual")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    // ONE batch POST to the confirm route, action correct (provenance
    // user server-side), every visible income question vouched for.
    const confirmPost = posts.find((post) =>
      post.url.endsWith("/api/intake/tax-return/confirm"),
    );
    expect(confirmPost).toBeDefined();
    const body = JSON.parse(confirmPost!.body) as {
      confirmations: { questionId: string; action: string; value: unknown }[];
    };
    expect(body.confirmations).toHaveLength(4);
    for (const entry of body.confirmations) {
      expect(entry.action).toBe("correct");
    }
    expect(body.confirmations.find((c) => c.questionId === "job_income_amount")?.value).toBe(2600);
    // The fresh state flows back through onStateChange (the parent's gate
    // re-renders from it).
    expect(handledState().income.handled).toBe(true);
  });

  it("clears a saved bank origin when the manual card saves the questions", async () => {
    originStoreMock.load.mockResolvedValue({ job_income_amount: "First Platypus Bank" });
    const { container, act } = await renderStage();
    await act(async () => {
      q(container, "income-save-manual")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(originStoreMock.save).toHaveBeenCalledWith(
      expect.objectContaining({ job_income_amount: null }),
      { expectStored: true },
    );
  });

  it("saves an 'I'm not sure' row through the standard tri-state path with no value", async () => {
    const { container, act } = await renderStage();
    await act(async () => {
      q(container, 'income-not-sure-button="job_income_amount"')?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await act(async () => {
      q(container, "income-save-manual")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const answerPost = posts.find((post) =>
      post.url.endsWith("/api/intake/answer"),
    );
    expect(answerPost).toBeDefined();
    expect(JSON.parse(answerPost!.body)).toMatchObject({
      questionId: "job_income_amount",
      status: "unknown",
      value: null,
    });
    // The not-sure row is NOT in the confirm batch.
    const confirmPost = posts.find((post) =>
      post.url.endsWith("/api/intake/tax-return/confirm"),
    );
    expect(confirmPost).toBeDefined();
    const body = JSON.parse(confirmPost!.body) as {
      confirmations: { questionId: string }[];
    };
    expect(
      body.confirmations.some((entry) => entry.questionId === "job_income_amount"),
    ).toBe(false);
  });
});

describe("the tax-return upload card (VAL-INC-007/008/010)", () => {
  it("shows findings with 'From your tax return' badges and proposes the prior-year monthly figure for confirm-or-correct", async () => {
    const { container, act } = await renderStage();
    await chooseFile(container, act);
    await act(async () => {
      q(container, "income-read")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    // The parse POST happened (multipart to the part-2 route).
    expect(posts.some((post) => post.url.endsWith("/api/intake/tax-return"))).toBe(true);
    // All four findings render, each badged.
    const findings = container.querySelectorAll("[data-income-finding]");
    expect(findings).toHaveLength(4);
    expect(
      container.querySelectorAll('[data-origin-badge="tax_return"]').length,
    ).toBeGreaterThanOrEqual(4);
    expect(container.textContent).toContain("From your tax return");
    // The proposal: the prior-year monthly figure (AGI ÷ 12), confirm-or-
    // correct — NEVER presented as computed current monthly income.
    const proposal = q(container, 'income-proposal="job_income_amount"');
    expect(proposal).not.toBeNull();
    expect(q(container, 'income-proposed-value="job_income_amount"')?.textContent).toContain(
      "4,017",
    );
    expect(container.textContent).toContain("LAST year");
    // The status line announced the parse result (aria-live).
    expect(q(container, "income-read-status")?.getAttribute("aria-live")).toBe("polite");
    expect(q(container, "income-read-status")?.textContent).toContain("confirm or correct");
  });

  it("saves nothing until the person decides — then confirms the proposal as tax_return", async () => {
    const { container, act } = await renderStage();
    await chooseFile(container, act);
    await act(async () => {
      q(container, "income-read")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    // The parse alone saved nothing: zero answer POSTs.
    expect(posts.some((post) => post.url.includes("/answer") || post.url.includes("/confirm"))).toBe(false);
    await act(async () => {
      q(container, "income-save-tax")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const confirmPost = posts.find((post) =>
      post.url.endsWith("/api/intake/tax-return/confirm"),
    );
    expect(confirmPost).toBeDefined();
    const body = JSON.parse(confirmPost!.body) as {
      confirmations: { questionId: string; action: string; value: unknown }[];
    };
    // The blank correction inputs mean CONFIRM — both proposals confirm.
    expect(body.confirmations).toEqual([
      { questionId: "job_income_amount", action: "confirm", value: 4017 },
      { questionId: "job_income_frequency", action: "confirm", value: "monthly" },
    ]);
  });

  it("a corrected proposal saves the person's own value (action correct)", async () => {
    const { container, act } = await renderStage();
    await chooseFile(container, act);
    await act(async () => {
      q(container, "income-read")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    await act(async () => {
      const input = q(
        container,
        'income-correct="job_income_amount"',
      ) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "2200");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      q(container, "income-save-tax")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const confirmPost = posts.find((post) =>
      post.url.endsWith("/api/intake/tax-return/confirm"),
    );
    const body = JSON.parse(confirmPost!.body) as {
      confirmations: { questionId: string; action: string; value: unknown }[];
    };
    expect(body.confirmations.find((c) => c.questionId === "job_income_amount")).toEqual({
      questionId: "job_income_amount",
      action: "correct",
      value: 2200,
    });
  });

  it("a re-upload replaces the prior findings — old proposals are discarded, not duplicated", async () => {
    const { container, act } = await renderStage();
    await chooseFile(container, act);
    await act(async () => {
      q(container, "income-read")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(container.querySelectorAll("[data-income-finding]")).toHaveLength(4);
    // A SECOND upload parses to different findings — the stage shows the
    // new set only (one findings list, replaced).
    uploadResponse = new Response(
      JSON.stringify({
        readable: true,
        findings: [
          { field: "wages_line_1a", value: 60000, origin: "text_layer", confidence: 0.9 },
        ],
        monthlyDerived: null,
        message: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    await chooseFile(container, act);
    await act(async () => {
      q(container, "income-read")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const findings = container.querySelectorAll("[data-income-finding]");
    expect(findings).toHaveLength(1);
    expect(q(container, 'income-finding="wages_line_1a"')?.textContent).toContain(
      "60,000",
    );
    // The old proposals are gone with the replaced parse (monthlyDerived
    // null now — no proposals, and the honest no-proposal note).
    expect(q(container, 'income-proposal="job_income_amount"')).toBeNull();
    expect(q(container, "income-no-proposals")).not.toBeNull();
  });

  it("an unreadable upload shows the honest fallback, saves nothing, and points at typing", async () => {
    const { container, act } = await renderStage();
    uploadResponse = parseResponse(false);
    await chooseFile(container, act);
    await act(async () => {
      q(container, "income-read")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(q(container, "income-unreadable")).not.toBeNull();
    expect(container.textContent).toContain("type your income instead");
    // Nothing saved, nothing proposed.
    expect(posts.some((post) => post.url.includes("/answer") || post.url.includes("/confirm"))).toBe(false);
    expect(q(container, 'income-proposal="job_income_amount"')).toBeNull();
    // The manual card is still right there — the stage never dead-ends.
    expect(q(container, "income-manual-card")).not.toBeNull();
  });
});

describe("the client-side Plaid origin (HACK-140)", () => {
  it("shows the sealed institution name on a saved bank value", async () => {
    originStoreMock.load.mockResolvedValue({
      job_income_amount: "First Platypus Bank",
      job_income_frequency: "First Platypus Bank",
    });
    const state = incomeState({
      answers: {
        ...incomeState().answers,
        // An untouched bank proposal is never saved by the current card; the
        // legacy badge shape is an unverified answer with a sealed origin.
        job_income_amount: {
          status: "unverified",
          value: 2100,
        },
        job_income_frequency: { status: "unverified", value: "monthly" },
      },
    });
    const { container } = await renderStage(state);
    const row = q(container, 'income-row="job_income_amount"');
    expect(
      row?.querySelector('[data-origin-badge="plaid_institution"]'),
    ).not.toBeNull();
    expect(row?.textContent).toContain("From First Platypus Bank");
    // A confirmed schedule is unverified too; its badge must survive a reload.
    const frequencyRow = q(container, 'income-row="job_income_frequency"');
    expect(
      frequencyRow?.querySelector('[data-origin-badge="plaid_institution"]'),
    ).not.toBeNull();
    expect(frequencyRow?.textContent).toContain("From First Platypus Bank");
  });

  it("does not keep the bank badge on an amount another path saved", async () => {
    originStoreMock.load.mockResolvedValue({ job_income_amount: "First Platypus Bank" });
    const state = incomeState({
      answers: {
        ...incomeState().answers,
        job_income_amount: { status: "known", value: 2100, provenance: "user" },
      },
    });
    const { container } = await renderStage(state);
    const row = q(container, 'income-row="job_income_amount"');
    expect(row?.querySelector('[data-origin-badge="plaid_institution"]')).toBeNull();
    expect(row?.querySelector('[data-origin-badge="user"]')).not.toBeNull();
  });

  it("falls back to the person-confirmed badge without a saved origin", async () => {
    const state = incomeState({
      answers: {
        ...incomeState().answers,
        job_income_amount: {
          status: "known",
          value: 2100,
          provenance: "user",
        },
      },
    });
    const { container } = await renderStage(state);
    const row = q(container, 'income-row="job_income_amount"');
    expect(row?.querySelector('[data-origin-badge="user"]')).not.toBeNull();
    expect(row?.textContent).toContain("You confirmed this");
  });
});
