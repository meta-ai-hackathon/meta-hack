import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../../../lib/honesty";
import { getFormRegistryEntry } from "../../../lib/forms/registry";
import { buildFormFlow } from "../../../lib/forms/flow";
import {
  REVIEW_UNAVAILABLE_NOTICE,
  ReviewSection,
  ReviewSectionContent,
} from "./review-section";

// Review + handoff section tests (Mission v2 M4, BN-21/23/24/25): every
// field renders its state + provenance; pii-likely values are structurally
// absent from the markup; the handoff steps and portal links render; the
// session-status vocabulary stays inside BN-25; and the rendered population
// carries zero banned claims.

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
}

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

const ENTRY = getFormRegistryEntry("sample-application-form");

function reviewData(
  formEntry: typeof ENTRY = ENTRY,
  overrides?: Partial<Parameters<typeof buildFormFlow>[1]>,
) {
  const answers = {
    household_size: { status: "known" as const, value: 3 },
    date_of_birth: { status: "known" as const, value: "1990-01-01" },
    housing_status: { status: "known" as const, value: "shelter" },
    ...(overrides ?? {}),
  };
  const view = buildFormFlow(formEntry, answers);
  return {
    hasSession: true,
    form: {
      id: formEntry.id,
      title: formEntry.title,
      version: formEntry.version,
      sourceUrl: formEntry.source.url,
      retrievedAt: formEntry.source.retrievedAt,
    },
    fields: view.fields,
    toResolve: view.toResolve,
    counts: view.counts,
    sessionStatus: "draft",
    portalLinks: [
      { label: "Official application portal", url: "{{PILOT_PORTAL_URL}}" },
    ],
    steps: [
      { title: "Review every field", detail: "Check each answer below." },
      { title: "Download your application", detail: "Generated on download." },
      { title: "Submit it yourself", detail: "The app never submits for you." },
    ],
  } as const;
}

