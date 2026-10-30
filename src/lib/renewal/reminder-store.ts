import {
  RENEWAL_REMINDER_VERSION,
  validateReminder,
  type RenewalReminder,
} from "./reminder";

/**
 * The on-device reminder store (BN-22 / HACK-50).
 *
 * The real-data rules (.github/claude-review/rules.md, Oct 29) allow a
 * person's answers to be kept only when encrypted on the client with a key
 * that exists only on their device. So the reminder is sealed with
 * AES-GCM-256 under a key generated in the browser as NON-EXTRACTABLE: the
 * browser can use it, but no script can read its bytes, and nothing here
 * ever sends it (or the reminder) anywhere. Key and sealed reminder sit in
 * the browser's own storage (IndexedDB, see device-kv.ts), so clearing site
 * data removes both.
 *
 * Reading back trusts nothing: the envelope shape, the format tag, the
 * version, the AES-GCM tag (which also binds the format and version as
 * additional data), and the decrypted record's exact shape are all checked.
 *
 * Several tabs can share the store, so the key and the sealed reminder are
 * always read together in one transaction and written together in one
 * transaction, and a reminder that fails its checks is deleted only if it
 * is still the one that was read (review fix: a tab finishing a slow read
 * could otherwise wipe a reminder another tab had just saved). Only the
 * tracker deletes; the banner reads without deleting, so the person is
 * always told when a reminder is dropped. One written by a newer version is
 * left alone.
 */

/** Tells deleteMany to keep everything: decided inside the delete's own transaction. */
export interface KvGuard {
  /** The key whose current value decides. */
  readonly key: string;
  /** True when that value means the keys must stay (it changed since it was read). */
  readonly keep: (current: unknown) => boolean;
}

/** Minimal async key-value storage (IndexedDB in the browser). Every call is one transaction. */
export interface DeviceKv {
  /** Read several keys from one consistent snapshot. Missing keys read as undefined. */
  getMany(keys: readonly string[]): Promise<readonly unknown[]>;
  /** Write several entries together: all of them land, or none do. */
  setMany(entries: readonly (readonly [string, unknown])[]): Promise<void>;
  /**
   * Delete several keys together. With a guard, the guard key is read in
   * the same transaction and nothing is deleted when `keep` returns true.
   * Resolves to whether the keys were deleted.
   */
  deleteMany(keys: readonly string[], guard?: KvGuard): Promise<boolean>;
}

/** The parts of Web Crypto the store uses. */
export interface DeviceCrypto {
  readonly subtle: SubtleCrypto;
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>;
}

export interface ReminderStoreDeps {
  readonly kv: DeviceKv;
  readonly crypto: DeviceCrypto;
}

export const REMINDER_ENVELOPE_KEY = "renewal-reminder";
export const REMINDER_CRYPTO_KEY_KEY = "renewal-reminder-key";
export const REMINDER_ENVELOPE_FORMAT = "benefits-navigator/renewal-reminder";
export const REMINDER_ENVELOPE_VERSION = 1;

const IV_OCTETS = 12;
const GCM_TAG_OCTETS = 16;
const MAX_CIPHERTEXT_OCTETS = 4096;

/** What a sealed reminder looks like in storage. */
interface ReminderEnvelope {
  readonly format: typeof REMINDER_ENVELOPE_FORMAT;
  readonly version: typeof REMINDER_ENVELOPE_VERSION;
  readonly iv: Uint8Array<ArrayBuffer>;
  readonly ciphertext: ArrayBuffer;
}

export type LoadReminderResult =
  | { readonly status: "none" }
  | { readonly status: "ok"; readonly reminder: RenewalReminder }
  /** Unreadable or invalid: it was deleted from the device. */
  | { readonly status: "discarded" }
  /** Unreadable or invalid, left in place by a read-only load. */
  | { readonly status: "unreadable" }
  /** Sealed by a newer version of the app: left in place, not shown. */
  | { readonly status: "unsupported" };

export interface LoadReminderOptions {
  /**
   * Report an unreadable reminder as "unreadable" and leave it in place.
   * The banner loads this way, so only the tracker, which shows the
   * person a notice, ever deletes one.
   */
  readonly readOnly?: boolean;
}

