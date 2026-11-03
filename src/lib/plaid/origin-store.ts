import { openSealed, sealForStorage } from "../intake/client-store";
import {
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  DEVICE_PLAID_ORIGINS_ENVELOPE_KEY,
  envelopeIdentity,
  generateSealingKey,
  isSealingKey,
  openDeviceAnswerStore,
  type DeviceAnswerStoreDeps,
  type DeviceAnswerStoreOpen,
} from "../intake/device-answer-store";

// The Plaid institution name is pii:true: it can identify the person's
// bank. The answer table therefore never carries it. The browser captures
// it from Plaid Link and keeps it here, sealed under the same
// non-extractable device key as the HACK-99 answer store, keyed by the
// income question it belongs to (HACK-140).
//
// This is metadata about an answer, not an answer: it is validated only
// against the ids the Plaid card actually proposes and is never merged into
// the answer records or sent to the server. `purgeDeviceAnswers` deletes this
// envelope with the answers; `purgePlaidOrigins` deletes just this map
// (the conversation page's purge, which does not own the device answers).
export type PlaidOrigins = Readonly<Record<string, string>>;
export const EMPTY_PLAID_ORIGINS: PlaidOrigins = {};

const MAX_INSTITUTION_NAME_LENGTH = 120;
const SAVE_ATTEMPTS = 3;
/** The ids `plaidIncomeProposals` can propose; income_sources/kind never have a bank. */
const PROPOSAL_IDS: ReadonlySet<string> = new Set([
  "job_income_amount",
  "job_income_frequency",
  "benefits_income_amount",
  "benefits_income_frequency",
  "other_income_amount",
]);

export type PlaidOriginSave =
  | { readonly status: "saved"; readonly origins: PlaidOrigins }
  /** The map this page loaded was deleted on the device before this save. */
  | { readonly status: "purged" }
  /** Another tab kept changing the map; nothing was written. */
  | { readonly status: "busy" }
  /** This browser cannot keep anything on the device. */
  | { readonly status: "unavailable" };

function cleanInstitutionName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim();
  return name === "" || name.length > MAX_INSTITUTION_NAME_LENGTH ? null : name;
}

/** Keep only income questions with a non-blank, bounded institution name. */
export function parsePlaidOrigins(value: unknown): PlaidOrigins {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return EMPTY_PLAID_ORIGINS;
  }
  const origins: Record<string, string> = {};
  for (const [questionId, rawName] of Object.entries(value)) {
    if (!PROPOSAL_IDS.has(questionId)) {
      continue;
    }
    const name = cleanInstitutionName(rawName);
    if (name !== null) {
      origins[questionId] = name;
    }
  }
  return origins;
}

/** Apply per-question updates; a null (or blank) name removes that origin. */
export function withPlaidOriginUpdates(
  origins: PlaidOrigins,
  updates: Readonly<Record<string, string | null>>,
): PlaidOrigins {
  const next: Record<string, string> = { ...origins };
  for (const [questionId, rawName] of Object.entries(updates)) {
    if (!PROPOSAL_IDS.has(questionId)) {
      continue;
    }
    const name = cleanInstitutionName(rawName);
    if (name === null) {
      delete next[questionId];
    } else {
      next[questionId] = name;
    }
  }
  return next;
}

interface OriginsRead {
  readonly identity: string;
  readonly key: CryptoKey | null;
  readonly readable: boolean;
  readonly origins: PlaidOrigins;
}

function parseSerializedOrigins(plain: string | null): PlaidOrigins {
  if (plain === null) {
    return EMPTY_PLAID_ORIGINS;
  }
  try {
    return parsePlaidOrigins(JSON.parse(plain));
  } catch {
    return EMPTY_PLAID_ORIGINS;
  }
}

async function readOrigins(deps: DeviceAnswerStoreDeps): Promise<OriginsRead> {
  const [envelope, rawKey] = await deps.kv.getMany([
    DEVICE_PLAID_ORIGINS_ENVELOPE_KEY,
    DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  ]);
  const identity = envelopeIdentity(envelope);
  const key = isSealingKey(rawKey) ? rawKey : null;
  if (identity === "none") {
    return { identity, key, readable: true, origins: EMPTY_PLAID_ORIGINS };
  }
  if (key === null || typeof envelope !== "string") {
    return { identity, key, readable: false, origins: EMPTY_PLAID_ORIGINS };
  }
  const plain = await openSealed(envelope, key, deps.subtle);
  return {
    identity,
    key,
    readable: plain !== null,
    origins: parseSerializedOrigins(plain),
  };
}

/** Read this device's institution-name map; a missing or unreadable map reads as empty. */
export async function loadPlaidOrigins(
  deps: DeviceAnswerStoreDeps,
): Promise<PlaidOrigins> {
  try {
    return (await readOrigins(deps)).origins;
  } catch {
    return EMPTY_PLAID_ORIGINS;
  }
}

