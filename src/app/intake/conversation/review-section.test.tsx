import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../../../lib/honesty";
import { getFormRegistryEntry } from "../../../lib/forms/registry";
import { buildFormFlow } from "../../../lib/forms/flow";
import { buildDispositionReport } from "../../../lib/forms/disposition";
import {
  REVIEW_UNAVAILABLE_NOTICE,
  ReviewSection,
  ReviewSectionContent,
  pagePointer,
} from "./review-section";

// Review + handoff section tests (Mission v2 M4, BN-21/23/24/25; HACK-153 +
// HACK-154 + HACK-119 restructure): the download and the next step lead,
// beside a one-line filled/remaining count; the remaining fields render
// collapsed by default, grouped by form page, listed once, and scoped to
// the people actually on the application; yes/no fields render as a
// Yes/No pair; each answer carries one label, not three; pii-likely values
// are structurally absent; the session-status vocabulary stays inside
// BN-25; and the rendered population carries zero banned claims.

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
    // The household size the session answered (the route carries it for
    // the person scoping; it is a plain, non-pii answer).
    householdSize: 3,
    fields: view.fields,
    toResolve: view.toResolve,
    counts: view.counts,
    sessionStatus: "draft",
    portalLinks: [
      {
        label: "Official application portal",
        url: "{{PILOT_PORTAL_URL}}",
        retrievedAt: "2026-10-30",
      },
    ],
  } as const;
}

