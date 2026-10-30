import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../../lib/honesty";
import { parseKbEntry } from "../../lib/kb";
import { addDays, fromEpochDay, parseIsoDate, toEpochDay, type CalendarDate } from "../../lib/renewal/calendar-date";
import {
  ESTIMATE_EXPLAINER,
  NO_ESTIMATE_NOTE,
  ONE_ESTIMATE_EXPLAINER,
  PASSED_ADVICE,
  PASSED_ESTIMATE_ADVICE,
  STALE_ESTIMATE_NOTE,
} from "../../lib/renewal/copy";
import { AGE_ANSWERS, type AgeAnswer } from "../../lib/renewal/estimate";
import { buildRenewalFactsView, PILOT_RENEWAL_FACTS } from "../../lib/renewal/renewal-facts";
import pilotEntryJson from "../../../kb/pilot/nc-medicaid-renewal.json";
import { RenewalFactsSection, ReportedDateView } from "./renewal-view";

// Label rendering (HACK-50 acceptance): knowledge-base dates and facts are
// labeled "From NC Medicaid" with their source; the person's date is
// labeled "You told us"; estimates are labeled as estimates. The four UI
// states (no date, a date, within 30 days, past due) render from the same
// components, and every state's markup passes the banned-claim gate.

const FACTS = PILOT_RENEWAL_FACTS;
const d = (iso: string): CalendarDate => parseIsoDate(iso)!;

function decode(html: string): string {
  // `&amp;` decodes LAST: decoding it first would turn an original
  // "&amp;lt;" into "<" — the double-escape CodeQL flags.
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]));
}

/** The list items carrying a fact, as markup strings. */
function factItems(html: string): string[] {
  return [...html.matchAll(/<li[^>]*data-renewal-fact[^>]*>([\s\S]*?)<\/li>/g)].map((match) => match[0]);
}

const renderReported = (
  kind: "renewal_due" | "approval",
  reportedDate: string,
  today: string,
  ageAnswer?: AgeAnswer,
  facts = FACTS,
) =>
  decode(
    renderToStaticMarkup(
      <ReportedDateView
        facts={facts}
        reminder={{ kind, reportedDate, ...(ageAnswer !== undefined ? { ageAnswer } : {}) }}
        today={d(today)}
      />,
    ),
  );

const MONTH_DATE = /(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}/;

/**
 * The text of a markup fragment: every character outside a tag. A loop
 * rather than a regex replace, which CodeQL flags because one pass can
 * leave a tag start such as "<script" behind.
 */
function textOutsideTags(markup: string): string {
  let text = "";
  let inTag = false;
  for (const char of markup) {
    if (char === "<") {
      inTag = true;
    } else if (char === ">" && inTag) {
      inTag = false;
    } else if (!inTag) {
      text += char;
    }
  }
  return text;
}

/** Every paragraph or list item that shows a date, as text, with whether it carries its origin. */
function dateBlocks(html: string): { text: string; labeled: boolean }[] {
  return [...html.matchAll(/<(li|p)\b[^>]*>([\s\S]*?)<\/\1>/g)]
    .map((match) => ({ markup: match[0], text: textOutsideTags(match[2]!) }))
    .filter((block) => MONTH_DATE.test(block.text))
    .map((block) => ({
      text: block.text,
      labeled: /data-origin="/.test(block.markup) || /you told us|estimate/i.test(block.text),
    }));
}

function staleFacts() {
  const raw = structuredClone(pilotEntryJson) as Record<string, unknown>;
  raw.status = "stale";
  raw.status_reason = "The source page changed after it was read.";
  return buildRenewalFactsView(parseKbEntry(raw));
}

