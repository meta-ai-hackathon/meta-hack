// @vitest-environment jsdom
import fc from "fast-check";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import realEntryJson from "../../../../kb/entries/nc-medicaid.json";
import { buildFormFlow } from "../../../lib/forms/flow";
import { getFormRegistryEntry } from "../../../lib/forms/registry";
import {
  HANDOFF_WHERE_LABELS,
  handoffCompanion,
  handoffCompanionForForm,
  nextHandoffAction,
  showsAfterYouApply,
  type HandoffCompanion,
  type HandoffState,
} from "../../../lib/handoff";
import { SESSION_STATUSES, findBannedClaims, type SessionStatus } from "../../../lib/honesty";
import { parseKbEntry } from "../../../lib/kb";
import { PILOT_CONFIG } from "../../../lib/pilot";
import { HandoffSection } from "./handoff-section";
import { ReviewSectionContent } from "./review-section";

// The handoff companion as rendered (HACK-49, HACK-46, HACK-47, and the
// handoff part of HACK-51): one next step labeled with where it happens,
// every step with its source card, no copy that promises an outcome or
// says the app sent anything, and nothing on screen that signs, sends,
// submits, or faxes the form.

const REAL = parseKbEntry(realEntryJson as unknown);
// The form the pilot's review section shows, which the KB steps are for.
const FORM = PILOT_CONFIG.formRegistryId;
const COMPANION = handoffCompanionForForm(FORM)!;

const stateArb: fc.Arbitrary<HandoffState> = fc.record({
  sessionStatus: fc.constantFrom(...SESSION_STATUSES),
  downloaded: fc.boolean(),
  stillNeededCount: fc.nat({ max: 40 }),
});

function render(element: ReactElement): Document {
  return new DOMParser().parseFromString(renderToStaticMarkup(element), "text/html");
}

function renderHandoff(state: HandoffState, companion?: HandoffCompanion | null): Document {
  return render(
    <HandoffSection
      formId={FORM}
      sessionStatus={state.sessionStatus}
      downloaded={state.downloaded}
      stillNeededCount={state.stillNeededCount}
      {...(companion === undefined ? {} : { companion })}
    />,
  );
}

/** What is wrong with each rendered step's source card, if anything. */
function sourceCardProblems(doc: Document): string[] {
  const problems: string[] = [];
  for (const step of doc.querySelectorAll<HTMLElement>("[data-handoff-step]")) {
    const id = step.getAttribute("data-handoff-step");
    const cards = step.querySelectorAll("[data-source-card]");
    if (cards.length !== 1) {
      problems.push(`${id}: ${cards.length} source cards`);
      continue;
    }
    const card = cards[0]!;
    const href = card.querySelector("a")?.getAttribute("href") ?? "";
    if (!href.startsWith("https://")) {
      problems.push(`${id}: source link ${JSON.stringify(href)} is not https`);
    }
    const retrieved = card.querySelector("[data-source-retrieved]")?.textContent ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(retrieved)) {
      problems.push(`${id}: retrieval date ${JSON.stringify(retrieved)}`);
    }
    const version = card.querySelector("[data-source-version]")?.textContent ?? "";
    if (!/^[1-9]\d*$/.test(version)) {
      problems.push(`${id}: entry version ${JSON.stringify(version)}`);
    }
  }
  return problems;
}

/** Every piece of text on the section, one element at a time. */
function texts(doc: Document): string[] {
  return [...doc.body.querySelectorAll("h3, p, span, a, li")].map(
    (element) => element.textContent ?? "",
  );
}

const APP_SENT_CLAIM =
  /\b(?:we|the app|this app)\s+(?:have\s+|has\s+|already\s+)*(?:signed|sent|submitted|filed|faxed|mailed)\b|\b(?:was|were|has been|have been)\s+(?:signed|sent|submitted|filed|faxed|mailed)\b/i;

