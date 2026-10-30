import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../lib/honesty";
import { parseIsoDate } from "../lib/renewal/calendar-date";
import { STALE_ESTIMATE_NOTE, UNREADABLE_BANNER_MESSAGE, reminderMessage } from "../lib/renewal/copy";
import { reminderStatus } from "../lib/renewal/reminder";
import { PILOT_RENEWAL_FACTS, bannerFacts } from "../lib/renewal/renewal-facts";
import { RenewalBannerView, RenewalReminderBanner } from "./renewal-reminder-banner";

// The in-app reminder banner (HACK-50): a polite live region that is always
// mounted and silent until a saved date is within 30 days, on the day, or
// past; then it says so and links to the tracker. A reminder it cannot read
// gets its own line instead of silence.

describe("RenewalBannerView", () => {
  it("is a mounted, silent live region when there is nothing to say", () => {
    const html = renderToStaticMarkup(<RenewalBannerView banner={null} />);
    expect(html).toContain('data-renewal-banner="none"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<a ");
  });

  it("speaks and links to the tracker when a reminder is due", () => {
    const status = reminderStatus(parseIsoDate("2027-04-18")!, [parseIsoDate("2027-04-30")!])!;
    const message = reminderMessage(status, "NC Medicaid", false);
    const html = renderToStaticMarkup(<RenewalBannerView banner={{ phase: "soon", message }} />);
    expect(html).toContain('data-renewal-banner="soon"');
    expect(html).toContain("Reminder: you told us your NC Medicaid renewal is due in 12 days, on April 30, 2027.");
    expect(html).toContain('href="/renewal"');
    expect(findBannedClaims(html)).toEqual([]);
  });

  it("says when a saved reminder cannot be read, instead of going silent (review fix)", () => {
    const html = renderToStaticMarkup(
      <RenewalBannerView banner={{ phase: "unreadable", message: UNREADABLE_BANNER_MESSAGE }} />,
    );
    expect(html).toContain('data-renewal-banner="unreadable"');
    expect(html).toContain(UNREADABLE_BANNER_MESSAGE);
    expect(html).toContain('href="/renewal"');
  });

  it("carries the stale flag with an estimate from a stale entry (review fix, BN-29)", () => {
    const status = reminderStatus(parseIsoDate("2027-04-01")!, [parseIsoDate("2027-04-15")!])!;
    const message = reminderMessage(status, "NC Medicaid", true);
    const html = renderToStaticMarkup(
      <RenewalBannerView banner={{ phase: "soon", message, note: STALE_ESTIMATE_NOTE }} />,
    );
    expect(html).toContain(`${message} ${STALE_ESTIMATE_NOTE}`);
    expect(findBannedClaims(html)).toEqual([]);
  });

  it("server-renders silent: the device store is read only in the browser", () => {
    const html = renderToStaticMarkup(<RenewalReminderBanner facts={bannerFacts(PILOT_RENEWAL_FACTS)} />);
    expect(html).toContain('data-renewal-banner="none"');
    expect(html).not.toContain("Reminder");
  });
});

describe("the root layout", () => {
  it("mounts the banner inside a Suspense boundary (review fix: usePathname outside one fails the first dynamic route's build)", () => {
    const layout = readFileSync(fileURLToPath(new URL("../app/layout.tsx", import.meta.url)), "utf8");
    expect(layout).toMatch(/<Suspense fallback=\{null\}>\s*<RenewalReminderBanner\b/);
  });
});
