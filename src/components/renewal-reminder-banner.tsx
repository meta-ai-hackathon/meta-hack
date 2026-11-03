"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { CalendarDate } from "../lib/renewal/calendar-date";
import {
  OPEN_TRACKER_LINK,
  STALE_ESTIMATE_NOTE,
  UNREADABLE_BANNER_MESSAGE,
  bannerMessage,
} from "../lib/renewal/copy";
import {
  DEVICE_STORAGE_TIMEOUT_MS,
  openDeviceReminderStore,
  withDeadline,
} from "../lib/renewal/device-kv";
import {
  bannerIsDue,
  reminderDates,
  reminderStatus,
  type ReminderPhase,
} from "../lib/renewal/reminder";
import { useReminderRechecks } from "../lib/renewal/reminder-rechecks";
import { loadReminder, type ReminderStoreDeps } from "../lib/renewal/reminder-store";
import type { RenewalBannerFacts } from "../lib/renewal/renewal-facts";
import { useDeviceToday } from "../lib/renewal/use-device-today";
import { StatusRegion } from "./status-region";

// The in-app renewal reminder (BN-22 / HACK-50). Mounted once in the root
// layout, inside the main landmark and a Suspense boundary (it reads the
// pathname), so it fires on whatever page the person comes back to. It
// reads the reminder sealed on this device without ever deleting it, works
// out where the date stands against the device's today (kept current past
// midnight), and speaks up from 30 days before, on the day, and once a date
// has passed. It reads the store again whenever the person comes back to
// the tab, so a save or a remove in another tab shows up here (third
// review). A reminder it cannot read gets a line that sends the person
// to the tracker, which removes it and says so. It never sends the date
// anywhere: no fetch, no route, no log, and it never names the program,
// since anyone who uses the device sees it (third review). A passed date
// keeps it speaking until the person changes the date or removes the
// reminder, and the line says so. The tracker page shows the same status
// itself, so the banner stays quiet there.

const RENEWAL_TRACKER_PATH = "/renewal";

export interface RenewalBannerState {
  readonly phase: Exclude<ReminderPhase, "later"> | "unreadable";
  readonly message: string;
  /** A second line: the stale flag on estimates from a stale entry (BN-29). */
  readonly note?: string;
}

/**
 * The banner's markup for one state. The status region is always mounted
 * (silent while there is nothing to say) so the reminder is announced when
 * it appears, per the StatusRegion convention.
 */
export function RenewalBannerView({ banner }: { banner: RenewalBannerState | null }) {
  return (
    <div
      data-renewal-banner={banner ? banner.phase : "none"}
      className={banner ? "mx-auto w-full max-w-2xl px-6 pt-6" : undefined}
    >
      <div
        className={
          banner
            ? "flex flex-col gap-2 rounded-md border-2 border-amber-800 bg-amber-50 p-4 text-amber-950"
            : undefined
        }
      >
        <StatusRegion
          message={banner ? [banner.message, banner.note].filter(Boolean).join(" ") : ""}
          className={banner ? "font-semibold" : undefined}
        />
        {banner ? (
          <p>
            <Link href={RENEWAL_TRACKER_PATH} className="font-semibold underline">
              {OPEN_TRACKER_LINK}
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What the banner says about the reminder saved in `deps` today, or null
 * when it has nothing to say. Reads without deleting anything.
 */
export async function readBannerState(
  deps: ReminderStoreDeps,
  facts: RenewalBannerFacts,
  today: CalendarDate,
): Promise<RenewalBannerState | null> {
  const result = await withDeadline(
    loadReminder(deps, [facts.entryId], { readOnly: true }),
    DEVICE_STORAGE_TIMEOUT_MS,
    "reading the saved reminder",
  );
  if (result.status === "unreadable") {
    return { phase: "unreadable", message: UNREADABLE_BANNER_MESSAGE };
  }
  if (result.status !== "ok") {
    return null;
  }
  const status = reminderStatus(today, reminderDates(result.reminder, facts.schedules));
  if (!bannerIsDue(status)) {
    return null;
  }
  const fromEstimate = result.reminder.kind === "approval";
  return {
    phase: status.phase,
    message: bannerMessage(status, fromEstimate),
    ...(fromEstimate && facts.entryStatus === "stale" ? { note: STALE_ESTIMATE_NOTE } : {}),
  };
}

export function RenewalReminderBanner({ facts }: { facts: RenewalBannerFacts }) {
  const pathname = usePathname();
  const today = useDeviceToday();
  // Third review: goes up on every focus and every return to the tab, so
  // the effect below reads the store again even when the day is the same.
  const recheck = useReminderRechecks();
  const [banner, setBanner] = useState<RenewalBannerState | null>(null);
  const { entryId, entryStatus, schedules } = facts;

  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<RenewalBannerState | null> {
      if (pathname === RENEWAL_TRACKER_PATH || today === null) {
        return null;
      }
      const deps = await openDeviceReminderStore();
      if (deps === null) {
        return null;
      }
      return readBannerState(deps, { entryId, entryStatus, schedules }, today);
    }
    check()
      .catch(() => null)
      .then((next) => {
        if (!cancelled) {
          setBanner(next);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, today, recheck, entryId, entryStatus, schedules]);

  return <RenewalBannerView banner={banner} />;
}
