// Consent gate (Mission v2.1 M5, Linear HACK-81, VAL-CONSENT-001..005).
//
// The product-owner rule (Oct 30): NO user content reaches ANY API without
// explicit informed consent. This module owns the shared mechanism:
//
// - The CONSENT RECEIPT — what the user allowed, stored WITH THE USER
//   (localStorage, per device). It carries the decision and nothing else:
//   no answer data, no session id, no PII. It is inspectable and revocable
//   from the UI, and every send re-reads it, so revoking stops further
//   sends immediately.
// - The PATH REGISTRY — every path that sends user content (or triggers a
//   provider call at all), with plain-language provider + purpose + the
//   vendor terms we verified live. A path whose terms are NOT verified can
//   never enable (client and server both check), so a toggle is disabled
//   with honest copy until someone does the verification work.
//
// HONEST FRAMING (do not soften): in the conversation engine, structured
// extraction is the one call that sees the RAW typed sentence — redaction
// protects storage and the screen, not that send. This gate does not
// pretend the raw-word send does not happen; it DISCLOSES it in the
// consent copy and puts the user's explicit consent in front of it.

export const CONSENT_HEADER = "x-bn-consent";

export const CONSENT_STORAGE_KEY = "bn-consent-receipt-v2";

/**
 * The provider that receives USER content under this receipt: the Meta
 * Model API (typed words for extraction + reply, voice for transcription).
 * Gemini TTS receives only the assistant's own reply text, never user
 * content, and the fax path cannot enable until its vendor is verified --
 * if either ever becomes a user-content send to a different provider, that
 * path needs its own provider-bound grant rather than stretching this id.
 * Swapping the vendor behind the conversation sends means changing this id,
 * which fails old receipts closed (no consent) instead of letting consent
 * granted to one provider silently cover another (PR #50 / HACK-96).
 */
export const CONSENT_PROVIDER_ID = "meta-model-api" as const;

/** The stored-with-the-user consent decision. No answer data, ever. */
export interface ConsentReceipt {
  /** Receipt schema version — parsing fails closed on anything else. */
  readonly v: 2;
  /** Provider this consent was granted to; any other provider parses as no consent. */
  readonly providerId: typeof CONSENT_PROVIDER_ID;
  /** Typed words may go to the Meta chat model (extraction + reply). */
  readonly ai: boolean;
  /** Voice may additionally go to Meta STT (and replies via Gemini TTS). */
  readonly voice: boolean;
  /** The signed packet may go to the fax provider (HACK-88). Optional on the wire: receipts written before the fax path existed parse with fax off — absence never reads as consent. */
  readonly fax?: boolean;
  /** ISO-8601 timestamp of the decision, for the inspectable receipt. */
  readonly at: string;
}

/** A vendor's data-handling terms, verified live on `verifiedOn`. */
export interface ConsentPathTerms {
  readonly label: string;
  readonly url: string;
  readonly verifiedOn: string;
}

export type ConsentPathId = "ai-conversation" | "voice" | "fax";

/**
 * One consented path: what it sends, to whom, for what, under which
 * verified terms. The consent surface renders its copy FROM this registry,
 * so copy and enforcement cannot drift apart.
 */
export interface ConsentPathSpec {
  readonly id: ConsentPathId;
  readonly provider: string;
  readonly sends: readonly string[];
  readonly purpose: string;
  readonly terms: readonly ConsentPathTerms[];
  /** Verified by a human against the linked terms on the recorded date. */
  readonly termsVerified: boolean;
}

