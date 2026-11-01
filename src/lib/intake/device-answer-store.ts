import { deviceStorageSupported, openDeviceKv, type DeviceKv } from "../device-kv";
import {
  EMPTY_CLIENT_ANSWERS,
  openSealed,
  parseClientAnswers,
  saveClientAnswer,
  sealForStorage,
  serializeClientAnswers,
  type ClientAnswerRecord,
  type ClientAnswerState,
} from "./client-store";

// The durable on-device answer store (HACK-99): the client store's sealed
// answers kept across page loads.
//
// The real-data rules allow a person's answers to be kept only on their
// device and only encrypted with a key that exists there alone. So the
// answers are sealed (client-store.ts's AES-256-GCM `sealed1.` envelope)
// under a key generated in the browser as NON-EXTRACTABLE: the browser can
// use it, but no script can read its bytes. The key and the sealed answers
// sit side by side in IndexedDB (device-kv.ts), always read in one
// transaction and written in one transaction, so the pair on the device
// always matches. Nothing here sends anything anywhere.
//
// Several tabs can share the store. A save re-reads the stored answers,
// applies its one answer to what is there now, and writes only if the
// stored answers are still the ones it read; when another tab saved in
// between it tries again on top of that tab's answers, and when the answers
// were deleted in between (the purge, in another tab) it writes nothing and
// says so, so a delete is never undone by a slower tab.
//
// The purge deletes the key and the sealed answers together. Without the
// key no copy of the ciphertext can ever be opened again, and the purge
// reports success only when a read afterwards finds neither.

export const DEVICE_ANSWERS_ENVELOPE_KEY = "intake-answers";
/** KV key for the sealed Rampart session table (HACK-107), sealed under the same device key. */
export const DEVICE_SESSION_ENVELOPE_KEY = "rampart-session";
export const DEVICE_ANSWERS_CRYPTO_KEY_KEY = "intake-answers-key";

/** How many times a save re-applies its answer when other tabs keep saving. */
export const DEVICE_SAVE_ATTEMPTS = 3;

export interface DeviceAnswerStoreDeps {
  readonly kv: DeviceKv;
  readonly subtle: SubtleCrypto;
}

export type DeviceAnswersLoad =
  /** Nothing is stored on this device. */
  | { readonly status: "none"; readonly state: ClientAnswerState }
  | { readonly status: "ok"; readonly state: ClientAnswerState }
  /**
   * Something is stored that this page cannot open (a lost key, damage, or
   * a format this version does not know). It is left in place; the next
   * save replaces it.
   */
  | { readonly status: "unreadable"; readonly state: ClientAnswerState };

export type DeviceAnswerSave =
  | { readonly status: "saved"; readonly state: ClientAnswerState }
  /**
   * The answers this page knew were deleted from the device after it read
   * them (the purge in another tab, or the browser clearing site data).
   * Nothing was written.
   */
  | { readonly status: "purged" }
  /** Other tabs kept changing the answers; nothing was written. */
  | { readonly status: "busy" };

/** A usable sealing key: AES-GCM, secret, non-extractable, encrypt + decrypt. */
export function isSealingKey(value: unknown): value is CryptoKey {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const key = value as Partial<CryptoKey>;
  return (
    key.type === "secret" &&
    key.extractable === false &&
    typeof key.algorithm === "object" &&
    key.algorithm !== null &&
    key.algorithm.name === "AES-GCM" &&
    Array.isArray(key.usages) &&
    key.usages.includes("encrypt") &&
    key.usages.includes("decrypt")
  );
}

/**
 * What is stored under the envelope key, for telling whether it changed
 * between a save's read and its write: nothing, a sealed envelope (each
 * save seals under a fresh IV, so every envelope is a different string), or
 * something else, which a save may replace.
 */
export function envelopeIdentity(raw: unknown): string {
  if (raw === undefined || raw === null) {
    return "none";
  }
  return typeof raw === "string" ? `sealed:${raw}` : "other";
}

interface StoredRead {
  readonly identity: string;
  /** The stored key, when it is a usable sealing key. */
  readonly key: CryptoKey | null;
  /** True when the key slot holds nothing at all (a fresh device). */
  readonly keySlotEmpty: boolean;
  /** True when nothing is stored or the stored answers opened under the key. */
  readonly readable: boolean;
  readonly state: ClientAnswerState;
}

async function readStored(deps: DeviceAnswerStoreDeps): Promise<StoredRead> {
  const [rawEnvelope, rawKey] = await deps.kv.getMany([
    DEVICE_ANSWERS_ENVELOPE_KEY,
    DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  ]);
  const identity = envelopeIdentity(rawEnvelope);
  const key = isSealingKey(rawKey) ? rawKey : null;
  const keySlotEmpty = rawKey === undefined || rawKey === null;
  if (identity === "none") {
    return { identity, key, keySlotEmpty, readable: true, state: EMPTY_CLIENT_ANSWERS };
  }
  if (typeof rawEnvelope !== "string" || key === null) {
    return { identity, key, keySlotEmpty, readable: false, state: EMPTY_CLIENT_ANSWERS };
  }
  const plaintext = await openSealed(rawEnvelope, key, deps.subtle);
  if (plaintext === null) {
    return { identity, key, keySlotEmpty, readable: false, state: EMPTY_CLIENT_ANSWERS };
  }
  return { identity, key, keySlotEmpty, readable: true, state: parseClientAnswers(plaintext) };
}

