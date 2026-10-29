import { isAnswerStatus, type AnswerStatus } from "../honesty";
import { AppError, logInfo, userMessageFor } from "../telemetry";
import { getDb } from "../db";
import { vaultFlowValues, vaultPut } from "../vault";
import type { AnswerMap, StoredAnswer } from "./flow";
import { PII_QUESTION_IDS_IN_SPEC, QUESTION_BY_ID, type Question } from "./spec";

// Intake session + answer store (BN-09 / HACK-37). Persists tri-state
// answers with provenance=user_supplied and routes pii:true values through
// the vault boundary:
//
// - Every answer writes a row in the `answer` table carrying its tri-state
//   status + provenance. For pii:true questions that row's `value` stays
//   NULL — the value itself goes ONLY to the vault via vaultPut (the vault
//   module's validated write API). The `answer` table thus never holds a
//   pii value, while still providing the statuses the honest badge renders.
// - Unknown answers store no value anywhere.
// - The flow position is NOT stored here: it is recomputed from stored
//   answers by the flow engine (first unanswered visible question).

export const SESSION_COOKIE = "bn_session";
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TEXT_LENGTH = 2000;

export function sessionCookieHeader(sessionId: string): string {
  return (
    `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`
  );
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

/**
 * Load every stored answer for a session as the flow engine's answer map.
 * pii:true values come back from the vault read path (server-side only —
 * the serialization boundary strips them from anything client-visible);
 * the answer table keeps their value NULL.
 */
export async function loadAnswers(sessionId: string): Promise<AnswerMap> {
  const sql = getDb();
  const rows = await sql`
    SELECT question_id, value, status
    FROM answer
    WHERE session_id = ${sessionId}
  `;
  const answers: Record<string, StoredAnswer> = {};
  for (const row of rows) {
    if (!isAnswerStatus(row.status)) {
      continue;
    }
    answers[String(row.question_id)] = {
      status: row.status,
      value: row.value ?? null,
    };
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

/**
 * Validate and persist one answer. known/unverified answers carry a
 * spec-valid value; unknown answers carry none. Re-answering the same
 * question updates the row (never duplicates).
 */
export async function saveAnswer(
  sessionId: string,
  questionId: string,
  status: AnswerStatus,
  value: unknown,
): Promise<void> {
  const question = QUESTION_BY_ID[questionId];
  if (!question) {
    throw validationError();
  }
  if (!isAnswerStatus(status)) {
    throw validationError();
  }

  let storedValue: string | number | boolean | string[] | null = null;
  if (status !== "unknown") {
    // Throws a taxonomy validation_error for anything the spec disallows.
    storedValue = canonicalValue(question, value);
  }

  const sql = getDb();
  if (question.pii) {
    if (status !== "unknown") {
      await vaultPut(sessionId, question.id, vaultValueFor(storedValue));
    }
    // The answer row keeps its value NULL for pii questions: status and
    // provenance live here, the value lives only in the vault.
    await sql`
      INSERT INTO answer (session_id, question_id, value, status, provenance)
      VALUES (${sessionId}, ${question.id}, NULL, ${status}, 'user_supplied')
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
      VALUES (${sessionId}, ${question.id}, ${valueJson}, ${status}, 'user_supplied')
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
