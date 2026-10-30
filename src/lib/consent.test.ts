import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONSENT_HEADER,
  CONSENT_PATHS,
  CONSENT_STORAGE_KEY,
  attachConsentHeader,
  consentPathEnabled,
  declinedReceipt,
  loadConsentReceipt,
  parseConsentReceipt,
  saveConsentReceipt,
  type ConsentPathSpec,
  type ConsentReceipt,
} from "./consent";

// Consent gate unit tests (Mission v2.1 M5, HACK-81 / VAL-CONSENT-002..004):
// the receipt is stored WITH THE USER (localStorage, per device, no answer
// data), parses fail-closed, and a path only enables when its vendor terms
// are verified AND the user's receipt allows it.

function receiptWith(overrides: Partial<ConsentReceipt> = {}): ConsentReceipt {
  return {
    v: 1,
    ai: true,
    voice: false,
    at: "2026-10-30T12:00:00.000Z",
    ...overrides,
  };
}

describe("consent path registry (VAL-CONSENT-002/004)", () => {
  it("names both providers, their purposes, and their verified terms", () => {
    const ai = CONSENT_PATHS.find((path) => path.id === "ai-conversation");
    const voice = CONSENT_PATHS.find((path) => path.id === "voice");
    expect(ai).toBeDefined();
    expect(voice).toBeDefined();
    // Providers named in plain language: Meta for chat + STT, Gemini for TTS.
    expect(ai?.provider).toMatch(/Meta/);
    expect(voice?.provider).toMatch(/Meta/);
    expect(voice?.provider).toMatch(/Gemini/);
    // What leaves the device, and why.
    expect(ai?.sends.join(" ")).toMatch(/words you type/);
    expect(voice?.sends.join(" ")).toMatch(/voice/);
    expect(voice?.sends.join(" ")).toMatch(/reply text/);
    expect(ai?.purpose.length).toBeGreaterThan(0);
    expect(voice?.purpose.length).toBeGreaterThan(0);
  });

  it("carries the live-verified vendor terms with retrieval dates", () => {
    // Every VERIFIED path carries its checked terms — filtered on
    // termsVerified, not on id, so the fax path gets the same checks the
    // moment HACK-89 verifies it (PR #61 P2). It ships unverified on
    // purpose today and is asserted separately below.
    for (const path of CONSENT_PATHS.filter((entry) => entry.termsVerified)) {
      expect(path.termsVerified, path.id).toBe(true);
      expect(path.terms.length, path.id).toBeGreaterThan(0);
      for (const terms of path.terms) {
        expect(terms.url).toMatch(/^https:\/\//);
        expect(terms.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    // The exact pages verified live on 2026-10-30 (see mission library
    // model.md + voice.md): Meta Model API data commitments and the Gemini
    // API additional terms.
    const urls = CONSENT_PATHS.flatMap((path) =>
      path.terms.map((terms) => terms.url),
    );
    expect(urls).toContain("https://dev.meta.ai/legal/commitments");
    expect(urls).toContain("https://ai.google.dev/gemini-api/terms");
  });
});

describe("fax consent path (HACK-88)", () => {
  it("ships unverified, so no receipt can enable it until HACK-89 lands", () => {
    const fax = CONSENT_PATHS.find((path) => path.id === "fax");
    expect(fax).toBeDefined();
    expect(fax?.termsVerified).toBe(false);
    expect(fax?.sends.join(" ")).toMatch(/signed application packet/);
    expect(
      consentPathEnabled("fax", receiptWith({ fax: true })),
    ).toBe(false);
  });

  it("enables fax only on explicit fax consent once terms are verified", () => {
    const verifiedFax: ConsentPathSpec[] = CONSENT_PATHS.map((path) =>
      path.id === "fax"
        ? {
            ...path,
            termsVerified: true,
            terms: [
              {
                label: "Vendor retention terms",
                url: "https://example.invalid/terms",
                verifiedOn: "2026-10-30",
              },
            ],
          }
        : path,
    );
    expect(consentPathEnabled("fax", receiptWith({ fax: true }), verifiedFax)).toBe(true);
    expect(consentPathEnabled("fax", receiptWith({ fax: false }), verifiedFax)).toBe(false);
    // Receipts written before the fax field existed read as off, never on.
    expect(consentPathEnabled("fax", receiptWith(), verifiedFax)).toBe(false);
    expect(consentPathEnabled("fax", null, verifiedFax)).toBe(false);
  });

  it("parses the fax field fail-closed", () => {
    const raw = JSON.stringify({
      v: 1,
      ai: true,
      voice: false,
      fax: "yes",
      at: "2026-10-30T12:00:00.000Z",
    });
    expect(parseConsentReceipt(raw)).toBeNull();
    const good = JSON.stringify({
      v: 1,
      ai: true,
      voice: false,
      fax: true,
      at: "2026-10-30T12:00:00.000Z",
    });
    expect(parseConsentReceipt(good)?.fax).toBe(true);
  });
});

describe("consentPathEnabled", () => {
  it("fails closed with no receipt at all", () => {
    expect(consentPathEnabled("ai-conversation", null)).toBe(false);
    expect(consentPathEnabled("voice", null)).toBe(false);
  });

  it("enables the AI path only on explicit AI consent", () => {
    expect(consentPathEnabled("ai-conversation", receiptWith({ ai: true }))).toBe(
      true,
    );
    expect(consentPathEnabled("ai-conversation", receiptWith({ ai: false }))).toBe(
      false,
    );
  });

  it("keeps voice behind BOTH toggles (VAL-CONSENT-003)", () => {
    expect(consentPathEnabled("voice", receiptWith({ ai: true, voice: true }))).toBe(
      true,
    );
    expect(consentPathEnabled("voice", receiptWith({ ai: true, voice: false }))).toBe(
      false,
    );
    // Voice without the base AI consent is impossible: voice turns ride the
    // same extraction path as typed turns.
    expect(consentPathEnabled("voice", receiptWith({ ai: false, voice: true }))).toBe(
      false,
    );
  });

  it("never enables a path whose terms are not verified (VAL-CONSENT-004)", () => {
    const unverifiedVoice: ConsentPathSpec[] = CONSENT_PATHS.map((path) =>
      path.id === "voice" ? { ...path, termsVerified: false } : path,
    );
    expect(
      consentPathEnabled("voice", receiptWith({ ai: true, voice: true }), unverifiedVoice),
    ).toBe(false);
    // The verified registry still enables it with the same receipt.
    expect(
      consentPathEnabled("voice", receiptWith({ ai: true, voice: true })),
    ).toBe(true);
  });
});

describe("receipt parsing (fail closed)", () => {
  it("round-trips a valid receipt", () => {
    const receipt = receiptWith({ voice: true });
    const parsed = parseConsentReceipt(JSON.stringify(receipt));
    expect(parsed).toEqual(receipt);
  });

  it("returns null for garbage, wrong versions, and bad fields", () => {
    expect(parseConsentReceipt(null)).toBeNull();
    expect(parseConsentReceipt("")).toBeNull();
    expect(parseConsentReceipt("not json")).toBeNull();
    expect(parseConsentReceipt("[]")).toBeNull();
    expect(
      parseConsentReceipt(JSON.stringify({ v: 2, ai: true, voice: false, at: "2026-10-30" })),
    ).toBeNull();
    expect(
      parseConsentReceipt(JSON.stringify({ v: 1, ai: "yes", voice: false, at: "2026-10-30" })),
    ).toBeNull();
    expect(
      parseConsentReceipt(JSON.stringify({ v: 1, ai: true, voice: false, at: "yesterday" })),
    ).toBeNull();
  });

  it("ignores unknown fields so a future receipt cannot smuggle state", () => {
    const parsed = parseConsentReceipt(
      JSON.stringify({
        v: 1,
        ai: true,
        voice: false,
        at: "2026-10-30T12:00:00.000Z",
        answers: { income: "secret" },
      }),
    );
    expect(parsed).toEqual(receiptWith());
    expect(parsed && Object.keys(parsed).sort()).toEqual(["ai", "at", "v", "voice"]);
  });
});

// ---------------------------------------------------------------------------
// Per-device receipt storage (a localStorage stub — the receipt lives with
// the user, never server-side)
// ---------------------------------------------------------------------------

let store: Map<string, string>;

function stubLocalStorage(): void {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
}

describe("per-device receipt storage", () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves and loads the receipt under the consent key", () => {
    const receipt = receiptWith({ voice: true });
    saveConsentReceipt(receipt);
    expect(store.get(CONSENT_STORAGE_KEY)).toBeDefined();
    expect(loadConsentReceipt()).toEqual(receipt);
  });

  it("stores NO answer data — only the consent decision itself", () => {
    saveConsentReceipt(receiptWith());
    const stored = JSON.parse(store.get(CONSENT_STORAGE_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    expect(Object.keys(stored).sort()).toEqual(["ai", "at", "v", "voice"]);
  });

  it("loads nothing on a fresh device", () => {
    expect(loadConsentReceipt()).toBeNull();
  });
});

describe("consent header", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is attached to a request when a receipt exists", () => {
    stubLocalStorage();
    saveConsentReceipt(receiptWith({ voice: true }));
    const headers = attachConsentHeader(new Headers());
    expect(headers.get(CONSENT_HEADER)).not.toBeNull();
    expect(parseConsentReceipt(headers.get(CONSENT_HEADER))).toEqual(
      receiptWith({ voice: true }),
    );
  });

  it("attaches nothing when no decision has been made (fail closed)", () => {
    stubLocalStorage();
    store.clear();
    const headers = attachConsentHeader(new Headers());
    expect(headers.get(CONSENT_HEADER)).toBeNull();
  });
});

describe("declined receipt", () => {
  it("is an explicit all-off receipt, not an undecided one", () => {
    const declined = declinedReceipt();
    expect(declined).toEqual({
      v: 1,
      ai: false,
      voice: false,
      at: declined.at,
    });
    expect(() => new Date(declined.at)).not.toThrow();
    expect(Number.isNaN(new Date(declined.at).getTime())).toBe(false);
  });
});