describe("HandoffSection: one next step", () => {
  it("renders exactly one next step, labeled with where it happens, for every state", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const doc = renderHandoff(state);
        const action = nextHandoffAction(state);
        const callouts = doc.querySelectorAll("[data-next-action]");
        expect(callouts).toHaveLength(1);
        expect(callouts[0]!.getAttribute("data-next-action")).toBe(action.kind);
        const chips = doc.querySelectorAll("[data-where]");
        expect(chips).toHaveLength(1);
        expect(chips[0]!.getAttribute("data-where")).toBe(action.where);
        expect(chips[0]!.textContent).toBe(HANDOFF_WHERE_LABELS[action.where]);
        expect(callouts[0]!.textContent).toContain(action.title);
        expect(callouts[0]!.textContent).toContain(action.detail);
      }),
      { numRuns: 80 },
    );
  });

  it("shows the steps the next step points at", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const doc = renderHandoff(state);
        const { guide } = nextHandoffAction(state);
        if (guide === "submission_steps") {
          expect(doc.querySelectorAll("[data-submission-steps] [data-handoff-step]").length).toBeGreaterThan(0);
        }
        if (guide === "after_you_apply") {
          expect(doc.querySelectorAll("[data-after-you-apply] [data-handoff-step]").length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 80 },
    );
  });

  it("stays out of the way without sourced steps or with a status outside BN-25", () => {
    const state: HandoffState = { sessionStatus: "handed_off", downloaded: true, stillNeededCount: 0 };
    expect(renderToStaticMarkup(<HandoffSection formId={FORM} {...state} companion={null} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <HandoffSection formId={FORM} sessionStatus="submitted" downloaded stillNeededCount={0} />,
      ),
    ).toBe("");
  });

  it.each(["sample-application-form", "sample-application-form-flat", "dhb-5201"])(
    "shows nothing beside a form the steps were not written for (%s)",
    (formId) => {
      expect(
        renderToStaticMarkup(
          <HandoffSection formId={formId} sessionStatus="handed_off" downloaded stillNeededCount={0} />,
        ),
      ).toBe("");
    },
  );
});

describe("HandoffSection: sourced steps", () => {
  it.each(SESSION_STATUSES)("gives every step a source card with an https link, a date, and a version (%s)", (status) => {
    const doc = renderHandoff({ sessionStatus: status, downloaded: true, stillNeededCount: 2 });
    expect(doc.querySelectorAll("[data-handoff-step]").length).toBeGreaterThan(0);
    expect(sourceCardProblems(doc)).toEqual([]);
  });

  it("cites each step to the source the knowledge base names for it", () => {
    const doc = renderHandoff({ sessionStatus: "user_reported_submitted", downloaded: true, stillNeededCount: 0 });
    const kbSteps = [
      ...(REAL.facts.submission_steps?.items ?? []),
      ...(REAL.facts.after_you_apply?.items ?? []),
    ];
    const rendered = [...doc.querySelectorAll<HTMLElement>("[data-handoff-step]")];
    expect(rendered.map((step) => step.getAttribute("data-handoff-step"))).toEqual(
      kbSteps.map((step) => step.id),
    );
    rendered.forEach((element, index) => {
      const source = REAL.sources.find((candidate) => candidate.id === kbSteps[index]!.sourceId)!;
      const card = element.querySelector("[data-source-card]")!;
      expect(card.querySelector("a")?.getAttribute("href")).toBe(source.url);
      expect(card.textContent).toContain(source.title);
      expect(card.querySelector("[data-source-version]")?.textContent).toBe(String(REAL.version));
    });
  });

  it("lists the signing and sending steps in order, before what to expect", () => {
    const doc = renderHandoff({ sessionStatus: "handed_off", downloaded: true, stillNeededCount: 0 });
    const submission = [...doc.querySelectorAll("ol [data-handoff-step]")].map((step) =>
      step.getAttribute("data-handoff-step"),
    );
    expect(submission).toEqual(COMPANION.submissionSteps.map((step) => step.id));
    const sections = [...doc.querySelectorAll("[data-submission-steps], [data-after-you-apply]")];
    expect(sections.map((section) => section.hasAttribute("data-submission-steps"))).toEqual([
      true,
      false,
    ]);
  });

  it.each(SESSION_STATUSES)("shows what to expect only once the form is handed off (%s)", (status) => {
    const doc = renderHandoff({ sessionStatus: status, downloaded: true, stillNeededCount: 0 });
    expect(doc.querySelector("[data-after-you-apply]") !== null).toBe(showsAfterYouApply(status));
  });

  it("flags every card when the entry is stale", () => {
    const raw = structuredClone(realEntryJson) as Record<string, unknown>;
    raw.status = "stale";
    raw.status_reason = "The county page changed after it was checked.";
    const companion = handoffCompanion(parseKbEntry(raw), FORM);
    const doc = renderHandoff({ sessionStatus: "handed_off", downloaded: true, stillNeededCount: 0 }, companion);
    const cards = [...doc.querySelectorAll("[data-source-card]")];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      const flag = card.querySelector('[data-source-status="stale"]');
      expect(flag?.textContent).toContain("The county page changed after it was checked.");
    }
  });

  it("bites: the source-card check flags a step with a broken source", () => {
    const broken: HandoffCompanion = {
      ...COMPANION,
      submissionSteps: COMPANION.submissionSteps.map((step, index) =>
        index === 0
          ? { ...step, source: { ...step.source, url: "http://example.org/rules", retrievedAt: "last week" } }
          : step,
      ),
    };
    const doc = renderHandoff({ sessionStatus: "draft", downloaded: false, stillNeededCount: 1 }, broken);
    expect(sourceCardProblems(doc)).toHaveLength(2);
  });
});

