import { useMemo, useSyncExternalStore } from "react";
import {
  deviceLocalMoment,
  formatIsoDate,
  msUntilNextDayCheck,
  parseIsoDate,
  type CalendarDate,
  type LocalMoment,
} from "./calendar-date";

/**
 * The device's "today", kept current (BN-22 / HACK-50 review fix: a tab
 * left open past midnight kept yesterday's day count). The value is the
 * device's calendar date, re-read when the tab becomes visible again, when
 * the window gets focus, and at the next local midnight. It is null on the
 * server and during hydration, so both renders agree.
 */

/**
 * Calls `onChange` whenever the device's date may have changed. Browser-only.
 * `momentOf` reads the device's wall clock; tests pass a fixed zone.
 */
export function subscribeToDeviceDay(
  onChange: () => void,
  momentOf: (instant: Date) => LocalMoment = deviceLocalMoment,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    const now = new Date();
    // At the next local midnight or within the hour, whichever is sooner,
    // then re-read and schedule again: a clock change makes some days 23
    // or 25 hours long (second review fix: spring forward was an hour late).
    timer = setTimeout(() => {
      onChange();
      schedule();
    }, msUntilNextDayCheck(now, momentOf(now)));
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") {
      onChange();
      schedule();
    }
  };
  const onFocus = () => {
    onChange();
    schedule();
  };
  schedule();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
  };
}

/** The snapshot: the device's date as YYYY-MM-DD, so equal days compare equal. */
export function deviceDaySnapshot(): string {
  return formatIsoDate(deviceLocalMoment().date);
}

function serverSnapshot(): null {
  return null;
}

export function useDeviceToday(): CalendarDate | null {
  const iso = useSyncExternalStore<string | null>(subscribeToDeviceDay, deviceDaySnapshot, serverSnapshot);
  return useMemo(() => (iso === null ? null : parseIsoDate(iso)), [iso]);
}