/**
 * The consented paths of the app surface (HACK-81: voice + fax are the only
 * consented paths; fax is post-submission and owned by HACK-75/90, so the
 * conversation APIs are everything this surface must cover).
 *
 * Terms verified LIVE on 2026-10-30 (findings recorded in the mission
 * library, library/model.md + library/voice.md):
 *
 * - Meta Model API (https://dev.meta.ai/legal/commitments): content from
 *   Standard Services is NOT used to train Meta's models; content IS
 *   retained per Meta's Terms/Privacy Policy — a data-handling commitment,
 *   NOT a zero-retention guarantee. The honest copy below says so.
 * - Gemini API (https://ai.google.dev/gemini-api/terms): the UNPAID
 *   services say Google may use submitted content to improve its products
 *   and says "do not submit sensitive, confidential, or personal
 *   information to the Unpaid Services". The TTS call therefore carries
 *   ONLY the assistant's own (already redacted, gated) reply text — never
 *   user content — and the copy discloses the tier honestly.
 */
/**
 * The fax path (HACK-88, under HACK-75): the one post-submission send.
 * Its provider is deliberately a TO-BE-VERIFIED placeholder: HACK-89 owns
 * the vendor evaluation (documented no-retention terms + per-fax cost +
 * test destination), and until that lands `termsVerified` stays false, so
 * `consentPathEnabled("fax", ...)` is false for every receipt — the send
 * cannot be enabled by consent alone, exactly like the other paths before
 * their terms were verified. When HACK-89 names the vendor, this entry's
 * provider/terms are updated in the same reviewable change.
 */
export const FAX_PATH_UNVERIFIED: ConsentPathSpec = {
  id: "fax",
  provider: "Fax provider (to be named when its terms are verified)",
  sends: ["your signed application packet"],
  purpose:
    "to fax your signed application packet to the destination you confirm",
  terms: [],
  termsVerified: false,
};

export const CONSENT_PATHS: readonly ConsentPathSpec[] = [
  FAX_PATH_UNVERIFIED,
  {
    id: "ai-conversation",
    provider: "Meta (the Meta Model API chat model)",
    sends: ["the words you type"],
    purpose: "to understand your answer and ask you the next question",
    terms: [
      {
        label: "Meta Model API Data Commitments",
        url: "https://dev.meta.ai/legal/commitments",
        verifiedOn: "2026-10-30",
      },
    ],
    termsVerified: true,
  },
  {
    id: "voice",
    provider:
      "Meta (speech-to-text) and Google Gemini (text-to-speech, free tier)",
    sends: ["your recorded voice", "the assistant's reply text, to read it aloud"],
    purpose:
      "to turn your speech into text, and to read the assistant's replies aloud",
    terms: [
      {
        label: "Meta Model API Data Commitments",
        url: "https://dev.meta.ai/legal/commitments",
        verifiedOn: "2026-10-30",
      },
      {
        label: "Gemini API Additional Terms of Service",
        url: "https://ai.google.dev/gemini-api/terms",
        verifiedOn: "2026-10-30",
      },
    ],
    termsVerified: true,
  },
];

/** The registry entry for a path id, or undefined for an unknown id. */
export function consentPathById(
  id: ConsentPathId,
  paths: readonly ConsentPathSpec[] = CONSENT_PATHS,
): ConsentPathSpec | undefined {
  return paths.find((path) => path.id === id);
}

/**
 * Whether a path may send right now. BOTH conditions must hold:
 * the path's vendor terms are verified, and the user's receipt allows it.
 * No receipt = no consent = false (fail closed).
 */
export function consentPathEnabled(
  id: ConsentPathId,
  receipt: ConsentReceipt | null,
  paths: readonly ConsentPathSpec[] = CONSENT_PATHS,
): boolean {
  const path = consentPathById(id, paths);
  if (!path || !path.termsVerified) {
    return false;
  }
  if (id === "ai-conversation") {
    return receipt?.ai === true;
  }
  if (id === "fax") {
    return receipt?.fax === true;
  }
  // Voice is its own additional toggle AND rides on the AI consent: a
  // spoken turn reaches the same extraction path as a typed one.
  return receipt?.ai === true && receipt?.voice === true;
}

/**
 * Parse a receipt from the consent header (or storage). Fails CLOSED:
 * garbage, wrong versions, wrong types, or an unparseable timestamp all
 * mean "no consent", never "maybe consent".
 */