describe("ReviewSectionContent structure", () => {
  it("renders provenance, the collapsed remaining list, and the handoff pieces", () => {
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={reviewData()} />),
    );
    expect(html).toContain("data-review-section");
    // Provenance label on the prefilled answer — exactly one per answer.
    expect(html).toContain("(You told us)");
    // Handoff: portal links + BN-25 status copy. (The sourced next-step
    // companion needs the KB entry written for the form under review —
    // the real form's review mounts it; the sample fixture's doesn't.)
    expect(html).toContain('data-portal-links');
    expect(html).toContain("Official application portal");
    expect(html).toContain('data-session-status="draft"');
    expect(html).toContain("In progress");
  });

  it("puts the download, the next step, and the count at the top (HACK-153, HACK-119)", () => {
    // The REAL form's review: the KB companion backs its next-step box.
    const dhb = getFormRegistryEntry("dhb-5200");
    const view = buildFormFlow(dhb, {
      household_size: { status: "known" as const, value: 1 },
      date_of_birth: { status: "known" as const, value: "1990-01-01" },
    });
    const html = decodeEntities(
      renderToStaticMarkup(
        <ReviewSectionContent
          data={{
            ...reviewData(dhb, { household_size: { status: "known", value: 1 } }),
            householdSize: 1,
            fields: view.fields,
            toResolve: view.toResolve,
            counts: view.counts,
          }}
        />,
      ),
    );
    const nextAction = html.indexOf("data-next-action");
    const download = html.indexOf('data-action="download"');
    const count = html.indexOf("data-fill-count");
    const remaining = html.indexOf("data-review-remaining");
    for (const [what, at] of [
      ["the next-step box", nextAction],
      ["the download button", download],
      ["the filled/remaining count", count],
    ] as const) {
      expect(at, what).toBeGreaterThan(-1);
      expect(at, `${what} above the remaining-fields list`).toBeLessThan(remaining);
    }
    // The next-step box leads the handoff's own controls: it renders
    // before the lifecycle buttons, not below them (HACK-119).
    const prepare = html.indexOf('data-action="prepare"');
    expect(nextAction, "the next-step box leads the buttons").toBeLessThan(prepare);
  });

  it("points the download note's 'typed below' the right way — the typed fields render after it (HACK-161, VAL-UX-009)", () => {
    // HACK-153 moved the download to the top of the review, which also
    // settled the ticket's third direction complaint: today the typed
    // fields (the signature step and the remaining-fields list) really do
    // render BELOW the note under the download button. Pin the order so a
    // future re-layout cannot silently point the line the wrong way again.
    const dhb = getFormRegistryEntry("dhb-5200");
    const view = buildFormFlow(dhb, {
      household_size: { status: "known" as const, value: 1 },
      date_of_birth: { status: "known" as const, value: "1990-01-01" },
    });
    const html = decodeEntities(
      renderToStaticMarkup(
        <ReviewSectionContent
          data={{
            ...reviewData(dhb, { household_size: { status: "known", value: 1 } }),
            householdSize: 1,
            fields: view.fields,
            toResolve: view.toResolve,
            counts: view.counts,
          }}
        />,
      ),
    );
    const note = html.indexOf("data-download-note");
    const signature = html.indexOf("data-signature-step");
    const remaining = html.indexOf("data-review-remaining");
    expect(note, "the download note renders").toBeGreaterThan(-1);
    expect(note, "the typed signature step is below the note").toBeLessThan(signature);
    expect(note, "the typed remaining fields are below the note").toBeLessThan(remaining);
  });

  it("styles exactly one primary button (HACK-49 rule via HACK-119)", () => {
    const html = renderToStaticMarkup(<ReviewSectionContent data={reviewData()} />);
    // The primary style is the filled teal pill; every other control is
    // an outline. The download is the one primary button.
    const primary = [...html.matchAll(/<button[^>]*>/g)]
      .filter((match) => match[0].includes("bg-teal-deep"))
      .map((match) => match[0]);
    expect(primary).toHaveLength(1);
    expect(primary[0]).toContain('data-action="download"');
  });

  it("carries a one-line filled/remaining count near the summary (HACK-153)", () => {
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={reviewData()} />),
    );
    const count = html.match(/data-fill-count="([^"]+)"/)?.[1] ?? "";
    expect(count).toBe("3 of 10 fields");
    const line = html.match(/data-fill-reveal[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    expect(line).toContain("3 of 10 fields");
    expect(line).toContain("left to fill in");
  });

  it("renders the remaining fields collapsed by default, grouped by form page, listed once (HACK-153)", () => {
    const data = reviewData();
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={data} />),
    );
    // Collapsed: the details renders with no `open` attribute.
    const details = html.match(/<details[^>]*data-review-remaining[^>]*>/)?.[0] ?? "";
    expect(details).not.toBe("");
    expect(details).not.toContain("open");
    // Grouped by form step (the page of the form the field prints on).
    expect(html).toContain("Page 1 of the form");
    // Listed once: the old separate still-needed section is gone —
    // the collapsed list is the one place the blanks are named.
    expect(html).not.toContain("data-form-to-resolve");
    // Every still-needed field's question appears exactly once in the
    // whole markup.
    for (const item of data.toResolve) {
      const occurrences = html.split(item.question).length - 1;
      expect(occurrences, item.question).toBe(1);
    }
  });

  it("scopes the remaining fields to the people on the application (HACK-153)", () => {
    // The REAL form carries Person 2-6 sections; a one-person application
    // must not see them. The sample fixture has no per-person fields, so
    // this runs on the DHB-5200's payload.
    const dhb = getFormRegistryEntry("dhb-5200");
    const one = buildFormFlow(dhb, {
      household_size: { status: "known" as const, value: 1 },
      date_of_birth: { status: "known" as const, value: "1990-01-01" },
    });
    const html = decodeEntities(
      renderToStaticMarkup(
        <ReviewSectionContent
          data={{ ...reviewData(dhb, { household_size: { status: "known", value: 1 } }), householdSize: 1, fields: one.fields, toResolve: one.toResolve, counts: one.counts }}
        />,
      ),
    );
    expect(html).not.toContain("Person 2");
    // A one-person application still has its own remaining fields listed.
    expect(html).toContain("data-review-field");
    // When people ARE on the application, their fields show and later
    // persons' don't, and the prose accounting says the rest stay blank
    // to finish by hand.
    const three = buildFormFlow(dhb, {
      household_size: { status: "known" as const, value: 3 },
      date_of_birth: { status: "known" as const, value: "1990-01-01" },
    });
    const threeHtml = decodeEntities(
      renderToStaticMarkup(
        <ReviewSectionContent
          data={{ ...reviewData(dhb, { household_size: { status: "known", value: 3 } }), fields: three.fields, toResolve: three.toResolve, counts: three.counts }}
        />,
      ),
    );
    expect(threeHtml).toContain("Person 2");
    expect(threeHtml).toContain("Person 3");
    expect(threeHtml).not.toContain("Person 4");
    // The prose accounting: the hidden per-person sections are said to
    // stay blank, to finish by hand.
    expect(threeHtml).toContain("finish it by hand");
  });

  it("renders yes/no fields as a Yes/No pair, never free text (HACK-153)", () => {
    // The REAL form's unmapped box fields (the sample fixture's one
    // checkbox is spec-linked, so its row points at the conversation).
    // Person 2's work-status line is an unmapped box pair.
    const dhb = getFormRegistryEntry("dhb-5200");
    const view = buildFormFlow(dhb, {
      household_size: { status: "known" as const, value: 3 },
      date_of_birth: { status: "known" as const, value: "1990-01-01" },
    });
    const html = decodeEntities(
      renderToStaticMarkup(
        <ReviewSectionContent
          data={{
            ...reviewData(dhb, { household_size: { status: "known", value: 3 } }),
            fields: view.fields,
            toResolve: view.toResolve,
            counts: view.counts,
          }}
        />,
      ),
    );
    const row =
      html.match(/<li[^>]*data-review-field="Employed_2"[\s\S]*?<\/li>/)?.[0] ?? "";
    expect(row).not.toBe("");
    expect(row).toContain('type="radio"');
    expect(row).toContain('value="checked"');
    expect(row).toContain('value="unchecked"');
    expect(row).toContain("Yes");
    expect(row).toContain("No");
    expect(row).not.toContain('type="text"');
  });

  it("carries exactly one label per prefilled answer, not three (HACK-154)", () => {
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={reviewData()} />),
    );
    // The old triple stack ("We already know this from what you told us"
    // + the "You told us" badge + the "(You told us)" parenthetical) is
    // one provenance label now.
    expect(html).not.toContain("We already know this from what you told us");
    const row = html.match(/<li[^>]*data-review-field="household_size_count"[\s\S]*?<\/li>/)?.[0] ?? "";
    expect(row.split("(You told us)").length - 1).toBe(1);
  });

  it("renders the tax-return provenances with plain-language labels (VAL-INC-010)", () => {
    // The confirm flow's provenances previously rendered EMPTY badges —
    // the part-3 ride-along gives both a label, and the labels are the
    // income stage's own origin-badge copy.
    const html = decodeEntities(
      renderToStaticMarkup(
        <ReviewSectionContent
          data={reviewData(ENTRY, {
            household_size: {
              status: "known",
              value: 3,
              provenance: "tax_return",
            },
            date_of_birth: {
              status: "known",
              value: "1990-01-01",
              provenance: "user",
            },
          })}
        />,
      ),
    );
    expect(html).toContain("(From your tax return)");
    expect(html).toContain("(You confirmed this)");
    // The labels are plain language, never promise language.
    expect(findBannedClaims("From your tax return. You confirmed this.")).toEqual([]);
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
    // The unverified field gets its own state copy, not a confirmation —
    // and the status badge repeats it.
    expect(html).toContain(
      "You answered this, but haven't verified it — please check it",
    );
    expect(html).toContain("Answered but not verified");
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

  it("describes the download as an on-device fill with the file disclosure (HACK-138)", () => {
    // The sanctioned-download rule's copy condition (rules.md, HACK-115),
    // beside the download button: the fill is made on the device from the
    // values the page holds, nothing is sent to make it, and the saved
    // file is disclosed (filled answers, private ones included,
    // unencrypted, delete it after). The private answers the page shows
    // only as a status badge stay blank on the file — said plainly.
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={reviewData()} />),
    );
    const note = html.match(/data-download-note[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    expect(note).not.toBe("");
    expect(note).toContain("filled right on this device");
    expect(note).toContain("no answers are sent");
    expect(note).toContain("stay blank on the file");
    expect(note).toContain("finish those lines by hand");
    // The file disclosure: what the file is, in plain language.
    expect(note).toContain("private ones included");
    expect(note).toContain("isn't encrypted");
    expect(note).toContain("delete it once you've printed or sent it");
    // The download copy scans clean of banned claims.
    expect(findBannedClaims(note)).toEqual([]);
  });

  it("renders the distinct typed-signature step for the signature field (VAL-VJS2-002)", () => {
    // The REAL form's payload: the DHB-5200's Signature field is unmapped
    // and asked — its rendering is the distinct signing step, not the
    // generic draft input, and it stays visible beside the download it
    // fills.
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
    // The signature renders OUTSIDE the collapsed list, beside the
    // download it fills — and never twice.
    const remaining = html.match(/<details[^>]*data-review-remaining[\s\S]*$/)?.[0] ?? "";
    expect(remaining).not.toContain('id="signature-input"');
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

  it("dates every official portal link (HACK-119: no bare unsourced links)", () => {
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={reviewData()} />),
    );
    const links = html.match(/<li[^>]*>\s*<a[^>]*>[\s\S]*?<\/li>/g) ?? [];
    const portalBlock = html.match(/data-portal-links[\s\S]*<\/ul>/)?.[0] ?? "";
    expect(portalBlock).not.toBe("");
    expect(portalBlock).toContain("retrieved 2026-10-30");
    expect(links.length).toBeGreaterThan(0);
  });

  it("renders the full-form disposition report when the payload carries it (VAL-FIX-007)", () => {
    const dhb = getFormRegistryEntry("dhb-5200");
    const data = { ...reviewData(dhb), coverage: buildDispositionReport(dhb) };
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={data} />),
    );
    // The summary arithmetic renders — the honest X-of-Y accounting over
    // all 21 pages, never a full-coverage claim.
    expect(html).toContain("data-field-coverage");
    expect(html).toContain("571 fillable boxes and lines");
    expect(html).toContain("355 of them take your answers");
    // The not-collected rows are an instruction, not a shrug: they stay
    // blank on the download so the person completes them by hand
    // (claude-review P2 on this PR).
    expect(html).toContain("complete those by hand if they apply to you");
    // Each row points at where the box sits on the printed form (the
    // follow-up P2: an applicant can act on "page 16", not on developer
    // notes about templates).
    expect(html).toContain("page 16 of the form");
    expect(html).not.toContain("the template's tooltip is undefined");
    expect(html).not.toContain("The form author embedded");
    // The blank-by-disposition rows render with their class copy, so
    // nothing is silently unmapped.
    expect(html).toContain("data-coverage-field=");
    expect(html).toContain("This conversation doesn't collect it");
    expect(html).toContain("A printed line, not an answer box");
    // And the rendered report scans clean of banned claims.
    expect(findBannedClaims(html)).toEqual([]);
  });

  it("renders the all-mapped coverage case honestly (nothing skipped)", () => {
    const data = { ...reviewData(), coverage: buildDispositionReport(ENTRY) };
    const html = decodeEntities(
      renderToStaticMarkup(<ReviewSectionContent data={data} />),
    );
    expect(html).toContain("data-coverage-all-mapped");
    expect(html).toContain("nothing was skipped");
  });

  it("points the blank-field rows at deduped, sorted form pages", () => {
    // Single page — the common row.
    expect(pagePointer([16])).toBe("page 16 of the form");
    // Multi-page: sorted, joined.
    expect(pagePointer([17, 16])).toBe("pages 16 and 17 of the form");
    expect(pagePointer([18, 16, 17])).toBe("pages 16, 17 and 18 of the form");
    // Duplicates collapse (a two-widget field lists its page once).
    expect(pagePointer([19, 19])).toBe("page 19 of the form");
    // Empty input — impossible from the committed registry (schema
    // minItems: 1) — never renders "undefined" at a person.
    expect(pagePointer([])).toBe("the form");
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

  it(
    "scans clean of banned claims across randomized review payloads",
    // Each run renders BOTH the sample and the real form payload and scans
    // the HTML; 25 runs exceed Vitest's 5s default on a slower dev machine.
    { timeout: 20000 },
    async () => {
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
