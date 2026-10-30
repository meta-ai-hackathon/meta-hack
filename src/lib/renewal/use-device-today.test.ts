import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, deviceToday, formatIsoDate, parseIsoDate } from "./calendar-date";
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