export function parseConsentReceipt(raw: string | null | undefined): ConsentReceipt | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 2 || record.providerId !== CONSENT_PROVIDER_ID) {
    return null;
  }
  if (typeof record.ai !== "boolean" || typeof record.voice !== "boolean") {
    return null;
  }
  if (record.fax !== undefined && typeof record.fax !== "boolean") {
    return null;
  }
  if (typeof record.at !== "string" || Number.isNaN(new Date(record.at).getTime())) {
    return null;
  }
  // Only the decision fields survive: unknown fields are dropped so a
  // future receipt can never smuggle state through the gate. A missing
  // fax field (older receipts) stays missing, which the gate reads as off.
  return {
    v: 2,
    providerId: CONSENT_PROVIDER_ID,
    ai: record.ai,
    voice: record.voice,
    ...(record.fax !== undefined ? { fax: record.fax } : {}),
    at: record.at,
  };
}

/** The receipt as a header value. */
export function consentReceiptHeader(receipt: ConsentReceipt): string {
  return JSON.stringify(receipt);
}

/** An explicit all-off receipt — a decision, not an absence of one. */
export function declinedReceipt(now: Date = new Date()): ConsentReceipt {
  return { v: 2, providerId: CONSENT_PROVIDER_ID, ai: false, voice: false, at: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Client-side receipt storage (per device, with the user)
// ---------------------------------------------------------------------------

function localStorageLike(): Storage | null {
  // Server rendering has no storage at all (fail closed: no receipt).
  return typeof localStorage === "undefined" ? null : localStorage;
}

/**
 * Read the receipt from this device as a STABLE snapshot for
 * useSyncExternalStore: the parsed receipt is cached by the raw string, so
 * repeated reads between writes return the same object identity.
 */
let snapshotCache: { raw: string | null; receipt: ConsentReceipt | null } | null =
  null;

export function cachedConsentSnapshot(): ConsentReceipt | null {
  const raw = localStorageLike()?.getItem(CONSENT_STORAGE_KEY) ?? null;
  if (!snapshotCache || snapshotCache.raw !== raw) {
    snapshotCache = { raw, receipt: parseConsentReceipt(raw) };
  }
  return snapshotCache.receipt;
}

const consentListeners = new Set<() => void>();

/**
 * Subscribe to receipt changes on this device: local writes notify the
 * writing tab directly, and other tabs' writes arrive through the browser's
 * storage event — so revoking in one tab stops sends everywhere at once.
 */
export function subscribeToConsentChanges(listener: () => void): () => void {
  consentListeners.add(listener);
  if (typeof window !== "undefined") {
    window.addEventListener("storage", listener);
  }
  return () => {
    consentListeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", listener);
    }
  };
}

function notifyConsentListeners(): void {
  for (const listener of consentListeners) {
    listener();
  }
}

/** Read the receipt from this device. Server rendering has none (null). */
export function loadConsentReceipt(): ConsentReceipt | null {
  return parseConsentReceipt(localStorageLike()?.getItem(CONSENT_STORAGE_KEY) ?? null);
}

/** Persist the receipt on this device and notify listeners (this tab). */
export function saveConsentReceipt(receipt: ConsentReceipt): void {
  localStorageLike()?.setItem(CONSENT_STORAGE_KEY, consentReceiptHeader(receipt));
  notifyConsentListeners();
}

/**
 * Remove the receipt entirely — back to "no decision" (the consent surface
 * shows again). Used when the server reports the send lacked consent.
 */
export function clearConsentReceipt(): void {
  localStorageLike()?.removeItem(CONSENT_STORAGE_KEY);
  notifyConsentListeners();
}

/**
 * Attach the consent header to an outgoing request when this device has a
 * receipt. Requests without a receipt simply carry no header — and every
 * gated route treats a missing header as "no consent" (fail closed).
 */
export function attachConsentHeader(headers: Headers): Headers {
  const receipt = loadConsentReceipt();
  if (receipt) {
    headers.set(CONSENT_HEADER, consentReceiptHeader(receipt));
  }
  return headers;
}
