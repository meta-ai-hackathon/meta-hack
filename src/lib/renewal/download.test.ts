import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CALENDAR_FILE_TYPE, downloadTextFile, offerFile } from "./download";

// Offering the calendar file (HACK-50, third review): the download click
// had no catch, so a throw from the calendar builder or from the browser's
// blob URL escaped the handler, and the person got no file and no notice.
// offerFile turns every outcome into one the tracker can say.

describe("offerFile", () => {
  it("hands over exactly the built file, and turns any throw into a failed outcome (property)", () => {
    const file = fc.option(fc.record({ filename: fc.string(), text: fc.string() }), { nil: null });
    const step = fc.constantFrom("works" as const, "throws" as const);
    fc.assert(
      fc.property(file, step, step, fc.anything(), (built, building, saving, thrown) => {
        const saved: unknown[][] = [];
        const outcome = offerFile(
          () => {
            if (building === "throws") {
              throw thrown;
            }
            return built;
          },
          (...args) => {
            saved.push(args);
            if (saving === "throws") {
              throw thrown;
            }
          },
          CALENDAR_FILE_TYPE,
        );
        if (building === "throws") {
          expect(outcome).toBe("failed");
          expect(saved).toEqual([]);
        } else if (built === null) {
          expect(outcome).toBe("nothing");
          expect(saved).toEqual([]);
        } else {
          expect(saved).toEqual([[built.filename, built.text, CALENDAR_FILE_TYPE]]);
          expect(outcome).toBe(saving === "throws" ? "failed" : "downloaded");
        }
      }),
    );
  });

  it("reports a failed outcome when the browser cannot save the file, instead of throwing", () => {
    // The review's probe: a browser that refuses blob URLs.
    const original = URL.createObjectURL;
    URL.createObjectURL = () => {
      throw new Error("blob URLs are blocked");
    };
    try {
      expect(() => downloadTextFile("renewal-reminder.ics", "BEGIN:VCALENDAR", CALENDAR_FILE_TYPE)).toThrow();
      expect(
        offerFile(() => ({ filename: "renewal-reminder.ics", text: "BEGIN:VCALENDAR" }), downloadTextFile, CALENDAR_FILE_TYPE),
      ).toBe("failed");
    } finally {
      URL.createObjectURL = original;
    }
  });
});
