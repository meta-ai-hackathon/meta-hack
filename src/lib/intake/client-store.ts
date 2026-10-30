import { isAnswerStatus, type AnswerStatus } from "../honesty";
import type { AnswerMap, StoredAnswer } from "./flow";
import { QUESTION_BY_ID, type Question } from "./spec";

// Client-side answer store (HACK-94, under HACK-82): where form answers
// live. The governing rules are the real-data rules in
// `.github/claude-review/rules.md` (Oct 29): answers live on the user's
// device and leave it only via the consented, no-retention fax at the
// end; on-device storage is allowed ONLY when the data is encrypted with
// a key that exists only on the device; and the app's own endpoints never
// receive answers. This module is that store.
//
// How the pieces fit:
// - Persistence is SEALED: `saveClientAnswers` encrypts the serialized
//   state with AES-256-GCM under the device key before `setItem`, and
//   `loadClientAnswers` opens the envelope (PR #52 P1). The plaintext
//   serialize/parse pair below stays storage-free — it is the envelope's
//   inner format, never what touches localStorage. Sealing needs the
//   device key (WebCrypto, `clientKeyProvider`); without one, saves fail
//   closed (return false) and loads read as an empty journey — plaintext
//   is never written as a fallback.
// - Records carry the tri-state status + provenance + value, in ONE
//   record per question. pii:true ("vault") values live in the SAME store
//   distinguished by the spec's classification — the on-device vault is
//   a classification, not a separate server (HACK-94 reconciliation). The
//   purge (HACK-80) empties this store completely: `clearClientAnswers`.
// - The deterministic flow engine (flow.ts) runs over the AnswerMap this
//   store produces (`toAnswerMap`). It is pure and unchanged: the engine
//   never learns where answers are stored, and the store never decides
//   flow.
// - Saves are VALIDATED against the question spec (known questions only,
//   status vocabulary, no value on unknown, ai_drafted only when
//   unverified — the same contracts saveAnswer enforces server-side), so
//   nothing unvalidated can enter the store, and nothing invalid stored
//   earlier can re-enter the flow (`parseClientAnswers` drops it).
// - Defensive storage: malformed or undecryptable blobs degrade to an
//   empty store (fail-safe: the person is asked again, never shown
//   invented data), and a value that drops out of the spec is ignored
//   rather than fatal.

/** localStorage key for the client answer store. */
export const CLIENT_ANSWERS_KEY = "bn_answers_v1";

/** Where an answer came from. Mirrors the answer table's vocabulary. */
export const CLIENT_ANSWER_PROVENANCES = [
  "user_supplied",
  "ai_drafted",
  "source_verified",
] as const;

export type ClientAnswerProvenance =
  (typeof CLIENT_ANSWER_PROVENANCES)[number];

export function isClientAnswerProvenance(
  value: unknown,
): value is ClientAnswerProvenance {
  return (
    typeof value === "string" &&
    (CLIENT_ANSWER_PROVENANCES as readonly string[]).includes(value)
  );
}

/** One stored answer: status + provenance + value (value null when unknown). */
export interface ClientAnswerRecord {
  readonly questionId: string;
  readonly status: AnswerStatus;
  readonly provenance: ClientAnswerProvenance;
  readonly value: unknown;
}

/** The store's whole state: one record per answered question. */
export type ClientAnswerState = Readonly<
  Record<string, ClientAnswerRecord | undefined>
>;

export const EMPTY_CLIENT_ANSWERS: ClientAnswerState = {};

/**
 * The value invariants every record must satisfy — enforced on save AND
 * re-checked on load, so a record that entered storage by another path
 * (older build, hand-edited storage) can never reach the flow:
 * - known questions only
 * - unknown records carry no value (nothing to disavow-linger, BN-13)
 * - ai_drafted provenance pairs only with unverified (a draft is never
 *   presented as user-verified)
 */
function recordIsValid(record: ClientAnswerRecord): boolean {
  if (!Object.hasOwn(QUESTION_BY_ID, record.questionId)) {
    return false;
  }
  if (!isAnswerStatus(record.status) || !isClientAnswerProvenance(record.provenance)) {
    return false;
  }
  if (record.status === "unknown" && record.value !== null) {
    return false;
  }
  if (record.provenance === "ai_drafted" && record.status !== "unverified") {
    return false;
  }
  return true;
}

/**
 * Save (or replace) one answer, returning a NEW state — the input is
 * never mutated. Callers persist with `serializeClientAnswers`. Throws on
 * an invalid record: an unvalidated answer must never enter the store.
 */