describe("HandoffSection: nothing here sends the form", () => {
  it.each(SESSION_STATUSES)("renders no button, form, or link that submits or faxes anything (%s)", (status) => {
    const doc = renderHandoff({ sessionStatus: status, downloaded: true, stillNeededCount: 3 });
    expect(doc.querySelectorAll("form, button, input, select, textarea, [type=submit]")).toHaveLength(0);
    // Every link is an https page: a step's official page or a source.
    const allowed = new Set([
      ...REAL.sources.map((source) => source.url),
      ...[...(REAL.facts.submission_steps?.items ?? []), ...(REAL.facts.after_you_apply?.items ?? [])]
        .flatMap((step) => (step.link ? [step.link.url] : [])),
    ]);
    for (const link of doc.querySelectorAll("a")) {
      const href = link.getAttribute("href") ?? "";
      expect(href.startsWith("https://"), href).toBe(true);
      expect(allowed.has(href), href).toBe(true);
    }
  });

  it("links the county page and the online application from the steps", () => {
    const doc = renderHandoff({ sessionStatus: "handed_off", downloaded: true, stillNeededCount: 0 });
    const stepLinks = [...doc.querySelectorAll("[data-handoff-step] > div > a")].map((link) =>
      new URL(link.getAttribute("href") ?? "https://invalid.example").hostname,
    );
    expect(stepLinks).toContain("dcr.mecknc.gov");
    expect(stepLinks).toContain("epass.nc.gov");
  });
});

