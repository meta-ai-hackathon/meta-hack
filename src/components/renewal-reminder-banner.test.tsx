import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../lib/honesty";
import { parseIsoDate } from "../lib/renewal/calendar-date";
import { PASSED_BANNER_NOTE, STALE_ESTIMATE_NOTE, UNREADABLE_BANNER_MESSAGE, bannerMessage } from "../lib/renewal/copy";
import { RENEWAL_REMINDER_VERSION, reminderStatus, type RenewalReminder } from "../lib/renewal/reminder";
import {
  REMINDER_ENVELOPE_KEY,
  clearReminder,
  saveReminder,
  type DeviceKv,
  type ReminderStoreDeps,
} from "../lib/renewal/reminder-store";
import { PILOT_RENEWAL_FACTS, bannerFacts } from "../lib/renewal/renewal-facts";
import { RenewalBannerView, RenewalReminderBanner, readBannerState } from "./renewal-reminder-banner";

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

  it("speaks and links to the tracker when a reminder is due, without naming the program", () => {
    const status = reminderStatus(parseIsoDate("2027-04-18")!, [parseIsoDate("2027-04-30")!])!;
    const message = bannerMessage(status, false);
    const html = renderToStaticMarkup(<RenewalBannerView banner={{ phase: "soon", message }} />);
    expect(html).toContain('data-renewal-banner="soon"');
    // Third review: the banner shows on every page of a device others may
    // use, so it says "your renewal", like the calendar title.
    expect(html).toContain("Reminder: you told us your renewal is due in 12 days, on April 30, 2027.");
    expect(html).not.toMatch(/medicaid/i);
    expect(html).toContain('href="/renewal"');
    expect(findBannedClaims(html)).toEqual([]);
  });

  it("keeps a passed date's banner until the person acts, and says how to stop it (third review fix)", () => {
    const status = reminderStatus(parseIsoDate("2027-05-03")!, [parseIsoDate("2027-04-30")!])!;
    const html = renderToStaticMarkup(<RenewalBannerView banner={{ phase: "passed", message: bannerMessage(status, false) }} />);
    expect(html).toContain('data-renewal-banner="passed"');
    expect(html).toContain(`The renewal date you told us, April 30, 2027, has passed. ${PASSED_BANNER_NOTE}`);
    expect(html).not.toMatch(/medicaid/i);
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
    const message = bannerMessage(status, true);
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

/** One tab's handle on a device store that every tab shares (IndexedDB stand-in). */
function tabOn(entries: Map<string, unknown>): ReminderStoreDeps {
  const kv: DeviceKv = {
    getMany: async (keys) => keys.map((key) => structuredClone(entries.get(key))),
    setMany: async (pairs) => {
      for (const [key, value] of pairs) {
        entries.set(key, structuredClone(value));
      }
    },
    deleteMany: async (keys, guard) => {
      if (guard?.keep(structuredClone(entries.get(guard.key)))) {
        return false;
      }
      for (const key of keys) {
        entries.delete(key);
      }
      return true;
    },
  };
  return {
    kv,
    crypto: {
      subtle: globalThis.crypto.subtle,
      getRandomValues: (array) => globalThis.crypto.getRandomValues(array),
    },
  };
}

describe("the banner reads what another tab saved or removed (third review)", () => {
  const facts = bannerFacts(PILOT_RENEWAL_FACTS);
  const today = parseIsoDate("2027-04-18")!;
  const due: RenewalReminder = {
    version: RENEWAL_REMINDER_VERSION,
    entryId: facts.entryId,
    kind: "renewal_due",
    reportedDate: "2027-04-28",
    calendarId: "0123456789abcdef0123456789abcdef",
    revision: 0,
  };

  it("each read sees the store as it is now, so a re-read on focus picks up the other tab", async () => {
    const device = new Map<string, unknown>();
    const parked = tabOn(device);
    const other = tabOn(device);
    expect(await readBannerState(parked, facts, today)).toBeNull();
    await saveReminder(due, other);
    expect(await readBannerState(parked, facts, today)).toMatchObject({
      phase: "soon",
      message: "Reminder: you told us your renewal is due in 10 days, on April 28, 2027.",
    });
    await clearReminder(other);
    expect(await readBannerState(parked, facts, today)).toBeNull();
    // A broken reminder is announced, not deleted: the banner reads only.
    await saveReminder(due, other);
    new Uint8Array((device.get(REMINDER_ENVELOPE_KEY) as { ciphertext: ArrayBuffer }).ciphertext)[0]! ^= 1;
    expect(await readBannerState(parked, facts, today)).toEqual({ phase: "unreadable", message: UNREADABLE_BANNER_MESSAGE });
    expect(device.has(REMINDER_ENVELOPE_KEY)).toBe(true);
  });

  it("reads again on every recheck, not only when the page or the day changes", () => {
    const banner = readFileSync(fileURLToPath(new URL("./renewal-reminder-banner.tsx", import.meta.url)), "utf8");
    expect(banner).toMatch(/const recheck = useReminderRechecks\(\);/);
    expect(banner).toMatch(/\}, \[pathname, today, recheck, entryId, entryStatus, schedules\]\);/);
  });
});

describe("the root layout", () => {
  it("mounts the banner inside a Suspense boundary (review fix: usePathname outside one fails the first dynamic route's build)", () => {
    const layout = readFileSync(fileURLToPath(new URL("../app/layout.tsx", import.meta.url)), "utf8");
    expect(layout).toMatch(/<Suspense fallback=\{null\}>\s*<RenewalReminderBanner\b/);
  });
});
