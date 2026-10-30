import {
  isAnswerStatus,
  isAppSettableSessionStatus,
  isSessionStatus,
  isUserReportedSessionStatus,
  type AnswerStatus,
  type AppSettableSessionStatus,
  type SessionStatus,
  type UserReportedSessionStatus,
} from "../honesty";
import { AppError, logInfo, userMessageFor } from "../telemetry";
import { getDb } from "../db";
import { vaultDelete, vaultFlowValues, vaultPut } from "../vault";
import type { AnswerMap, StoredAnswer } from "./flow";
import { PII_QUESTION_IDS_IN_SPEC, QUESTION_BY_ID, type Question } from "./spec";

// Intake session + answer store (BN-09 / HACK-37). Persists tri-state
// answers with a provenance (default user_supplied) and routes pii:true
// values through the vault boundary:
//
// - Every answer writes a row in the `answer` table carrying its tri-state
//   status + provenance. For pii:true questions that row's `value` stays
//   NULL — the value itself goes ONLY to the vault via vaultPut (the vault
//   module's validated write API). The `answer` table thus never holds a
//   pii value, while still providing the statuses the honest badge renders.
// - Unknown answers store no value anywhere.
// - The flow position is NOT stored here: it is recomputed from stored
//   answers by the flow engine (first unanswered visible question).
// - Provenance defaults to user_supplied (the wizard path). The conversational
//   intake passes ai_drafted for a genuine AI inference it saves with status
//   unverified (VAL-CONV-003); no caller may set a provenance outside the
//   answer table's CHECK constraint.

export const SESSION_COOKIE = "bn_session";
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TEXT_LENGTH = 2000;

/** Where an answer's value came from — mirrors the answer table CHECK. */
export const ANSWER_PROVENANCES = [
  "user_supplied",
  "ai_drafted",
  "source_verified",
] as const;

export type AnswerProvenance = (typeof ANSWER_PROVENANCES)[number];

export function isAnswerProvenance(value: unknown): value is AnswerProvenance {
  return (
    typeof value === "string" &&
    (ANSWER_PROVENANCES as readonly string[]).includes(value)
  );
}