function additionalData(version: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${REMINDER_ENVELOPE_FORMAT}@${version}`);
}

function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value);
}

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

type EnvelopeCheck =
  | { readonly kind: "valid"; readonly envelope: ReminderEnvelope }
  | { readonly kind: "newer" }
  | { readonly kind: "invalid" };

function checkEnvelope(raw: unknown): EnvelopeCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "invalid" };
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope.format !== REMINDER_ENVELOPE_FORMAT) {
    return { kind: "invalid" };
  }
  if (
    typeof envelope.version === "number" &&
    Number.isInteger(envelope.version) &&
    envelope.version > REMINDER_ENVELOPE_VERSION
  ) {
    return { kind: "newer" };
  }
  const keys = Object.keys(envelope).sort().join(",");
  if (
    envelope.version !== REMINDER_ENVELOPE_VERSION ||
    keys !== "ciphertext,format,iv,version" ||
    tagOf(envelope.iv) !== "[object Uint8Array]" ||
    (envelope.iv as Uint8Array).byteLength !== IV_OCTETS ||
    tagOf(envelope.ciphertext) !== "[object ArrayBuffer]" ||
    (envelope.ciphertext as ArrayBuffer).byteLength <= GCM_TAG_OCTETS ||
    (envelope.ciphertext as ArrayBuffer).byteLength > MAX_CIPHERTEXT_OCTETS
  ) {
    return { kind: "invalid" };
  }
  return { kind: "valid", envelope: envelope as unknown as ReminderEnvelope };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}

/**
 * Whether the stored envelope is no longer the one that was read: another
 * tab saved a new reminder (a valid envelope with a different IV) or a
 * newer version of the app wrote one. Either way it must not be deleted.
 */
function replacedSince(current: unknown, readIv: Uint8Array | null): boolean {
  const check = checkEnvelope(current);
  if (check.kind === "newer") {
    return true;
  }
  return check.kind === "valid" && (readIv === null || !sameBytes(check.envelope.iv, readIv));
}

/** Seal and store a reminder, replacing any earlier one. */
export async function saveReminder(
  reminder: RenewalReminder,
  deps: ReminderStoreDeps,
): Promise<void> {
  if (reminder.version !== RENEWAL_REMINDER_VERSION) {
    throw new RangeError("only current-version reminders can be saved");
  }
  const [existing] = await deps.kv.getMany([REMINDER_CRYPTO_KEY_KEY]);
  const key = isSealingKey(existing)
    ? existing
    : await deps.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
  const iv = deps.crypto.getRandomValues(new Uint8Array(IV_OCTETS));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      version: reminder.version,
      entryId: reminder.entryId,
      kind: reminder.kind,
      reportedDate: reminder.reportedDate,
      calendarId: reminder.calendarId,
      revision: reminder.revision,
      ...(reminder.ageAnswer !== undefined
        ? {
            ageAnswer: {
              min: reminder.ageAnswer.min,
              max: reminder.ageAnswer.max,
              answer: reminder.ageAnswer.answer,
            },
          }
        : {}),
    }),
  );
  const ciphertext = await deps.crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(REMINDER_ENVELOPE_VERSION) },
    key,
    plaintext,
  );
  const envelope: ReminderEnvelope = {
    format: REMINDER_ENVELOPE_FORMAT,
    version: REMINDER_ENVELOPE_VERSION,
    iv,
    ciphertext,
  };
  // The key is written with the envelope it sealed, so the pair on the
  // device always matches, whichever tab saved last.
  await deps.kv.setMany([
    [REMINDER_CRYPTO_KEY_KEY, key],
    [REMINDER_ENVELOPE_KEY, envelope],
  ]);
}

/** Delete the sealed reminder and its key from the device. */
export async function clearReminder(deps: ReminderStoreDeps): Promise<void> {
  await deps.kv.deleteMany([REMINDER_ENVELOPE_KEY, REMINDER_CRYPTO_KEY_KEY]);
}

async function openEnvelope(
  envelope: ReminderEnvelope,
  key: CryptoKey,
  knownEntryIds: readonly string[],
  subtle: SubtleCrypto,
): Promise<RenewalReminder | null> {
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle.decrypt(
      { name: "AES-GCM", iv: envelope.iv, additionalData: additionalData(envelope.version) },
      key,
      envelope.ciphertext,
    );
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    return null;
  }
  return validateReminder(parsed, knownEntryIds);
}

async function loadOnce(
  deps: ReminderStoreDeps,
  knownEntryIds: readonly string[],
  options: LoadReminderOptions,
  mayRetry: boolean,
): Promise<LoadReminderResult> {
  const [raw, key] = await deps.kv.getMany([REMINDER_ENVELOPE_KEY, REMINDER_CRYPTO_KEY_KEY]);
  if (raw === undefined || raw === null) {
    return { status: "none" };
  }
  const check = checkEnvelope(raw);
  if (check.kind === "newer") {
    return { status: "unsupported" };
  }
  if (check.kind === "valid" && isSealingKey(key)) {
    const reminder = await openEnvelope(check.envelope, key, knownEntryIds, deps.crypto.subtle);
    if (reminder !== null) {
      return { status: "ok", reminder };
    }
  }
  if (options.readOnly === true) {
    return { status: "unreadable" };
  }
  const readIv = check.kind === "valid" ? check.envelope.iv : null;
  const deleted = await deps.kv.deleteMany([REMINDER_ENVELOPE_KEY, REMINDER_CRYPTO_KEY_KEY], {
    key: REMINDER_ENVELOPE_KEY,
    keep: (current) => replacedSince(current, readIv),
  });
  if (!deleted && mayRetry) {
    // Another tab saved a new reminder after this read: show that one.
    return loadOnce(deps, knownEntryIds, options, false);
  }
  return { status: "discarded" };
}

/**
 * Read the reminder back, validating every layer. Only the entry ids the
 * caller knows are accepted, so a reminder for an entry that no longer
 * exists is discarded rather than shown against the wrong facts.
 */
export async function loadReminder(
  deps: ReminderStoreDeps,
  knownEntryIds: readonly string[],
  options: LoadReminderOptions = {},
): Promise<LoadReminderResult> {
  return loadOnce(deps, knownEntryIds, options, true);
}