export function saveClientAnswer(
  state: ClientAnswerState,
  record: ClientAnswerRecord,
): ClientAnswerState {
  // Unknown answers normalize before validation/storage: the submitted value
  // is discarded, just as the server store persists no value for unknown.
  // This ensures saying "I'm not sure" cannot leave a stale value behind.
  const stored: ClientAnswerRecord =
    record.status === "unknown" ? { ...record, value: null } : record;
  if (!recordIsValid(stored)) {
    throw new Error(
      "That answer can't be saved: it fails the intake contracts.",
    );
  }
  return { ...state, [record.questionId]: stored };
}

/** Remove one question's record (the "answer differently" path). New state. */
export function deleteClientAnswer(
  state: ClientAnswerState,
  questionId: string,
): ClientAnswerState {
  if (!Object.hasOwn(state, questionId)) {
    return state;
  }
  const next = { ...state };
  delete next[questionId];
  return next;
}

/** The purge primitive (HACK-80): an empty store, everything gone. */
export function clearClientAnswers(): ClientAnswerState {
  return EMPTY_CLIENT_ANSWERS;
}

/** Whether the store holds any record at all (the purge's completeness check). */
export function hasAnyAnswer(state: ClientAnswerState): boolean {
  return Object.values(state).some((record) => record !== undefined);
}

/**
 * The AnswerMap the flow engine consumes: the store's records, value
 * included for pii and non-pii alike (this runs on the device; nothing
 * crosses a serialization boundary here — the server-side boundary in
 * serialize.ts is a different, network-facing concern).
 */
export function toAnswerMap(state: ClientAnswerState): AnswerMap {
  const map: Record<string, StoredAnswer> = {};
  for (const [questionId, record] of Object.entries(state)) {
    if (record) {
      map[questionId] = { status: record.status, value: record.value ?? null };
    }
  }
  return map;
}

/**
 * The on-device vault view: the values of pii:true questions only, keyed
 * by question id. This is the fill's source after HACK-95 — a view over
 * the one store, never a second store. Unknown records contribute
 * nothing (they hold no value by invariant).
 */
export function vaultValues(
  state: ClientAnswerState,
  questions: readonly Question[],
): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const question of questions) {
    if (!question.pii) {
      continue;
    }
    const record = state[question.id];
    if (record && record.status !== "unknown" && record.value !== null && record.value !== undefined) {
      values[question.id] = record.value;
    }
  }
  return values;
}

/**
 * Parse stored answers defensively. Malformed input degrades to the
 * empty store; individual invalid records are DROPPED (never repaired
 * into plausible-looking data), so the flow simply asks again.
 */
export function parseClientAnswers(raw: string | null): ClientAnswerState {
  if (raw === null || raw.trim() === "") {
    return EMPTY_CLIENT_ANSWERS;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_CLIENT_ANSWERS;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return EMPTY_CLIENT_ANSWERS;
  }
  const records = (parsed as { records?: unknown }).records;
  if (!records || typeof records !== "object" || Array.isArray(records)) {
    return EMPTY_CLIENT_ANSWERS;
  }
  const state: Record<string, ClientAnswerRecord> = {};
  for (const [questionId, rawRecord] of Object.entries(records)) {
    if (!rawRecord || typeof rawRecord !== "object" || Array.isArray(rawRecord)) {
      continue;
    }
    const candidate = rawRecord as Partial<ClientAnswerRecord>;
    const record: ClientAnswerRecord = {
      questionId,
      status: candidate.status as AnswerStatus,
      provenance: candidate.provenance as ClientAnswerProvenance,
      value: candidate.value === undefined ? null : candidate.value,
    };
    if (recordIsValid(record)) {
      state[questionId] = record;
    }
  }
  return state;
}

/** Serialize for storage. Symmetric with `parseClientAnswers`. */
export function serializeClientAnswers(state: ClientAnswerState): string {
  const records: Record<string, ClientAnswerRecord> = {};
  for (const [questionId, record] of Object.entries(state)) {
    if (record) {
      records[questionId] = record;
    }
  }
  return JSON.stringify({ records });
}

