// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFormFlow } from "../../../lib/forms/flow";
import { buildDispositionReport } from "../../../lib/forms/disposition";
import { getFormRegistryEntry } from "../../../lib/forms/registry";
import { findBannedClaims } from "../../../lib/honesty";
import { PILOT_CONFIG } from "../../../lib/pilot";
import type { AnswerMap } from "../../../lib/intake/flow";
import { AlsoPrepareSection } from "./also-prepare-section";
import { ReviewSectionContent } from "./review-section";

// The ask-once reuse entry point (snap-form milestone part 2, VAL-SNAP-005):
// the results/review surface exposes a visible, honest "Also prepare your
// SNAP application (DSS-8207)" control that navigates to the SNAP review —
// keyboard-operable, named for assistive tech, copy that promises nothing.
// The SNAP review itself renders the form's OWN coverage arithmetic with
// per-field provenance and the still-needed list (VAL-SNAP-006/013/014).

const SNAP = PILOT_CONFIG.additionalApplications.find(
  (application) => application.formRegistryId === "dss-8207",
)!;

const DSS_ENTRY = getFormRegistryEntry("dss-8207");

/** A review payload for the dss-8207, built the way the route builds it. */
function dssReviewPayload(answers: AnswerMap) {
  const view = buildFormFlow(DSS_ENTRY, answers);
  return {
    hasSession: true as const,
    form: {
      id: DSS_ENTRY.id,
      title: DSS_ENTRY.title,
      version: DSS_ENTRY.version,
      sourceUrl: DSS_ENTRY.source.url,
      retrievedAt: DSS_ENTRY.source.retrievedAt,
    },
    programName: SNAP.programName,
    countyName: PILOT_CONFIG.countyName,
    fields: view.fields,
    toResolve: view.toResolve,
    counts: view.counts,
    coverage: buildDispositionReport(DSS_ENTRY),
    sessionStatus: "draft",
    portalLinks: SNAP.portalLinks,
    steps: [
      { title: "Review every field", detail: "Check each answer below." },
      { title: "Download your application", detail: "Generated on download." },
      { title: "Submit it yourself", detail: "The app never submits for you." },
    ],
  };
}

const carriedAnswers: AnswerMap = {
  state: { status: "known", value: "NC" },
  housing_status: { status: "known", value: "rental_or_own" },
  housing_cost: { status: "known", value: 900 },
  utilities_cost: { status: "known", value: 140 },
  veteran_status: { status: "known", value: false },
  received_benefits_before: { status: "known", value: true },
  contact_preference: { status: "known", value: "call" },
  date_of_birth: { status: "known", value: "1988-04-12" },
  phone_contact: { status: "known", value: "704-555-0134" },
};

function decodeEntities(html: string): string {
  // `&amp;` decodes LAST: decoding it first would turn an original
  // "&amp;lt;" into "<" — the double-escape CodeQL flags.
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

describe("AlsoPrepareSection — the entry point", () => {
  it("renders the honest entry point from the pilot seam, control named and keyboard-operable", () => {
    const html = decodeEntities(
      renderToStaticMarkup(<AlsoPrepareSection refreshKey={0} />),
    );
    expect(html).toContain("data-also-prepare-section");
    expect(html).toContain('data-also-prepare="dss-8207"');
    // The honest headline + framing copy (VAL-SNAP-005), no promises.
    expect(html).toContain(SNAP.entryPoint.headline);
    expect(html).toContain(SNAP.entryPoint.detail);
    // The control: a native button (keyboard-operable) with an accessible
    // name, wired as a disclosure of the SNAP review region.
    expect(html).toMatch(/<button /);
    expect(html).toContain(SNAP.entryPoint.action);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/aria-controls="also-prepare-review-[^"]+"/);
    // The review section is NOT mounted until the person asks for it.
    expect(html).not.toContain('data-review-form="dss-8207"');
  });

  it("entry-point copy carries zero banned claims", () => {
    const html = decodeEntities(
      renderToStaticMarkup(<AlsoPrepareSection refreshKey={0} />),
    );
    expect(findBannedClaims(html)).toEqual([]);
  });

  it("a SNAP promise fixture bites the detector (VAL-SNAP-013)", () => {
    // The seeded violation: eligibility phrasing on the SNAP surface must
    // be flagged, while the shipped copy passes (the test above).
    const violation =
      "Great news — based on your answers, you qualify for SNAP benefits.";
    expect(findBannedClaims(violation).length).toBeGreaterThan(0);
  });
});