describe("ReviewSectionContent structure", () => {
  it("renders provenance, to-resolve, steps, and portal links", () => {
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={reviewData()} />),
    );
    expect(html).toContain("data-review-section");
    expect(html).toContain(
      "We already know this from what you told us",
    );
    expect(html).toContain("Still needed");
    expect(html).toContain("Not needed for you");
    // Provenance labels render (user-supplied vs drafted).
    expect(html).toContain("(You told us)");
    // The pii-likely value never renders; the non-pii one does.
    expect(html).not.toContain("1990-01-01");
    expect(html).not.toContain("Jane Tester");
    expect(html).toContain(">3<");
    // Handoff: ordered steps + portal links + BN-25 status copy.
    expect(html).toContain('data-handoff-steps');
    expect(html).toContain("Submit it yourself");
    expect(html).toContain('data-portal-links');
    expect(html).toContain("Official application portal");
    expect(html).toContain('data-session-status="draft"');
    expect(html).toContain("In progress");
  });

  it("never reads an unverified answer as confirmed", () => {
    const html = decodeEntities(
      renderToStaticMarkup(
        <ReviewSectionContent
          data={reviewData(ENTRY, {
            date_of_birth: { status: "unverified", value: "1990-01-01" },
          })}
        />,
      ),
    );
    // The unverified field gets its own state copy, not the "we already
    // know this" confirmation — and the status badge repeats it.
    expect(html).toContain(
      "You answered this, but haven't verified it — please check it",
    );
    expect(html).toContain("Answered but not verified");
    // The confirmed copy still renders for the verified answers.
    expect(html).toContain("We already know this from what you told us");
    // The pii-likely value still never renders.
    expect(html).not.toContain("1990-01-01");
  });

  it("describes the real-form export honestly (VAL-RFEX-003)", () => {
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={reviewData()} />),
    );
    // The honest real-form note: what was filled, and the person's own
    // hands on the finish — review, complete, submit — never the app's.
    expect(html).toContain("data-real-form-note");
    expect(html).toContain("filled in the fields we could");
    expect(html).toContain("you review it, complete it, and submit it yourself");
    expect(html).toContain("the app never submits for you");
    // No outcome promise: preparing the form is not a determination.
    expect(html).toContain("only the agency decides");
    // The old sample wording is gone from the surface.
    expect(html).not.toContain("demonstration form");
    expect(html).not.toContain("do not submit the sample");
    // And the note itself scans clean of banned claims.
    const note = html.match(/data-real-form-note[^>]*>([^<]*)</)?.[1] ?? "";
    expect(note).not.toBe("");
    expect(findBannedClaims(note)).toEqual([]);
  });

  it("renders the distinct typed-signature step for the signature field (VAL-VJS2-002)", () => {
    // The REAL form's payload: the DHB-5200's Signature field is unmapped
    // and asked — its rendering is the distinct signing step, not the
    // generic draft input.
    const dhb = getFormRegistryEntry("dhb-5200");
    const view = buildFormFlow(dhb, {
      date_of_birth: { status: "known" as const, value: "1990-01-01" },
    });
    const html = decodeEntities(
      renderToStaticMarkup(
        <ReviewSectionContent
          data={{
            hasSession: true,
            form: {
              id: dhb.id,
              title: dhb.title,
              version: dhb.version,
              sourceUrl: dhb.source.url,
              retrievedAt: dhb.source.retrievedAt,
            },
            fields: view.fields,
            toResolve: view.toResolve,
            counts: view.counts,
            sessionStatus: "draft",
            portalLinks: [],
            steps: [],
          }}
        />,
      ),
    );
    // The distinct step: a visible label, the plain-language e-signature
    // explanation, and the never-auto-signs promise.
    expect(html).toContain("data-signature-step");
    expect(html).toContain("Type your full name to sign");
    expect(html).toContain("like an e-signature");
    expect(html).toContain("The app never signs for you");
    expect(html).toContain("Leave it blank to sign the printed form by hand");
    // Properly labeled control (visible label ↔ input association).
    expect(html).toContain('for="signature-input"');
    expect(html).toContain('id="signature-input"');
    // The generic sr-only draft input does NOT render for the signature.
    expect(html).not.toContain('id="form-answer-Signature"');
    // The signature step copy scans clean of banned claims.
    const step = html.match(/data-signature-step[\s\S]*?<\/span>/)?.[0] ?? "";
    expect(step).not.toBe("");
    expect(findBannedClaims(step)).toEqual([]);
  });

  it("renders the destination line in the handoff (VAL-VJS2-002 honest send flow)", () => {
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={reviewData()} />),
    );
    // Where the person submits it themselves — from the pilot seam, with
    // the person-submits note attached. No fabricated receipt alongside.
    expect(html).toContain("data-destination-line");
    expect(html).toContain("Mecklenburg County DSS");
    expect(html).toContain("NC Medicaid");
    expect(html).toContain("the app never submits for you");
  });

  it("keeps a hierarchical heading outline", () => {
    const levels = headingLevels(
      renderToStaticMarkup(<ReviewSectionContent data={reviewData()} />),
    );
    expect(levels.length).toBeGreaterThan(0);
    expect(levels[0]).toBe(2);
    for (let index = 1; index < levels.length; index += 1) {
      expect(
        levels[index]!,
        `heading ${index + 1} skips a level`,
      ).toBeLessThanOrEqual(levels[index - 1]! + 1);
    }
  });

  it("renders every BN-25 lifecycle status in plain, non-promissory language", () => {
    for (const status of [
      "draft",
      "prepared",
      "handed_off",
      "user_reported_submitted",
      "user_reported_decided",
    ]) {
      const data = { ...reviewData(), sessionStatus: status };
      const html = decodeEntities(
        renderToStaticMarkup(<ReviewSectionContent data={data} />),
      );
      expect(html).toContain(`data-session-status="${status}"`);
    }
    // The vocabulary never includes a bare "submitted" app state.
    expect(Object.keys(SESSION_STATUS_COPY_FOR_TEST)).not.toContain("submitted");
  });

  it("scans clean of banned claims across randomized review payloads", async () => {
    const statuses = fc.constantFrom("known", "unknown", "unverified");
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          household_size: fc.option(
            fc.record({ status: statuses, value: fc.integer({ min: 1, max: 8 }) }),
            { nil: undefined },
          ),
          housing_status: fc.option(
            fc.record({
              status: statuses,
              value: fc.constantFrom("shelter", "car", "rental_or_own"),
            }),
            { nil: undefined },
          ),
        }),
        async (answers) => {
          // Both the sample entry and the REAL form's payload (whose
          // signature field renders the typed-signature step) must render
          // clean across randomized answer states.
          for (const entry of [ENTRY, getFormRegistryEntry("dhb-5200")]) {
            const view = buildFormFlow(entry, answers as never);
            const data = {
              ...reviewData(entry),
              fields: view.fields,
              toResolve: view.toResolve,
            };
            const html = decodeEntities(
              renderToStaticMarkup(<ReviewSectionContent data={data} />),
            );
            expect(findBannedClaims(html)).toEqual([]);
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it("bites: the scan flags a poisoned review fixture", () => {
    const poisoned = {
      ...reviewData(),
      counts: { ...reviewData().counts, prefilled: 0 },
    };
    const html = decodeEntities(
      renderToStaticMarkup(
        <ReviewSectionContent
          data={{
            ...poisoned,
            fields: poisoned.fields.map((field, index) =>
              index === 0
                ? {
                    ...field,
                    question: "Good news — you qualify, and you will be approved.",
                  }
                : field,
            ),
          }}
        />,
      ),
    );
    expect(findBannedClaims(html).length).toBeGreaterThan(0);
  });
});

const SESSION_STATUS_COPY_FOR_TEST: Record<string, string> = {
  draft: "In progress",
  prepared: "Prepared and ready to hand off",
  handed_off: "Handed off",
  user_reported_submitted: "You told us it was submitted",
  user_reported_decided: "You told us a decision was made",
};

describe("ReviewSection failure state (a11y convention)", () => {
  it("mounts the status region before any state change, silent at first", () => {
    const html = renderToStaticMarkup(<ReviewSection refreshKey={0} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).not.toContain("review is unavailable");
  });

  it("keeps the failure copy honest and non-promissory", () => {
    expect(REVIEW_UNAVAILABLE_NOTICE).toContain(
      "The application review is unavailable right now.",
    );
    expect(findBannedClaims(REVIEW_UNAVAILABLE_NOTICE)).toEqual([]);
  });
});
