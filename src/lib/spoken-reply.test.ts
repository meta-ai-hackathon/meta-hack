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

  it("renders SSN token by its keyed phrase", () => {

    const out = fallbackSpokenRendition("We saw [SSN_1] on file");

    expect(out).toContain("the Social Security number you shared");

  });

  it("renders every Rampart label with its plain-language phrase", () => {

    const reply =
      "[PHONE_1] [EMAIL_1] [BANK_ACCOUNT_1] [ROUTING_NUMBER_1] [TAX_ID_1] " +
      "[GOVERNMENT_ID_1] [PASSPORT_1] [DRIVERS_LICENSE_1] [CREDIT_CARD_1] " +
      "[IP_ADDRESS_1] [URL_1] [BUILDING_NUMBER_1] [STREET_NAME_1] " +
      "[SECONDARY_ADDRESS_1] [CITY_1] [STATE_1] [ZIP_CODE_1]";

    const out = fallbackSpokenRendition(reply) ?? "";

    const phrases = [
      "the phone number you shared",
      "the email address you shared",
      "the bank account number you shared",
      "the routing number you shared",
      "the tax ID you shared",
      "the government ID you shared",
      "the passport number you shared",
      "the driver's license number you shared",
      "the card number you shared",
      "the IP address you shared",
      "the link you shared",
      "the street number you shared",
      "the street name you shared",
      "the apartment or unit you shared",
      "the city you shared",
      "the state you shared",
      "the ZIP code you shared",
    ];

    for (const phrase of phrases) {

      expect(out, phrase).toContain(phrase);

    }

    expect(out).not.toContain("[");

  });

  it("a repeated token says the same one, not a second disclosure", () => {

    const out = fallbackSpokenRendition(
      "[PHONE_1] is saved, and [PHONE_1] stays on the application.",
    );

    expect(out).toContain("the phone number you shared is saved");

    expect(out).toContain("the same phone number you shared stays on the application");

  });

  it("twin tokens of one label keep ordinal distinctions", () => {

    const out = fallbackSpokenRendition(
      "I have [PHONE_1] from the form and [PHONE_2] from yesterday.",
    );

    expect(out).toContain("the first phone number you shared");

    expect(out).toContain("the second phone number you shared");

  });

  it("a lone fact token drops the ordinal", () => {

    const out = fallbackSpokenRendition("Use [EMAIL_1] for contact.");

    expect(out).toContain("the email address you shared");

    expect(out).not.toContain("first");

  });

  it("person tokens keep their ordinal even when alone", () => {

    const out = fallbackSpokenRendition("Thanks [GIVEN_NAME_21] for coming");

    expect(out).toContain("the 21st person you mentioned");

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


const ORDINAL_WORDS = [
  "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth",
  "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth",
  "twentieth",
];

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

  it(" PROPERTY: fallback phrasing tracks repeats and twins exactly", () => {
    fc.assert(
      fc.property(labelArb, fc.integer({ min: 1, max: 20 }), fc.integer({ min: 1, max: 20 }), (label, a, b) => {
        const sameLabelTwins = `[${label}_${a}] [${label}_${b}]`;
        const spokenTwins = fallbackSpokenRendition(sameLabelTwins);
        if (spokenTwins === null) return;
        expect(containsPlaceholder(spokenTwins)).toBe(false);
        if (a === b) {
          // The same fact twice: "the same ...", no ordinal doubling.
          expect(spokenTwins).toContain("the same ");
          expect(spokenTwins.match(/the same /g)).toHaveLength(1);
        } else {
          // Two distinct facts of one kind: both stay distinguishable.
          expect(spokenTwins).not.toContain("the same ");
          expect(spokenTwins).toContain(`the ${ORDINAL_WORDS[a - 1] ?? a} `);
          expect(spokenTwins).toContain(`the ${ORDINAL_WORDS[b - 1] ?? b} `);
        }
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