export function generateSealingKey(subtle: SubtleCrypto): Promise<CryptoKey> {
  return subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Read the answers kept on this device. Never deletes or rewrites anything. */
export async function loadDeviceAnswers(
  deps: DeviceAnswerStoreDeps,
): Promise<DeviceAnswersLoad> {
  const read = await readStored(deps);
  if (read.identity === "none") {
    return { status: "none", state: EMPTY_CLIENT_ANSWERS };
  }
  return read.readable
    ? { status: "ok", state: read.state }
    : { status: "unreadable", state: EMPTY_CLIENT_ANSWERS };
}

export interface RecordDeviceAnswerOptions {
  /**
   * Whether the page believes answers are already kept on this device (it
   * loaded some, or saved one). Finding none then means they were deleted
   * since, and the save stops instead of starting a new store.
   */
  readonly expectStored: boolean;
}

/**
 * Save one answer into the answers kept on this device and return the full
 * state now stored. Throws, before touching storage, when the record breaks
 * the client store's contracts (unknown question, value on an unknown
 * answer, a draft marked as verified). Storage failures reject.
 */
export async function recordDeviceAnswer(
  deps: DeviceAnswerStoreDeps,
  record: ClientAnswerRecord,
  options: RecordDeviceAnswerOptions,
): Promise<DeviceAnswerSave> {
  // An invalid record must never reach storage: this throws first.
  saveClientAnswer(EMPTY_CLIENT_ANSWERS, record);
  let expectStored = options.expectStored;
  for (let attempt = 0; attempt < DEVICE_SAVE_ATTEMPTS; attempt += 1) {
    const read = await readStored(deps);
    if (expectStored && read.identity === "none") {
      return { status: "purged" };
    }
    // Unreadable answers cannot be merged into; this answer replaces them,
    // under a fresh key, as the load already told the person.
    const next = saveClientAnswer(read.readable ? read.state : EMPTY_CLIENT_ANSWERS, record);
    // A usable stored key is reused and never rewritten: a concurrent first
    // save (the same device open in two tabs, or a wizard answer save racing
    // a conversation send) must not be able to orphan its envelope by
    // rewriting the shared sealing key. Only a generated key is written, and
    // the write checks in its own transaction that the key slot is still
    // empty, so only one of the overlapping first saves wins; the loser
    // retries under the winner's key.
    const reuseKey = read.key !== null && read.readable;
    const key = reuseKey ? read.key : await generateSealingKey(deps.subtle);
    const sealed = await sealForStorage(serializeClientAnswers(next), key, deps.subtle);
    // The key is written with the envelope it sealed, so the pair on the
    // device always matches. The write checks, in its own transaction, that
    // what was read has not changed: either the key slot is still empty
    // (a generated key, so no overlapping save has landed one) or the
    // envelope is still the one read (a reused key).
    const requiresEmptyKeySlot = !reuseKey && read.keySlotEmpty;
    const written = await deps.kv.setMany(
      requiresEmptyKeySlot || !reuseKey
        ? [
            [DEVICE_ANSWERS_CRYPTO_KEY_KEY, key],
            [DEVICE_ANSWERS_ENVELOPE_KEY, sealed],
          ]
        : [[DEVICE_ANSWERS_ENVELOPE_KEY, sealed]],
      requiresEmptyKeySlot
        ? {
            key: DEVICE_ANSWERS_CRYPTO_KEY_KEY,
            keep: (current) => current !== undefined && current !== null,
          }
        : {
            key: DEVICE_ANSWERS_ENVELOPE_KEY,
            keep: (current) => envelopeIdentity(current) !== read.identity,
          },
    );
    if (written) {
      return { status: "saved", state: next };
    }
    // Another tab saved or deleted since the read. Once answers were seen
    // on the device, finding none on the next read means a delete.
    expectStored = expectStored || read.identity !== "none";
  }
  return { status: "busy" };
}

/**
 * Delete the answers and their key from this device in one transaction.
 * Resolves to true only when a read afterwards finds neither; any failure,
 * or another tab writing in between, resolves to false. Never rejects.
 */
export async function purgeDeviceAnswers(deps: DeviceAnswerStoreDeps): Promise<boolean> {
  try {
    const deleted = await deps.kv.deleteMany([
      DEVICE_ANSWERS_ENVELOPE_KEY,
      DEVICE_SESSION_ENVELOPE_KEY,
      DEVICE_ANSWERS_CRYPTO_KEY_KEY,
    ]);
    if (!deleted) {
      return false;
    }
    const [envelope, session, key] = await deps.kv.getMany([
      DEVICE_ANSWERS_ENVELOPE_KEY,
      DEVICE_SESSION_ENVELOPE_KEY,
      DEVICE_ANSWERS_CRYPTO_KEY_KEY,
    ]);
    return envelope === undefined && session === undefined && key === undefined;
  } catch {
    return false;
  }
}

export type DeviceAnswerStoreOpen =
  | { readonly status: "ok"; readonly store: DeviceAnswerStoreDeps }
  /**
   * This browser can't keep anything on the device (no IndexedDB, or no Web
   * Crypto because the page is not https or localhost). Nothing was ever
   * stored here.
   */
  | { readonly status: "unsupported" }
  /**
   * Device storage exists but did not open in time or refused. Answers from
   * an earlier visit may be stored and out of reach for now.
   */
  | { readonly status: "failed" };

/** Open this browser's answer store, saying why when it can't. Never rejects. */
export async function openDeviceAnswerStore(
  openKv: () => Promise<DeviceKv | null> = openDeviceKv,
  supported: () => boolean = deviceStorageSupported,
): Promise<DeviceAnswerStoreOpen> {
  if (!supported()) {
    return { status: "unsupported" };
  }
  let subtle: SubtleCrypto | undefined;
  try {
    subtle = globalThis.crypto?.subtle;
  } catch {
    subtle = undefined;
  }
  if (subtle === undefined) {
    return { status: "unsupported" };
  }
  const kv = await openKv().catch(() => null);
  return kv === null ? { status: "failed" } : { status: "ok", store: { kv, subtle } };
}