/**
 * Seal and write the map, reusing the device key when one exists. Like the
 * HACK-99 answer store, a save re-reads inside the transaction and retries
 * on top of another tab's write; a known map deleted in between is not
 * recreated, and the save reports `purged` instead.
 */
export async function savePlaidOrigins(
  deps: DeviceAnswerStoreDeps,
  updates: Readonly<Record<string, string | null>>,
  options: { readonly expectStored: boolean },
): Promise<PlaidOriginSave> {
  let expectStored = options.expectStored;
  for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
    const read = await readOrigins(deps);
    if (expectStored && read.identity === "none") {
      return { status: "purged" };
    }
    const next = withPlaidOriginUpdates(
      read.readable ? read.origins : EMPTY_PLAID_ORIGINS,
      updates,
    );
    const reuseKey = read.key !== null;
    const key = read.key ?? (await generateSealingKey(deps.subtle));
    const sealed = await sealForStorage(
      JSON.stringify(next),
      key,
      deps.subtle,
    );

    let written: boolean;
    if (reuseKey) {
      written = await deps.kv.setMany(
        [[DEVICE_PLAID_ORIGINS_ENVELOPE_KEY, sealed]],
        {
          key: DEVICE_PLAID_ORIGINS_ENVELOPE_KEY,
          keep: (current) => envelopeIdentity(current) !== read.identity,
        },
      );
    } else {
      // The key and the envelope are written separately (as HACK-99 does):
      // whichever tab claims the key first wins, and a tab that loses the
      // claim retries under the winner's key.
      const claimed = await deps.kv.setMany(
        [[DEVICE_ANSWERS_CRYPTO_KEY_KEY, key]],
        {
          key: DEVICE_ANSWERS_CRYPTO_KEY_KEY,
          keep: (current) => isSealingKey(current),
        },
      );
      if (!claimed) {
        expectStored = expectStored || read.identity !== "none";
        continue;
      }
      written = await deps.kv.setMany(
        [[DEVICE_PLAID_ORIGINS_ENVELOPE_KEY, sealed]],
        {
          key: DEVICE_PLAID_ORIGINS_ENVELOPE_KEY,
          keep: (current) => envelopeIdentity(current) !== read.identity,
        },
      );
    }

    if (written) {
      return { status: "saved", origins: next };
    }
    expectStored = expectStored || read.identity !== "none";
  }
  return { status: "busy" };
}

/**
 * Delete only the institution-name envelope (the shared key stays for the
 * other device stores). Resolves to true only when a read afterwards finds
 * it gone; never rejects.
 */
export async function purgePlaidOrigins(
  deps: DeviceAnswerStoreDeps,
): Promise<boolean> {
  try {
    const deleted = await deps.kv.deleteMany([
      DEVICE_PLAID_ORIGINS_ENVELOPE_KEY,
    ]);
    if (!deleted) {
      return false;
    }
    const [remaining] = await deps.kv.getMany([
      DEVICE_PLAID_ORIGINS_ENVELOPE_KEY,
    ]);
    return remaining === undefined;
  } catch {
    return false;
  }
}

type OpenDeviceStore = () => Promise<DeviceAnswerStoreOpen>;

async function tryOpen(
  open: OpenDeviceStore,
): Promise<DeviceAnswerStoreOpen | null> {
  try {
    return await open();
  } catch {
    return null;
  }
}

export async function loadPlaidOriginsFromDevice(
  open: OpenDeviceStore = openDeviceAnswerStore,
): Promise<PlaidOrigins> {
  const opened = await tryOpen(open);
  return opened?.status === "ok"
    ? loadPlaidOrigins(opened.store)
    : EMPTY_PLAID_ORIGINS;
}

export async function savePlaidOriginsToDevice(
  updates: Readonly<Record<string, string | null>>,
  options: { readonly expectStored: boolean },
  open: OpenDeviceStore = openDeviceAnswerStore,
): Promise<PlaidOriginSave> {
  const opened = await tryOpen(open);
  if (opened?.status !== "ok") {
    return { status: "unavailable" };
  }
  return savePlaidOrigins(opened.store, updates, options);
}

/**
 * Delete the institution-name map from this browser. An unsupported browser
 * never stored one, so that reads as cleared; an unreachable store does not.
 */
export async function purgePlaidOriginsFromDevice(
  open: OpenDeviceStore = openDeviceAnswerStore,
): Promise<boolean> {
  const opened = await tryOpen(open);
  if (opened === null) {
    return false;
  }
  if (opened.status === "unsupported") {
    return true;
  }
  return opened.status === "ok"
    ? purgePlaidOrigins(opened.store)
    : false;
}
