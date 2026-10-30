import { isAnswerStatus, type AnswerStatus } from "../honesty";
import type { AnswerMap, StoredAnswer } from "./flow";
import { QUESTION_BY_ID, type Question } from "./spec";

// Client-side answer store (HACK-94, under HACK-82): where form answers
// live. The product rule (AGENTS.md § Legal): answers live on the user's
// device and leave it only via the consented fax at the end. This module
// is that store — localStorage-backed, same-browser by construction.
//
// How the pieces fit:
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
// - Defensive storage: malformed blobs degrade to an empty store
//   (fail-safe: the person is asked again, never shown invented data),
//   and a value that drops out of the spec is ignored rather than fatal.

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

/** Load the stored answers; no storage means an empty journey. */
export function loadClientAnswers(
  storage: AnswerStorage | null = browserAnswerStorage(),
): ClientAnswerState {
  if (!storage) {
    return EMPTY_CLIENT_ANSWERS;
  }
  try {
    return parseClientAnswers(storage.getItem(CLIENT_ANSWERS_KEY));
  } catch {
    return EMPTY_CLIENT_ANSWERS;
  }
}

/** Persist the answers (no-op without storage). */
export function saveClientAnswers(
  state: ClientAnswerState,
  storage: AnswerStorage | null = browserAnswerStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(CLIENT_ANSWERS_KEY, serializeClientAnswers(state));
  } catch {
    // Storage can refuse (private mode, quota). Answers then last only
    // for this page view — the flow must say so rather than silently
    // promising a resume it cannot keep.
  }
}

/** Remove the stored answers entirely (the purge's storage half). */
export function removeStoredAnswers(
  storage: AnswerStorage | null = browserAnswerStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(CLIENT_ANSWERS_KEY);
  } catch {
    // Nothing sensible to do beyond the caller's on-screen confirmation
    // re-checking hasAnyAnswer on the in-memory state.
  }
}