describe("knowledge-base facts: labeled and sourced", () => {
  const html = decode(renderToStaticMarkup(<RenewalFactsSection facts={FACTS} />));

  it("labels every fact 'From NC Medicaid' with a source link, retrieval date, and version", () => {
    const items = factItems(html);
    const expected =
      FACTS.schedules.length +
      FACTS.keyDates.length +
      FACTS.deadlineNotes.length +
      FACTS.steps.length +
      FACTS.documents.length +
      FACTS.rules.length +
      FACTS.ifCoverageEnds.length +
      FACTS.links.length;
    expect(items.length).toBe(expected);
    for (const item of items) {
      expect(item).toContain('data-origin="official"');
      expect(item).toContain("From NC Medicaid");
      expect(item).toMatch(/Source: <a href="https:\/\/[^"]+(ncdhhs|nc)\.gov\//);
      expect(item).toMatch(/retrieved \d{4}-\d{2}-\d{2}, entry version \d+/);
      expect(item).not.toContain('data-origin="user"');
      expect(item).not.toContain('data-origin="estimate"');
    }
  });

  it("renders the January 1, 2027 change as a machine-readable, labeled date", () => {
    expect(html).toContain('<time dateTime="2027-01-01">January 1, 2027</time>');
    expect(html).toContain('data-renewal-key-date="2027-01-01"');
    expect(html).toContain("Every 6 months");
    expect(html).toContain("Once a year");
  });

  it("keeps the heading outline under the page's h1", () => {
    const levels = headingLevels(html);
    expect(levels[0]).toBe(2);
    expect(levels.slice(1).every((level) => level === 3)).toBe(true);
  });

  it("flags a stale entry visibly and shows nothing from a withdrawn one (BN-29)", () => {
    const raw = structuredClone(pilotEntryJson) as Record<string, unknown>;
    raw.status = "stale";
    raw.status_reason = "The source page changed after it was read.";
    const stale = decode(renderToStaticMarkup(<RenewalFactsSection facts={buildRenewalFactsView(parseKbEntry(raw))} />));
    expect(stale).toContain('data-renewal-entry-status="stale"');
    expect(stale).toContain("may be out of date");
    expect(stale).toContain("The source page changed after it was read.");
    expect(factItems(stale).length).toBeGreaterThan(0);

    raw.status = "withdrawn";
    const withdrawn = decode(renderToStaticMarkup(<RenewalFactsSection facts={buildRenewalFactsView(parseKbEntry(raw))} />));
    expect(withdrawn).toContain('data-renewal-entry-status="withdrawn"');
    expect(factItems(withdrawn)).toEqual([]);
  });
});

