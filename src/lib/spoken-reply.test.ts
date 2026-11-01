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