describe("HandoffSection: honest copy", () => {
  it("never promises an outcome or says the app sent anything, in any state", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const doc = renderHandoff(state);
        for (const text of [...texts(doc), doc.body.textContent ?? ""]) {
          expect(findBannedClaims(text), text).toEqual([]);
          expect(text).not.toMatch(APP_SENT_CLAIM);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("bites: the scan reads the rendered step copy", () => {
    const poisoned: HandoffCompanion = {
      ...COMPANION,
      submissionSteps: COMPANION.submissionSteps.map((step, index) =>
        index === 0 ? { ...step, detail: "Good news: you qualify, and you will be approved." } : step,
      ),
    };
    const doc = renderHandoff({ sessionStatus: "draft", downloaded: false, stillNeededCount: 1 }, poisoned);
    expect(texts(doc).some((text) => findBannedClaims(text).length > 0)).toBe(true);
  });
});

describe("HandoffSection inside the review section", () => {
  function reviewData(formId: string, sessionStatus: SessionStatus) {
    const entry = getFormRegistryEntry(formId);
    const view = buildFormFlow(entry, {
      household_size: { status: "known", value: 3 },
    });
    return {
      hasSession: true,
      form: {
        id: entry.id,
        title: entry.title,
        version: entry.version,
        sourceUrl: entry.source.url,
        retrievedAt: entry.source.retrievedAt,
      },
      fields: view.fields,
      toResolve: view.toResolve,
      counts: view.counts,
      sessionStatus,
      portalLinks: [{ label: "Official application portal", url: "https://example.org/apply" }],
      steps: [{ title: "Submit it yourself", detail: "The app never submits for you." }],
    };
  }

  it.each(SESSION_STATUSES)("leaves the sample form's review without the real form's steps (%s)", (status) => {
    const doc = render(<ReviewSectionContent data={reviewData("sample-application-form", status)} />);
    expect(doc.querySelector("[data-next-action]")).toBeNull();
    expect(doc.querySelector("[data-handoff-step]")).toBeNull();
    // The existing handoff pieces are still there, unchanged.
    expect(doc.querySelector("[data-handoff-steps]")).not.toBeNull();
    expect(doc.querySelector("[data-portal-links]")).not.toBeNull();
  });

  it.each(SESSION_STATUSES)("mounts exactly one next step inside the handoff (%s)", (status) => {
    const data = reviewData(FORM, status);
    const doc = render(<ReviewSectionContent data={data} />);
    const callouts = doc.querySelectorAll("[data-next-action]");
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.closest("[data-handoff]")).not.toBeNull();
    // The review section has not downloaded anything yet on first render.
    expect(callouts[0]!.getAttribute("data-next-action")).toBe(
      nextHandoffAction({
        sessionStatus: status,
        downloaded: false,
        stillNeededCount: data.toResolve.length,
      }).kind,
    );
    // The existing handoff pieces are still there, unchanged.
    expect(doc.querySelector("[data-handoff-steps]")).not.toBeNull();
    expect(doc.querySelector("[data-portal-links]")).not.toBeNull();
  });

  describe("after a real download", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      document.body.replaceChildren();
    });

    it("moves the next step from download to mark handed off", async () => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      // The fill route answers with the filled PDF. jsdom has no object
      // URLs and no navigation, so the blob URL and the anchor click are
      // stubbed for this test only and restored after it.
      const fetchSpy = vi.fn(() =>
        Promise.resolve(new Response(new Blob(["%PDF-1.7"]), { status: 200 })),
      );
      vi.stubGlobal("fetch", fetchSpy);
      const { createObjectURL, revokeObjectURL } = URL;
      URL.createObjectURL = () => "blob:filled-form";
      URL.revokeObjectURL = () => undefined;
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => undefined);
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(<ReviewSectionContent data={reviewData(FORM, "prepared")} />);
        });
        const nextAction = () =>
          container.querySelector("[data-next-action]")?.getAttribute("data-next-action");
        const handOff = () =>
          container.querySelector<HTMLButtonElement>('[data-action="hand-off"]');
        expect(nextAction()).toBe("download");
        // The download step says a download here is what lets the person
        // mark it handed off, which holds on a fresh view as well (after a
        // reload, say): the button stays off until this view downloads.
        expect(container.querySelector("[data-next-action]")?.textContent).toContain(
          "download it again here, and then you can mark it handed off",
        );
        expect(handOff()?.disabled).toBe(true);

        const download = container.querySelector<HTMLButtonElement>('[data-action="download"]');
        await act(async () => {
          download?.click();
          for (let tick = 0; tick < 10; tick += 1) {
            await new Promise((done) => setTimeout(done, 0));
          }
        });

        expect(fetchSpy).toHaveBeenCalledWith(`/api/forms/${FORM}/fill`, { method: "POST" });
        expect(clickSpy).toHaveBeenCalled();
        expect(nextAction()).toBe("mark_handed_off");
        expect(container.querySelector("[data-where]")?.textContent).toBe("In the app");
        expect(handOff()?.disabled).toBe(false);
      } finally {
        await act(async () => {
          root.unmount();
        });
        clickSpy.mockRestore();
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = revokeObjectURL;
      }
    });
  });
});
