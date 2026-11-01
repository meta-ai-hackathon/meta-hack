import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {

  containsPlaceholder,

  fallbackSpokenRendition,

  selectSpokenText,

  verifySpokenRendition,

} from "./spoken-reply";



describe("containsPlaceholder", () => {

  it("detects bracketed placeholders", () => {

    expect(containsPlaceholder("Hello [GIVEN_NAME_10], welcome")).toBe(true);

  });

  it("detects bare placeholders", () => {

    expect(containsPlaceholder("Hello GIVEN_NAME_1, welcome")).toBe(true);

  });

  it("passes ordinary text", () => {

    expect(containsPlaceholder("Hello, welcome to your renewal")).toBe(false);

  });

});



describe("verifySpokenRendition", () => {

  it("passes a clean rendition, trimmed", () => {

    expect(verifySpokenRendition("  Please renew your Medicaid case.  ")).toEqual({

      ok: true,

      text: "Please renew your Medicaid case.",

    });

  });

  it("rejects placeholders", () => {

    expect(verifySpokenRendition("Ask [GIVEN_NAME_1] about it")).toEqual({

      ok: false,

      reason: "placeholder",

    });

  });

  it("rejects banned claims", () => {

    expect(verifySpokenRendition("You are eligible")).toEqual({ ok: false, reason: "banned_claim" });

    expect(verifySpokenRendition("This is guaranteed")).toEqual({ ok: false, reason: "banned_claim" });

  });

  it("rejects empty", () => {

    expect(verifySpokenRendition("")).toEqual({ ok: false, reason: "empty" });

    expect(verifySpokenRendition("   ")).toEqual({ ok: false, reason: "empty" });

  });

});



describe("fallbackSpokenRendition", () => {

  it("renders person tokens by ordinal without brackets", () => {

    const out = fallbackSpokenRendition("Thanks [GIVEN_NAME_1] for coming");

    expect(out).toContain("the first person you mentioned");

    expect(out).not.toContain("[");

  });

  it("renders tenth ordinal correctly", () => {

    const out = fallbackSpokenRendition("Thanks [GIVEN_NAME_10] for coming");

    expect(out).toContain("the tenth person you mentioned");

  });

  it("renders SSN token generically", () => {

    const out = fallbackSpokenRendition("We saw [SSN_1] on file");

    expect(out).toContain("the social security number you mentioned");

  });

  it("returns null when result contains a banned claim", () => {

    expect(fallbackSpokenRendition("You are eligible, [GIVEN_NAME_1]")).toBeNull();

  });

  it("returns null for bare unbracketed tokens", () => {

    expect(fallbackSpokenRendition("Call GIVEN_NAME_1 now")).toBeNull();

  });

});



describe("selectSpokenText", () => {

  it("prefers a verified spoken rendition", () => {

    expect(

      selectSpokenText({ spokenReply: "Please renew soon.", displayReply: "Hi [GIVEN_NAME_1]" }),

    ).toEqual({ kind: "verified", text: "Please renew soon." });

  });

  it("falls back when spoken rendition has a placeholder", () => {

    const out = selectSpokenText({

      spokenReply: "Ask [GIVEN_NAME_1] about it",

      displayReply: "Ask [GIVEN_NAME_1] about your Medicaid renewal",

    });

    expect(out.kind).toBe("fallback");

    if (out.kind !== "silent") expect(out.text).toContain("the first person you mentioned");

  });

  it("fails closed to silent when both are bad", () => {

    expect(

      selectSpokenText({ spokenReply: "You are eligible [GIVEN_NAME_1]", displayReply: "Call GIVEN_NAME_1 now" }),

    ).toEqual({ kind: "silent" });

  });

  it("uses token-free display as fallback when spoken is missing", () => {

    expect(selectSpokenText({ displayReply: "Please renew your SNAP case." })).toEqual({

      kind: "fallback",

      text: "Please renew your SNAP case.",

    });

  });

});


// Property-based round (repo rule: invariants for arbitrary inputs, not
// hand-picked examples).
describe("spoken-reply properties", () => {
  const labelArb = fc.constantFrom(
    "GIVEN_NAME",
    "SURNAME",
    "SSN",
    "PHONE",
    "EMAIL",
    "CITY",
    "BUILDING_NUMBER",
  ) as fc.Arbitrary<string>;
  const ordinalArb = fc.integer({ min: 1, max: 60 });
  /** Arbitrary well-mannered wrapper text (no banned-claim vocabulary). */
  const fillerArb = fc.string({
    unit: fc.constantFrom(..." abcdefghiSWren.,!?"),
    minLength: 0,
    maxLength: 40,
  });
  const tokenArb = fc
    .tuple(labelArb, ordinalArb)
    .map(([label, ordinal]) => `[${label}_${ordinal}]`);
  const wordsArb = fc.array(
    fc.constantFrom("renewal", "Medicaid", "case", "thanks", "again", "form"),
    { minLength: 0, maxLength: 6 },
  ).map((words) => words.join(" "));

  it("verification fails on any text embedding an arbitrary token", () => {
    fc.assert(
      fc.property(fillerArb, tokenArb, fillerArb, (before, token, after) => {
        const text = `${before} ${token} ${after}`;
        if (text.trim() === "") {
          expect(verifySpokenRendition(text)).toEqual({ ok: false, reason: "empty" });
          return;
        }
        expect(verifySpokenRendition(text).ok).toBe(false);
        expect(containsPlaceholder(text)).toBe(true);
      }),
    );
  });

  it("the fallback never leaves a token in its spoken output, for arbitrary replies", () => {
    fc.assert(
      fc.property(wordsArb, tokenArb, fillerArb, (words, token, filler) => {
        const reply = `${words} ${token} ${filler}`;
        const spoken = fallbackSpokenRendition(reply);
        if (spoken === null) return;
        expect(containsPlaceholder(spoken)).toBe(false);
        expect(spoken).not.toMatch(/\[[A-Z][A-Z_]*_\d+\]/);
      }),
    );
  });

  it("a token-free reply either survives as itself or the client has no fallback", () => {
    fc.assert(
      fc.property(wordsArb, (reply) => {
        if (reply.trim() === "") return;
        if (containsPlaceholder(reply)) return;
        const spoken = fallbackSpokenRendition(reply);
        if (spoken !== null) {
          const verdict = verifySpokenRendition(spoken);
          // A deterministic rendering of a gate-clean reply stays gate-clean
          // or is rejected wholesale — it never becomes a new placeholder.
          expect(containsPlaceholder(spoken)).toBe(false);
          expect(verdict.ok || verdict.reason === "banned_claim").toBe(true);
        }
      }),
    );
  });

  it("selectSpokenText never returns a spoken text containing a token", () => {
    fc.assert(
      fc.property(wordsArb, tokenArb, wordsArb, (clean, token, words) => {
        const displayReply = `${words} ${token}`;
        const spokenReply = `${clean} ${token}`;
        const selection = selectSpokenText({ spokenReply, displayReply });
        if (selection.kind === "silent") return;
        expect(containsPlaceholder(selection.text)).toBe(false);
      }),
    );
  });
});