describe("AlsoPrepareSection — revealing the SNAP review", () => {
  const actGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let previousActEnvironment: boolean | undefined;

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    if (previousActEnvironment === undefined) {
      delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
    } else {
      actGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  function renderSection(): {
    container: HTMLDivElement;
    root: ReturnType<typeof createRoot>;
  } {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    return { container, root };
  }

  async function flush(ticks = 10): Promise<void> {
    for (let tick = 0; tick < ticks; tick += 1) {
      await new Promise((done) => setTimeout(done, 0));
    }
    // The announce convention sets its text on a 30 ms timer (clear, then
    // set on the next tick); give the timer real time to fire.
    await new Promise((done) => setTimeout(done, 60));
  }

  it("the control navigates to the SNAP review: reveal, fetch the dss-8207 payload, move focus, announce", async () => {
    previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = true;

    const fetchSpy = vi.fn(() =>
      Promise.resolve(Response.json(dssReviewPayload(carriedAnswers))),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { container, root } = renderSection();
    try {
      await act(async () => {
        root.render(<AlsoPrepareSection refreshKey={0} />);
      });
      await act(async () => {
        await flush();
      });

      const button = container.querySelector<HTMLButtonElement>(
        "[data-also-prepare-button='dss-8207']",
      );
      expect(button).not.toBeNull();
      expect(button?.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        button?.click();
        await flush();
      });

      // The SNAP review surface is mounted for the dss-8207, and the
      // route that served it is the form's own.
      expect(fetchSpy).toHaveBeenCalledWith("/api/forms/dss-8207/review");
      const review = container.querySelector("[data-review-form='dss-8207']");
      expect(review).not.toBeNull();
      // The disclosure state is honest: expanded, entry control gone.
      expect(container.querySelector("[data-also-prepare-entry]")).toBeNull();
      // The two review sections must never share a DOM id: both
      // registries carry generic field names (Text5, Text6, ...), and the
      // labelled controls are per-form (axe duplicate-id-aria).
      const ids = [...container.querySelectorAll("[id]")].map(
        (element) => element.id,
      );
      expect(new Set(ids).size).toBe(ids.length);
      // Focus moved to the revealed region (the "navigation" for keyboard
      // and screen-reader users).
      expect(document.activeElement?.hasAttribute("tabindex")).toBe(true);
      // The change is announced through the live region (this section's
      // own StatusRegion, not the review's).
      const region = container.querySelector(
        "[data-also-prepare-status] [role='status']",
      );
      expect(region?.textContent).toContain("SNAP");
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("the revealed SNAP review shows the form's OWN coverage arithmetic, provenance, and still-needed list (VAL-SNAP-006)", () => {
    const payload = dssReviewPayload(carriedAnswers);
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={payload} />),
    );

    // The coverage rows are the DSS-8207's own — 575 fillable, 525 take
    // the answers — never the DHB-5200's numbers.
    expect(html).toContain("data-field-coverage");
    expect(html).toContain("575 fillable boxes and lines");
    expect(html).toContain("525 of them take your answers");
    expect(html).toContain('data-coverage-count="575"');
    // The still-needed list renders (most mapped fields have no answer).
    expect(html).toContain("data-form-to-resolve");
    expect(html).toContain("Still needed on the form");
    // Carried values render with their provenance (ask-once, not re-asked).
    expect(html).toContain('data-review-form="dss-8207"');
    expect(html).toContain(">900<");
    expect(html).toContain("(You told us)");
    // The pii values never render; the status badge speaks for them.
    expect(html).not.toContain("1988-04-12");
    expect(html).not.toContain("704-555-0134");
    // Zero banned claims anywhere on the rendered surface.
    expect(findBannedClaims(html)).toEqual([]);
  });

  it("the rendered coverage reconciles: buckets sum to the registry total", () => {
    const payload = dssReviewPayload(carriedAnswers);
    const counts = payload.coverage.counts;
    const sum =
      counts.mapped +
      counts.not_collected_by_interview +
      counts.optional_unanswered +
      counts.agency_use_only +
      counts.duplicate_structural;
    expect(sum).toBe(counts.total);
    expect(counts.total).toBe(DSS_ENTRY.fields.length);
  });

  it("the revealed additional review leaves the session lifecycle to the primary review (claude-review P2, PR #121)", async () => {
    previousActEnvironment = actGlobal.IS_REACT_ACT_ENVIRONMENT;
    actGlobal.IS_REACT_ACT_ENVIRONMENT = true;

    const fetchSpy = vi.fn(() =>
      Promise.resolve(Response.json(dssReviewPayload(carriedAnswers))),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const { container, root } = renderSection();
    try {
      await act(async () => {
        root.render(<AlsoPrepareSection refreshKey={0} />);
      });
      await act(async () => {
        await flush();
      });

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            "[data-also-prepare-button='dss-8207']",
          )
          ?.click();
        await flush();
      });

      const review = container.querySelector("[data-review-form='dss-8207']");
      expect(review).not.toBeNull();
      // No session-lifecycle controls: the BN-25 status is one per
      // session, and the additional review is a preparation surface —
      // marking the package prepared here would misstate the primary.
      expect(review?.querySelector("[data-session-status]")).toBeNull();
      expect(review?.querySelector("[data-action='prepare']")).toBeNull();
      expect(review?.querySelector("[data-action='hand-off']")).toBeNull();
      expect(
        review?.querySelector("[data-action='report-submitted']"),
      ).toBeNull();
      // The download stays (per-form, real), and the note says where the
      // package steps live.
      expect(review?.querySelector("[data-action='download']")).not.toBeNull();
      const note = review?.querySelector("[data-lifecycle-owner-note]");
      expect(note?.textContent).toContain("marked on the");
      expect(note?.textContent).toContain(PILOT_CONFIG.programName);
    } finally {
      await act(async () => {
        root.unmount();
      });
    }
  });

  it("the default review (no ownsSessionLifecycle prop) still renders the lifecycle controls", () => {
    const payload = dssReviewPayload(carriedAnswers);
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={payload} />),
    );
    expect(html).toContain("data-session-status");
    expect(html).toContain('data-action="prepare"');
    expect(html).toContain('data-action="report-submitted"');
    expect(html).not.toContain("data-lifecycle-owner-note");
  });
});