describe("the person's date: labeled as theirs, in every state", () => {
  it("a saved date more than 30 days out: 'You told us', no reminder box yet", () => {
    const html = renderReported("renewal_due", "2027-04-30", "2026-10-29");
    expect(html).toContain('data-origin="user"');
    // The label is said once (review a11y fix), then the sentence.
    expect(html).toContain("You told us</span> Your renewal is due on April 30, 2027.");
    expect(html).not.toContain("You told us</span> You told us");
    expect(html).toContain('data-reminder-phase="later"');
    expect(html).not.toContain('data-origin="official"');
    expect(html).not.toContain('data-origin="estimate"');
  });

  it("within 30 days: the reminder speaks", () => {
    const html = renderReported("renewal_due", "2027-04-30", "2027-04-18");
    expect(html).toContain('data-reminder-phase="soon"');
    expect(html).toContain("Reminder: you told us your NC Medicaid renewal is due in 12 days, on April 30, 2027.");
  });

  it("on the day", () => {
    const html = renderReported("renewal_due", "2027-04-30", "2027-04-30");
    expect(html).toContain('data-reminder-phase="today"');
    expect(html).toContain("is due today, April 30, 2027.");
  });

  it("past due: says so and points to the official steps", () => {
    const html = renderReported("renewal_due", "2027-04-30", "2027-05-03");
    expect(html).toContain('data-reminder-phase="passed"');
    expect(html).toContain("The NC Medicaid renewal date you told us, April 30, 2027, has passed.");
    expect(html).toContain(PASSED_ADVICE);
  });

  it("an approval date: estimates labeled as estimates, each with the official schedule it assumes", () => {
    const html = renderReported("approval", "2026-10-15", "2026-10-29");
    expect(html).toContain("The letter that said the coverage was approved or renewed is dated October 15, 2026.");
    const estimates = [...html.matchAll(/<li data-renewal-estimate="([a-z0-9_]+)">([\s\S]*?)<\/li>/g)];
    expect(estimates.map((match) => match[1])).toEqual(["every_6_months", "once_a_year"]);
    for (const [, , body] of estimates) {
      expect(body).toContain('data-origin="estimate"');
      expect(body).toContain("Estimate, not an official date");
      expect(body).toContain('data-origin="official"');
      expect(body).toMatch(/Source: <a href="https:\/\//);
    }
    expect(html).toContain("If your renewal comes every 6 months, it may be due around April 15, 2027.");
    expect(html).toContain("If your renewal comes once a year, it may be due around October 15, 2027.");
    expect(html).toContain("These are estimates, not official dates.");
  });

  it("an approval date before the cutover: only the yearly estimate", () => {
    const html = renderReported("approval", "2026-03-01", "2026-10-29");
    expect(html).not.toContain('data-renewal-estimate="every_6_months"');
    expect(html).toContain('data-renewal-estimate="once_a_year"');
  });

  it("words the explainer for the number of estimates shown (second review fix)", () => {
    // One estimate (before the cutover, or an age answer of no): no "either date".
    for (const html of [
      renderReported("approval", "2026-03-01", "2026-10-29"),
      renderReported("approval", "2026-10-15", "2026-10-29", { min: 19, max: 64, answer: "no" }),
    ]) {
      expect(html).toContain(ONE_ESTIMATE_EXPLAINER);
      expect(html).not.toContain(ESTIMATE_EXPLAINER);
      expect(html).not.toMatch(/either date/);
    }
    // No estimate at all: only the note that says so.
    const none = renderReported("approval", "2026-10-15", "2026-10-29", undefined, { ...FACTS, schedules: [] });
    expect(none).toContain(NO_ESTIMATE_NOTE);
    expect(none).not.toContain(ONE_ESTIMATE_EXPLAINER);
    expect(none).not.toContain(ESTIMATE_EXPLAINER);
    // Any approval date and age answer: "either date" exactly when two or more estimates show.
    const day = fc.integer({ min: toEpochDay(d("2025-01-01")), max: toEpochDay(d("2027-12-31")) }).map(fromEpochDay);
    const answer = fc.option(fc.constantFrom(...AGE_ANSWERS), { nil: undefined });
    fc.assert(
      fc.property(day, answer, (date, value) => {
        const iso = `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
        const html = renderReported("approval", iso, "2028-06-01", value === undefined ? undefined : { min: 19, max: 64, answer: value });
        const shown = (html.match(/data-renewal-estimate="/g) ?? []).length;
        expect(/either date/.test(html), `${iso} ${value ?? "none"}`).toBe(shown >= 2);
        expect(html.includes(ONE_ESTIMATE_EXPLAINER)).toBe(shown === 1);
      }),
      { numRuns: 200 },
    );
  });

  it("renders nothing for a date it cannot read", () => {
    expect(renderReported("renewal_due", "2027-02-30", "2026-10-29")).toBe("");
  });

  it("past due: shows what NC Medicaid says about coverage ending, labeled and sourced (review fix)", () => {
    const html = renderReported("renewal_due", "2027-04-30", "2027-05-03");
    const box = html.slice(html.indexOf('data-reminder-phase="passed"'));
    expect(box).toContain("If your coverage ends");
    expect(box).toContain("You usually have 60 days from the date on the letter.");
    expect(box).toContain("1-877-201-3750");
    const items = [...box.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((match) => match[1]!);
    expect(items.length).toBe(FACTS.ifCoverageEnds.length);
    for (const item of items) {
      expect(item).toContain('data-origin="official"');
      expect(item).toMatch(/Source: <a href="https:\/\/medicaid\.ncdhhs\.gov\//);
    }
  });
});

describe("approval dates after an estimate passes (review fix: the reminder must not go quiet)", () => {
  it("names the passed estimate, gives the next one, and says to check the mail", () => {
    // The trust review's case: approval 2026-08-01, estimates 2027-02-01 and 2027-08-01.
    const html = renderReported("approval", "2026-08-01", "2027-02-02");
    expect(html).toContain('data-reminder-phase="passed"');
    expect(html).toContain(
      "An estimated NC Medicaid renewal date, February 1, 2027, has passed. The next estimate is August 1, 2027.",
    );
    expect(html).toContain(PASSED_ESTIMATE_ADVICE);
    expect(html).not.toMatch(/earliest/i);
  });

  it("speaks for the next estimate once it is inside the window", () => {
    const html = renderReported("approval", "2026-08-01", "2027-07-20");
    expect(html).toContain('data-reminder-phase="soon"');
    expect(html).toContain("may be due in about 12 days, around August 1, 2027");
  });
});

describe("the age answer (review fix: the 6-month schedule is for ages 19 through 64)", () => {
  it("drops the 19-64 estimate for 'no' and says so, with the answer labeled as the person's", () => {
    const html = renderReported("approval", "2026-10-15", "2026-10-29", { min: 19, max: 64, answer: "no" });
    expect(html).not.toContain('data-renewal-estimate="every_6_months"');
    expect(html).toContain('data-renewal-estimate="once_a_year"');
    expect(html).toContain('data-renewal-left-out="every_6_months"');
    expect(html).toContain('You said the person is younger than 19 or older than 64, so there is no "Every 6 months" estimate.');
    // The scope that leaves it out is shown with the page that states it
    // (second review: the note had no source, and the page it did show
    // says exempt people of every age renew every 6 months).
    const leftOut = html.slice(html.indexOf('data-renewal-left-out="every_6_months"'));
    const block = leftOut.slice(0, leftOut.indexOf("</div>"));
    expect(block).toContain('data-origin="official"');
    expect(block).toContain("Every 6 months: Most adults ages 19 through 64, starting January 1, 2027.");
    expect(block).toContain('Source: <a href="https://medicaid.ncdhhs.gov/beneficiaries/medicaid-is-changing"');
    expect(block).not.toContain("work-and-community-engagement-requirement");
    expect(html).toContain(
      "You told us</span> The person this renewal is for is younger than 19 or older than 64.",
    );
  });

  it("keeps both estimates for 'yes', 'not sure', and no answer", () => {
    for (const answer of [...AGE_ANSWERS.filter((value) => value !== "no").map((value) => ({ min: 19, max: 64, answer: value })), undefined]) {
      const html = renderReported("approval", "2026-10-15", "2026-10-29", answer);
      expect(html).toContain('data-renewal-estimate="every_6_months"');
      expect(html).toContain('data-renewal-estimate="once_a_year"');
      expect(html).not.toContain("data-renewal-left-out");
    }
  });
});

describe("a stale entry's estimates carry the stale flag (review fix, BN-29)", () => {
  it("flags estimates from a stale entry and not from an active one", () => {
    expect(renderReported("approval", "2026-10-15", "2026-10-29", undefined, staleFacts())).toContain(STALE_ESTIMATE_NOTE);
    expect(renderReported("approval", "2026-10-15", "2026-10-29")).not.toContain(STALE_ESTIMATE_NOTE);
    // A due date the person reported does not rest on the schedules.
    expect(renderReported("renewal_due", "2027-04-30", "2026-10-29", undefined, staleFacts())).not.toContain(
      STALE_ESTIMATE_NOTE,
    );
  });
});

describe("zero banned claims in any rendered state", () => {
  it("reads a block's text outside its tags, so the label check below is not vacuous", () => {
    expect(textOutsideTags('<span data-origin="user">You told us</span> due <time>April 30, 2027</time>')).toBe(
      "You told us due April 30, 2027",
    );
    // An unclosed tag start is dropped, not left behind.
    expect(textOutsideTags("a <script")).toBe("a ");
    expect(dateBlocks(renderReported("renewal_due", "2027-04-30", "2027-04-18")).length).toBeGreaterThan(0);
  });

  it("scans the facts section and every reminder state", () => {
    expect(findBannedClaims(decode(renderToStaticMarkup(<RenewalFactsSection facts={FACTS} />)))).toEqual([]);
    const reported = fc
      .integer({ min: toEpochDay(d("2024-01-01")), max: toEpochDay(d("2030-12-31")) })
      .map(fromEpochDay);
    const answer = fc.option(fc.constantFrom(...AGE_ANSWERS), { nil: undefined });
    const stale = staleFacts();
    fc.assert(
      fc.property(
        fc.constantFrom("renewal_due" as const, "approval" as const),
        reported,
        fc.integer({ min: -400, max: 700 }),
        answer,
        fc.boolean(),
        (kind, date, offset, ageValue, useStale) => {
          const iso = `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
          const ageAnswer = kind === "approval" && ageValue !== undefined ? { min: 19, max: 64, answer: ageValue } : undefined;
          const html = decode(
            renderToStaticMarkup(
              <ReportedDateView
                facts={useStale ? stale : FACTS}
                reminder={{ kind, reportedDate: iso, ...(ageAnswer !== undefined ? { ageAnswer } : {}) }}
                today={addDays(date, offset)}
              />,
            ),
          );
          expect(findBannedClaims(html)).toEqual([]);
          expect(html).toContain('data-origin="user"');
          // Every block that shows a date says where it came from (review probe).
          for (const block of dateBlocks(html)) {
            expect(block.labeled, block.text).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
