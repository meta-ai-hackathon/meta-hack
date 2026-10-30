import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  deviceToday,
  formatIsoDate,
  localMomentInTimeZone,
  parseIsoDate,
} from "./calendar-date";
import { deviceDaySnapshot, subscribeToDeviceDay } from "./use-device-today";

// "Today" stays current in a long-lived tab (HACK-50 review fix): the
// subscription fires when the tab becomes visible, when the window gets
// focus, and at the next local midnight, and goes quiet once unsubscribed.

const DAY_MS = 24 * 60 * 60 * 1000;

describe("subscribeToDeviceDay", () => {
  let doc: EventTarget & { visibilityState: string };
  let win: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-01T03:30:00Z"));
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    win = new EventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fires on visibility and focus, and at the next local midnight", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToDeviceDay(onChange);
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(onChange).toHaveBeenCalledTimes(1);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(onChange).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new Event("focus"));
    expect(onChange).toHaveBeenCalledTimes(2);

    const before = deviceDaySnapshot();
    expect(before).toBe(formatIsoDate(deviceToday()));
    vi.advanceTimersByTime(DAY_MS + 1000);
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(deviceDaySnapshot()).toBe(formatIsoDate(addDays(parseIsoDate(before)!, 1)));
    unsubscribe();
  });

  it("sees the new day within a minute of midnight on ordinary and clock-change nights (second review fix)", () => {
    // The review's probe: from 10 PM on March 13, 2027 in Charlotte, the
    // timer fired at 1 AM on the 15th, an hour after midnight, because the
    // night clocks spring forward is 23 hours long. Walk each night minute
    // by minute and count the minutes a tab would still show yesterday.
    const zone = "America/New_York";
    const momentOf = (instant: Date) => localMomentInTimeZone(instant, zone);
    const dayAt = (instant: Date) => formatIsoDate(momentOf(instant).date);
    for (const start of [
      "2027-03-14T03:00:00Z", // 10 PM EST, March 13: spring forward on the 14th
      "2027-11-07T03:00:00Z", // 11 PM EDT, November 6: fall back on the 7th
      "2027-06-10T03:00:00Z", // 11 PM EDT, June 9: an ordinary night
    ]) {
      vi.setSystemTime(new Date(start));
      let shown = dayAt(new Date());
      const unsubscribe = subscribeToDeviceDay(() => {
        shown = dayAt(new Date());
      }, momentOf);
      let staleMinutes = 0;
      for (let minute = 0; minute < 3 * 24 * 60; minute += 1) {
        vi.advanceTimersByTime(60_000);
        if (shown !== dayAt(new Date())) {
          staleMinutes += 1;
        }
      }
      unsubscribe();
      expect(staleMinutes, start).toBe(0);
    }
  });

  it("keeps firing every night while subscribed, and stops after unsubscribe", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToDeviceDay(onChange);
    vi.advanceTimersByTime(3 * DAY_MS + 1000);
    expect(onChange.mock.calls.length).toBeGreaterThanOrEqual(3);
    unsubscribe();
    const calls = onChange.mock.calls.length;
    win.dispatchEvent(new Event("focus"));
    doc.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(3 * DAY_MS);
    expect(onChange).toHaveBeenCalledTimes(calls);
  });
});
