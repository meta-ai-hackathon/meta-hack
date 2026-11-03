import { describe, expect, it } from "vitest";
import { checkDateForm } from "./date-form";

// The renewal tracker's form check (HACK-50), beside its module like every
// other src/lib/renewal test (third review: it used to live in the page
// suite): a kind of date must be chosen, the date must be real and inside
// the reported years, and an approval date cannot be after today.

describe("checkDateForm", () => {
  const today = { year: 2026, month: 10, day: 29 };

  it("asks which date the person has before anything else", () => {
    expect(checkDateForm("", "2027-04-30", today)).toMatchObject({ ok: false, field: "kind" });
    expect(checkDateForm("unknown", "", today)).toMatchObject({ ok: false, field: "kind" });
  });

  it("accepts a real date within 2000-2100 and normalizes it", () => {
    expect(checkDateForm("renewal_due", "2027-04-30", today)).toEqual({
      ok: true,
      kind: "renewal_due",
      reportedDate: "2027-04-30",
    });
    expect(checkDateForm("renewal_due", " 2027-04-30 ", today)).toMatchObject({ ok: true, reportedDate: "2027-04-30" });
    for (const bad of ["", "2027-02-30", "04/30/2027", "1999-12-31", "2101-01-01"]) {
      expect(checkDateForm("renewal_due", bad, today), bad).toMatchObject({ ok: false, field: "date" });
    }
  });

  it("allows a past due date (it shows as passed) but not a future approval date", () => {
    expect(checkDateForm("renewal_due", "2026-01-15", today)).toMatchObject({ ok: true });
    expect(checkDateForm("approval", "2026-10-29", today)).toMatchObject({ ok: true });
    expect(checkDateForm("approval", "2026-10-30", today)).toMatchObject({ ok: false, field: "date" });
  });
});