export function sessionCookieHeader(sessionId: string, secure = false): string {
  return (
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${SESSION_COOKIE_MAX_AGE}` +
    (secure ? "; Secure" : "")
  );
}

/**
 * True when the request arrived over https — either directly (the request
 * URL) or behind a TLS-terminating proxy (x-forwarded-proto's first hop,
 * which is the hop the browser actually used). Deliberately false for plain
 * http so localhost dev keeps working: a Secure cookie would never be
 * stored by the browser over http at all.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    .trim()
    .toLowerCase();
  if (forwarded === "https") {
    return true;
  }
  if (forwarded === "http") {
    return false;
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      return rest.join("=") || null;
    }
  }
  return null;
}

/**
 * Resolve an existing session from a cookie value WITHOUT writing anything
 * (read-only GET path). Returns null for absent/junk/unknown values — never
 * creates a session.
 */
export async function loadSession(
  cookieValue: string | null,
): Promise<string | null> {
  if (!cookieValue || !UUID_PATTERN.test(cookieValue)) {
    return null;
  }
  const sql = getDb();
  const rows = await sql`SELECT id FROM session WHERE id = ${cookieValue}`;
  return rows.length > 0 ? String(rows[0].id) : null;
}

/**
 * Resume the session named by the cookie, or create a fresh person+session.
 * Fails open: a missing, junk, or unknown cookie value yields a new session
 * instead of an error. Used by the answer POST — the first answer is what
 * creates a visitor's session, keeping GET read-only.
 */
export async function ensureSession(
  cookieValue: string | null,
): Promise<{ sessionId: string; fresh: boolean }> {
  const sql = getDb();
  if (cookieValue && UUID_PATTERN.test(cookieValue)) {
    const rows = await sql`SELECT id FROM session WHERE id = ${cookieValue}`;
    if (rows.length > 0) {
      return { sessionId: String(rows[0].id), fresh: false };
    }
  }
  const [person] = await sql`INSERT INTO person DEFAULT VALUES RETURNING id`;
  const [session] =
    await sql`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`;
  return { sessionId: String(session.id), fresh: true };
}

/** One caseworker audit note as the session API returns it (BN-10). */
export interface SessionAuditNoteView {
  readonly actorRole: string;
  readonly note: string;
  readonly createdAt: string;
}

/** The session's lifecycle summary: BN-25 status, assist flag, audit notes. */
export interface SessionStateView {
  readonly status: SessionStatus;
  readonly caseworkerAssisted: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly auditNotes: readonly SessionAuditNoteView[];
}

/**
 * Load a session's lifecycle summary — status, caseworker-assisted flag,
 * and the full audit-note history, oldest first. Returns null for an
 * unknown session id. Read-only; used by the /api/session resume path so
 * audit notes recorded at create/assist time survive resume intact.
 */
export async function loadSessionState(
  sessionId: string,
): Promise<SessionStateView | null> {
  const sql = getDb();
  const sessions = await sql`
    SELECT status, caseworker_assisted, created_at, updated_at
    FROM session
    WHERE id = ${sessionId}
  `;
  if (sessions.length === 0) {
    return null;
  }
  const stored = sessions[0];
  const notes = await sql`
    SELECT actor_role, note, created_at
    FROM session_audit_note
    WHERE session_id = ${sessionId}
    ORDER BY created_at ASC, id ASC
  `;
  return {
    status: isSessionStatus(stored.status) ? stored.status : "draft",
    caseworkerAssisted: stored.caseworker_assisted === true,
    createdAt: new Date(stored.created_at).toISOString(),
    updatedAt: new Date(stored.updated_at).toISOString(),
    auditNotes: notes.map((note) => ({
      actorRole: String(note.actor_role),
      note: String(note.note),
      createdAt: new Date(note.created_at).toISOString(),
    })),
  };
}

/**
 * Validate an assist note and return it trimmed — WITHOUT touching the
 * database, so callers (the /api/session route) can reject bad notes before
 * creating a session. The bound matches every other free-text field
 * (MAX_TEXT_LENGTH).
 */
export function validateAssistNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed === "" || trimmed.length > MAX_TEXT_LENGTH) {
    throw validationError();
  }
  return trimmed;
}

/**
 * Record that a caseworker assisted this session: appends the audit note
 * (who/what/when, BN-10) and flips the session's caseworker-assisted flag.
 * The note text is required and bounded (validateAssistNote); its contents
 * are never logged.
 *
 * The actor is always recorded as SELF-REPORTED: this app has no
 * authentication, so anyone could claim assistance happened, and the audit
 * trail must not present an unverified claim as a verified caseworker's
 * record (the same honesty spine as the tri-state answers). A future
 * mission that adds caseworker identity can upgrade the attribution.
 */
export async function recordCaseworkerAssist(
  sessionId: string,
  note: string,
): Promise<void> {
  const trimmed = validateAssistNote(note);
  const sql = getDb();
  await sql`
    INSERT INTO session_audit_note (session_id, actor_role, note)
    VALUES (${sessionId}, 'self_reported_caseworker', ${trimmed})
  `;
  await sql`
    UPDATE session
    SET caseworker_assisted = true, updated_at = now()
    WHERE id = ${sessionId}
  `;
  // No note content or session id in the log — assist notes are free-form
  // caseworker text and could carry identifying content.
  logInfo("session_audit_note_recorded", { actorRole: "self_reported_caseworker" });
}

/**
 * The forward lifecycle order (BN-25), enforced SERVER-side: a status may
 * only be set from its immediate predecessor. `draft` is the initial state
 * (null predecessor: it can never be set or re-entered); the
 * user_reported_* states come only after handed_off, on the person's
 * explicit report.
 */
const ALLOWED_STATUS_TRANSITIONS: Readonly<
  Record<AppSettableSessionStatus, AppSettableSessionStatus | null>
> = {
  draft: null,
  prepared: "draft",
  handed_off: "prepared",
};

const ALLOWED_REPORT_TRANSITIONS: Readonly<
  Record<UserReportedSessionStatus, SessionStatus>
> = {
  user_reported_submitted: "handed_off",
  user_reported_decided: "handed_off",
};

/**
 * Advance a session through the app-settable BN-25 states (draft → prepared
 * → handed_off) in lifecycle order only. The type keeps every
 * user_reported_* value out of bounds — no code path can set a
 * submitted-like state (BN-25: prepared ≠ submitted); those ride
 * reportUserReportedStatus below, on the person's explicit report only.
 * Out-of-order requests (skipping a state, moving backwards) fail with a
 * taxonomy error. Unknown sessions fail with not_found.
 */
export async function setSessionStatus(
  sessionId: string,
  status: AppSettableSessionStatus,
): Promise<SessionStateView> {
  if (!isAppSettableSessionStatus(status)) {
    throw validationError();
  }
  const requiredBefore = ALLOWED_STATUS_TRANSITIONS[status];
  const sql = getDb();
  const current = await sql`SELECT status FROM session WHERE id = ${sessionId}`;
  if (current.length === 0) {
    throw new AppError("not_found", userMessageFor("not_found"));
  }
  const currentStatus = isSessionStatus(current[0].status)
    ? current[0].status
    : "draft";
  if (currentStatus !== requiredBefore) {
    throw validationError();
  }
  await sql`
    UPDATE session
    SET status = ${status}, updated_at = now()
    WHERE id = ${sessionId}
  `;
  logInfo("session_status_advanced");
  const state = await loadSessionState(sessionId);
  if (!state) {
    throw new AppError("not_found", userMessageFor("not_found"));
  }
  return state;
}

/**
 * Record what the person told us happened OUTSIDE the app, after handoff
 * (submitted / decided). Only the user_reported_* values are accepted here,
 * and only from a handed-off session — the app's own transitions go through
 * setSessionStatus and can never reach these states. The report is the
 * person's word, not a verified fact; the status vocabulary keeps that
 * distinction type-level, and the lifecycle order keeps it flow-level.
 */
export async function reportUserReportedStatus(
  sessionId: string,
  status: UserReportedSessionStatus,
): Promise<SessionStateView> {
  if (!isUserReportedSessionStatus(status)) {
    throw validationError();
  }
  const requiredBefore = ALLOWED_REPORT_TRANSITIONS[status];
  const sql = getDb();
  const current = await sql`SELECT status FROM session WHERE id = ${sessionId}`;
  if (current.length === 0) {
    throw new AppError("not_found", userMessageFor("not_found"));
  }
  const currentStatus = isSessionStatus(current[0].status)
    ? current[0].status
    : "draft";
  if (currentStatus !== requiredBefore) {
    throw validationError();
  }
  await sql`
    UPDATE session
    SET status = ${status}, updated_at = now()
    WHERE id = ${sessionId}
  `;
  logInfo("session_status_user_reported");
  const state = await loadSessionState(sessionId);
  if (!state) {
    throw new AppError("not_found", userMessageFor("not_found"));
  }
  return state;
}


/**
 * One stored answer row: tri-state status, the jsonb value (NULL for
 * pii:true questions — their values live in the vault), and the provenance.
 */
export interface AnswerRecord {
  readonly status: AnswerStatus;
  readonly value: unknown;
  readonly provenance: AnswerProvenance;
}

/**
 * Read the raw answer rows for a session — statuses, values (NULL for pii
 * questions), and provenance — WITHOUT any vault merge. The forms pipeline
// (Mission v2 M4) consumes this for non-pii fill values and for the
 * provenance labels; the vault-side reads stay in the vault module with the
 * per-form allowlist.
 */
export async function loadAnswerRecords(
  sessionId: string,
): Promise<Readonly<Record<string, AnswerRecord>>> {
  const sql = getDb();
  const rows = await sql`
    SELECT question_id, value, status, provenance
    FROM answer
    WHERE session_id = ${sessionId}
  `;
  const records: Record<string, AnswerRecord> = {};
  for (const row of rows) {
    if (!isAnswerStatus(row.status) || !isAnswerProvenance(row.provenance)) {
      continue;
    }
    records[String(row.question_id)] = {
      status: row.status,
      value: row.value ?? null,
      provenance: row.provenance,
    };
  }
  return records;
}

/**
 * Load every stored answer for a session as the flow engine's answer map.
 * pii:true values come back from the vault read path (server-side only —
 * the serialization boundary strips them from anything client-visible);
 * the answer table keeps their value NULL.
 */
export async function loadAnswers(sessionId: string): Promise<AnswerMap> {
  const records = await loadAnswerRecords(sessionId);
  const answers: Record<string, StoredAnswer> = {};
  for (const [questionId, record] of Object.entries(records)) {
    answers[questionId] = { status: record.status, value: record.value };
  }

  // Merge vault-stored pii values so the flow engine can evaluate skip
  // conditions on pii answers (fail-open still applies: unknown answers
  // have no vault value). Never logged, never serialized to the client.
  const vaultValues = await vaultFlowValues(sessionId, PII_QUESTION_IDS_IN_SPEC);
  for (const [field, raw] of Object.entries(vaultValues)) {
    const stored = answers[field];
    const question = QUESTION_BY_ID[field];
    if (!stored || !question || stored.status === "unknown") {
      continue;
    }
    answers[field] = { status: stored.status, value: vaultValueToAnswer(question, raw) };
  }
  return answers;
}

/** Decode a vault value back to the answer shape for its question type. */
function vaultValueToAnswer(question: Question, raw: string): unknown {
  if (question.type === "multi_select") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : raw;
    } catch {
      return raw;
    }
  }
  return raw;
}

function validationError(): AppError {
  return new AppError("validation_error", userMessageFor("validation_error"));
}

/** Validate and canonicalize a submitted value against the question spec. */
function canonicalValue(
  question: Question,
  value: unknown,
): string | number | boolean | string[] {
  switch (question.type) {
    case "text":
    case "address": {
      if (typeof value !== "string") {
        throw validationError();
      }
      const trimmed = value.trim();
      if (trimmed === "" || trimmed.length > MAX_TEXT_LENGTH) {
        throw validationError();
      }
      return trimmed;
    }
    case "number": {
      let numeric = value;
      if (typeof numeric === "string" && numeric.trim() !== "") {
        numeric = Number(numeric);
      }
      if (typeof numeric !== "number" || !Number.isFinite(numeric)) {
        throw validationError();
      }
      return numeric;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        throw validationError();
      }
      return value;
    }
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw validationError();
      }
      return value;
    }
    case "single_select": {
      if (
        typeof value !== "string" ||
        !question.options?.some((option) => option.value === value)
      ) {
        throw validationError();
      }
      return value;
    }
    case "multi_select": {
      if (!Array.isArray(value) || value.length === 0) {
        throw validationError();
      }
      const values = [...new Set(value.map((item) => String(item)))];
      for (const item of values) {
        if (!question.options?.some((option) => option.value === item)) {
          throw validationError();
        }
      }
      return values;
    }
  }
}

/** Vault values are text: strings stay as-is, everything else JSON-encoded. */
function vaultValueFor(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The validated shape an answer submission must produce. */
interface ValidatedAnswer {
  readonly question: Question;
  /** Canonical storage value; null for unknown answers (no value anywhere). */
  readonly storedValue: string | number | boolean | string[] | null;
}

/**
 * Validate an answer submission against the question spec and return the
 * spec question it targets plus its canonical storage value — WITHOUT
 * touching the database. Used by saveAnswer and by the answer route, which
 * must reject bad input BEFORE creating a session (a rejected first answer
 * must never leave an orphan person/session row behind).
 *
 * The question lookup guards with Object.hasOwn: QUESTION_BY_ID is a plain
 * object, so an unguarded index would resolve inherited Object.prototype
 * keys like "constructor" (truthy!) instead of failing validation — a 500
 * or a junk row instead of the contracted 400.
 */
export function validateAnswerInput(
  questionId: string,
  status: AnswerStatus,
  value: unknown,
): ValidatedAnswer {
  if (!Object.hasOwn(QUESTION_BY_ID, questionId)) {
    throw validationError();
  }
  const question = QUESTION_BY_ID[questionId];
  if (!isAnswerStatus(status)) {
    throw validationError();
  }
  return {
    question,
    storedValue:
      status === "unknown" ? null : canonicalValue(question, value),
  };
}

/**
 * Validate and persist one answer. known/unverified answers carry a
 * spec-valid value; unknown answers carry none. Re-answering the same
 * question updates the row (never duplicates). Provenance defaults to
 * user_supplied; the conversation passes ai_drafted only for a genuine AI
 * inference saved with status unverified.
 */
export async function saveAnswer(
  sessionId: string,
  questionId: string,
  status: AnswerStatus,
  value: unknown,
  provenance: AnswerProvenance = "user_supplied",
): Promise<void> {
  const { question, storedValue } = validateAnswerInput(
    questionId,
    status,
    value,
  );
  if (!isAnswerProvenance(provenance)) {
    throw validationError();
  }
  // A drafted answer is by definition not user-verified: provenance
  // ai_drafted pairs only with status unverified.
  if (provenance === "ai_drafted" && status !== "unverified") {
    throw validationError();
  }

  const sql = getDb();
  if (question.pii) {
    if (status !== "unknown") {
      await vaultPut(sessionId, question.id, vaultValueFor(storedValue));
    } else {
      // Delete-on-disavow (BN-13): "I'm not sure" over an earlier answer
      // must not leave the stale value in the vault.
      await vaultDelete(sessionId, question.id);
    }
    // The answer row keeps its value NULL for pii questions: status and
    // provenance live here, the value lives only in the vault.
    await sql`
      INSERT INTO answer (session_id, question_id, value, status, provenance)
      VALUES (${sessionId}, ${question.id}, NULL, ${status}, ${provenance})
      ON CONFLICT (session_id, question_id)
      DO UPDATE SET
        value = NULL,
        status = EXCLUDED.status,
        provenance = EXCLUDED.provenance,
        answered_at = now()
    `;
  } else {
    const valueJson = storedValue === null ? null : sql.json(storedValue);
    await sql`
      INSERT INTO answer (session_id, question_id, value, status, provenance)
      VALUES (${sessionId}, ${question.id}, ${valueJson}, ${status}, ${provenance})
      ON CONFLICT (session_id, question_id)
      DO UPDATE SET
        value = EXCLUDED.value,
        status = EXCLUDED.status,
        provenance = EXCLUDED.provenance,
        answered_at = now()
    `;
  }

  // No question id, value, or count — pii field ids are themselves
  // identifying content (VAL-TEL-002).
  logInfo("intake_answer_saved");
}