interface AnswerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The browser storage, when one exists (absent in server rendering/tests). */
export function browserAnswerStorage(): AnswerStorage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Device-key sealing (PR #52 P1): the stored blob is AES-256-GCM ciphertext
// under a key that exists only on this device. The seal/open core takes the
// key explicitly so it is testable with any WebCrypto implementation; key
// provision is the provider's job. `clientKeyProvider` generates a
// non-extractable AES-GCM key in memory on first use. DURABLE provision
// (persisting that key in IndexedDB so a page reload can reopen the store,
// the renewal tracker's pattern) is follow-up work; until it lands, a
// reload reads as an empty journey rather than ever storing plaintext.
// ---------------------------------------------------------------------------

/** Supplies the device-only encryption key, or null when unavailable. */
export interface ClientKeyProvider {
  getKey(): Promise<CryptoKey | null>;
}

const SEALED_PREFIX = "sealed1.";
const SEAL_IV_BYTES = 12; // GCM standard nonce length

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Seal plaintext for storage: `sealed1.<iv b64>.<ciphertext b64>` (the GCM
 * tag rides at the end of the ciphertext). Pure in (key, crypto): callers
 * inject both so tests can use Node's WebCrypto.
 */
export async function sealForStorage(
  plaintext: string,
  key: CryptoKey,
  subtle: SubtleCrypto,
): Promise<string> {
  const iv = new Uint8Array(SEAL_IV_BYTES);
  crypto.getRandomValues(iv);
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${SEALED_PREFIX}${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

/**
 * Open a sealed blob. Returns null for anything that is not a well-formed
 * envelope decrypting under this key — a legacy plaintext blob, a foreign
 * key's ciphertext, or tampering all fail closed to null, never to the
 * stored text.
 */
export async function openSealed(
  stored: string,
  key: CryptoKey,
  subtle: SubtleCrypto,
): Promise<string | null> {
  if (!stored.startsWith(SEALED_PREFIX)) {
    return null;
  }
  const parts = stored.slice(SEALED_PREFIX.length).split(".");
  if (parts.length !== 2) {
    return null;
  }
  const iv = base64ToBytes(parts[0]);
  const cipher = base64ToBytes(parts[1]);
  if (!iv || !cipher || iv.length !== SEAL_IV_BYTES) {
    return null;
  }
  try {
    const plain = await subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      cipher as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

let memoryKey: Promise<CryptoKey | null> | null = null;

/**
 * The default key provider: one non-extractable AES-GCM key generated in
 * memory per page session. The key never leaves the device and cannot be
 * exported; see the durable-provision follow-up in the section comment.
 */
export const clientKeyProvider: ClientKeyProvider = {
  getKey(): Promise<CryptoKey | null> {
    memoryKey ??= (async () => {
      try {
        return await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
      } catch {
        return null;
      }
    })();
    return memoryKey;
  },
};

/**
 * Load the stored answers; no storage, no key, or an undecryptable blob
 * all mean an empty journey — never a plaintext read.
 */
export async function loadClientAnswers(
  storage: AnswerStorage | null = browserAnswerStorage(),
  keys: ClientKeyProvider = clientKeyProvider,
): Promise<ClientAnswerState> {
  if (!storage) {
    return EMPTY_CLIENT_ANSWERS;
  }
  try {
    const stored = storage.getItem(CLIENT_ANSWERS_KEY);
    if (stored === null) {
      return EMPTY_CLIENT_ANSWERS;
    }
    const key = await keys.getKey();
    if (!key) {
      return EMPTY_CLIENT_ANSWERS;
    }
    const plaintext = await openSealed(stored, key, crypto.subtle);
    return plaintext === null
      ? EMPTY_CLIENT_ANSWERS
      : parseClientAnswers(plaintext);
  } catch {
    return EMPTY_CLIENT_ANSWERS;
  }
}

/**
 * Persist the answers, sealed under the device key. Returns false when
 * persistence did not happen (no storage, no key, storage refused): the
 * answers then last only for this page view, and the caller must say so
 * rather than silently promising a resume it cannot keep (PR #52 P2).
 */
export async function saveClientAnswers(
  state: ClientAnswerState,
  storage: AnswerStorage | null = browserAnswerStorage(),
  keys: ClientKeyProvider = clientKeyProvider,
): Promise<boolean> {
  if (!storage) {
    return false;
  }
  try {
    const key = await keys.getKey();
    if (!key) {
      return false;
    }
    const sealed = await sealForStorage(
      serializeClientAnswers(state),
      key,
      crypto.subtle,
    );
    storage.setItem(CLIENT_ANSWERS_KEY, sealed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the stored answers entirely (the purge's storage half). Returns
 * true only when the slot verifiably reads back empty — a purge
 * confirmation must never report success while data remains (PR #52 P2).
 * With no storage at all there is nothing stored, so the purge holds.
 */
export function removeStoredAnswers(
  storage: AnswerStorage | null = browserAnswerStorage(),
): boolean {
  if (!storage) {
    return true;
  }
  try {
    storage.removeItem(CLIENT_ANSWERS_KEY);
    return storage.getItem(CLIENT_ANSWERS_KEY) === null;
  } catch {
    return false;
  }
}
