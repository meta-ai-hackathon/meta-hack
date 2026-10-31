import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeToReminderRechecks } from "./reminder-rechecks";
import { deviceDaySnapshot, subscribeToDeviceDay } from "./use-device-today";

// When the banner reads the saved reminder again (HACK-50, third review):
// on every focus and every return to a visible tab, whether or not the
// device's day changed, so a save or a remove in another tab shows up.

describe("subscribeToReminderRechecks", () => {
  let doc: EventTarget & { visibilityState: string };
  let win: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-04-18T15:00:00Z"));
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    win = new EventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("the day subscription alone could not do it: a focus on the same day leaves its snapshot unchanged", () => {
    // The review's gap, reproduced: the banner's only trigger besides a
    // navigation was the day snapshot, and React re-renders a
    // useSyncExternalStore reader only when the snapshot changes.
    const onDay = vi.fn();
    const unsubscribe = subscribeToDeviceDay(onDay);
    const before = deviceDaySnapshot();
    win.dispatchEvent(new Event("focus"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(onDay).toHaveBeenCalledTimes(2);
    expect(deviceDaySnapshot()).toBe(before);
    unsubscribe();
  });

  it("fires once per focus and per return to a visible tab, on the same day, and never when hidden (property)", () => {
    const event = fc.constantFrom("focus" as const, "visible" as const, "hidden" as const);
    fc.assert(
      fc.property(fc.array(event, { maxLength: 30 }), (events) => {
        const onRecheck = vi.fn();
        const unsubscribe = subscribeToReminderRechecks(onRecheck);
        for (const kind of events) {
          if (kind === "focus") {
            win.dispatchEvent(new Event("focus"));
          } else {
            doc.visibilityState = kind;
            doc.dispatchEvent(new Event("visibilitychange"));
          }
        }
        unsubscribe();
        expect(onRecheck).toHaveBeenCalledTimes(events.filter((kind) => kind !== "hidden").length);
        doc.visibilityState = "visible";
      }),
    );
  });

  it("goes quiet once unsubscribed", () => {
    const onRecheck = vi.fn();
    subscribeToReminderRechecks(onRecheck)();
    win.dispatchEvent(new Event("focus"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(onRecheck).not.toHaveBeenCalled();
  });
});
