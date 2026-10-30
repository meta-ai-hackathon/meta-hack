/**
 * Telemetry and log hygiene (BN-06 / HACK-28).
 *
 * A zero-dependency structured logger: JSON lines to stdout, every line
 * carrying requestId, event, timestamp, and level. Anything logged passes a
 * redactor that strips fields named after `pii: true` question ids from
 * specs/question-spec/generic-questions.json plus known identity keys, so a
 * person's answers can never reach a log line by construction. A closed error
 * taxonomy maps unknown failures to `internal` with no detail leakage.
 *
 * The PII field list mirrors the question spec as a typed constant and is
 * compared against the spec file in the test suite (the honesty.ts pattern),
 * so a spec change without a matching redactor change fails CI.
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// Levels and line shape
// ---------------------------------------------------------------------------

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

/** One emitted line: JSON-serialized by the sink. */
export interface LogLine {
  requestId: string;
  event: string;
  timestamp: string;
  level: LogLevel;
  redactedFieldCount?: number;
  [key: string]: unknown;
}

/** Receives each serialized line. Default writes JSON lines to stdout. */
export type LogSink = (line: string) => void;

let sink: LogSink = (line) => console.log(line);

/** Point the logger at a custom sink (tests use this; default is stdout). */
export function setLogSink(next: LogSink): void {
  sink = next;
}

// ---------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------

/**
 * Every question id marked `pii: true` in generic-questions.json. The test
 * suite asserts this list equals the spec's pii set exactly (VAL-TEL-002);
 * update both together.
 */
export const PII_QUESTION_IDS = [
  "goal_detail",
  "county",
  "housing_status",
  "id_issue_detail",
  "date_of_birth",
  "citizenship_status",
  "disability_status",
  "mailing_situation",
  "shelter_mail_consent",
  "phone_contact",
  "email_contact",
] as const;

/** Identity keys redacted in addition to the spec-derived question ids. */
export const IDENTITY_KEYS = [
  "name",
  "address",
  "ssn",
  "dob",
  "phone",
  "email",
] as const;

/**
 * Common spellings of the identity keys under other names; matched like
 * question ids (exact or affix). Fail-closed: a realistic field name that
 * carries one of these values gets stripped.
 */
const IDENTITY_ALIASES = [
  "social_security_number",
  "birth_date",
  "national_id",
  "government_id",
  "e_mail",
  "telephone",
] as const;

/** Structural keys of the line itself; caller fields can never override them. */
const RESERVED_LINE_KEYS: readonly string[] = [
  "requestId",
  "event",
  "timestamp",
  "level",
  "redactedFieldCount",
];

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // camelCase → snake_case
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * True when a field name matches a pii:true question id, an identity key, or
 * a known identity alias. Matching fails closed: multi-word ids match exactly
 * or as an affix (`answer_date_of_birth`), identity keys match as whole word
 * segments (`email_address`, `phone_number`), and camelCase is split first
 * (`dateOfBirth`, `emailAddress`), case- and separator-insensitively.
 */
export function isPiiFieldName(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized === "") {
    return false;
  }
  const ids: readonly string[] = [...PII_QUESTION_IDS, ...IDENTITY_ALIASES];
  for (const id of ids) {
    if (
      normalized === id ||
      normalized.startsWith(`${id}_`) ||
      normalized.endsWith(`_${id}`) ||
      normalized.includes(`_${id}_`)
    ) {
      return true;
    }
  }
  const segments = normalized.split("_");
  for (const identity of IDENTITY_KEYS) {
    if (segments.includes(identity)) {
      return true;
    }
  }
  return false;
}

function redactValue(
  value: unknown,
  ancestors: Set<object>,
  count: { redacted: number },
): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) {
    // Genuine cycles would otherwise break JSON.stringify downstream.
    return "[cyclic]";
  }
  ancestors.add(value);
  try {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime())
        ? "[invalid_date]"
        : value.toISOString();
    }
    // Walk the payload of hosted collections instead of letting
    // Object.entries flatten them to "{}" (which would both lose data and
    // skip redaction inside them).
    if (value instanceof Map) {
      return redactValue(Object.fromEntries(value), ancestors, count);
    }
    if (value instanceof Set) {
      return redactValue(Array.from(value), ancestors, count);
    }
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, ancestors, count));
    }
    const cleaned: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as LogFields)) {
      if (isPiiFieldName(key)) {
        count.redacted += 1;
        continue;
      }
      cleaned[key] = redactValue(child, ancestors, count);
    }
    return cleaned;
  } finally {
    // Ancestor-stack semantics: a shared (non-cyclic) reference appearing
    // under two keys is walked twice, not mislabeled as a cycle.
    ancestors.delete(value);
  }
}

/**
 * Deep-strips every field whose name matches a pii:true question id, an
 * identity key, or a known alias, recursively through nested objects,
 * arrays, Maps, and Sets. Values are never logged — the field is removed
 * entirely.
 */
export function redactFields<T>(value: T): T {
  return redactValue(value, new Set<object>(), { redacted: 0 }) as T;
}

// ---------------------------------------------------------------------------
// Request ids
// ---------------------------------------------------------------------------

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/** A fresh request id (UUID v4; no dependencies). */
export function createRequestId(): string {
  return randomUUID();
}

/** The id of the enclosing request, if any. */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/** Run a request's work under an explicit id; all log lines carry it. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

/** Run a request's work under a freshly generated id. */
export function withFreshRequestId<T>(fn: () => T): T {
  return runWithRequestId(createRequestId(), fn);
}

/**
 * Accept a valid incoming `x-request-id` (so traces can span services) or
 * create a fresh one. Junk values — empty, overlong, or anything that could
 * forge log syntax — are replaced, never echoed.
 */
export function requestIdFromHeaders(headers: Headers): string {
  const incoming = headers.get("x-request-id")?.trim() ?? "";
  if (/^[A-Za-z0-9_-]{1,128}$/.test(incoming)) {
    return incoming;
  }
  return createRequestId();
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

function emit(
  level: LogLevel,
  event: string,
  fields?: LogFields,
): void {
  const requestId = currentRequestId() ?? createRequestId();
  const ancestors = new Set<object>();
  const count = { redacted: 0 };
  const cleaned: LogFields = {};
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (RESERVED_LINE_KEYS.includes(key)) {
        continue;
      }
      if (isPiiFieldName(key)) {
        count.redacted += 1;
        continue;
      }
      cleaned[key] = redactValue(value, ancestors, count);
    }
  }
  const line: LogLine = {
    requestId,
    event,
    timestamp: new Date().toISOString(),
    level,
    ...cleaned,
  };
  if (count.redacted > 0) {
    line.redactedFieldCount = count.redacted;
  }
  sink(JSON.stringify(line));
}

/** Log one structured event at an explicit level. */
export function log(level: LogLevel, event: string, fields?: LogFields): void {
  emit(level, event, fields);
}

export function logDebug(event: string, fields?: LogFields): void {
  emit("debug", event, fields);
}

export function logInfo(event: string, fields?: LogFields): void {
  emit("info", event, fields);
}

export function logWarn(event: string, fields?: LogFields): void {
  emit("warn", event, fields);
}

export function logError(event: string, fields?: LogFields): void {
  emit("error", event, fields);
}

// ---------------------------------------------------------------------------
// Closed error taxonomy
// ---------------------------------------------------------------------------

/**
 * The closed set of error codes the app may surface or log. Nothing outside
 * this list is ever emitted; unknown errors map to `internal` with no detail
 * leakage (BN-06). `model_unavailable` is in the taxonomy from day one so the
 * demo survives the model rail being down (BN-40).
 */
export const ERROR_TAXONOMY = [
  "validation_error",
  "not_found",
  "db_error",
  "model_unavailable",
  "rate_limited",
  "consent_required",
  "internal",
] as const;

export type ErrorCode = (typeof ERROR_TAXONOMY)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
  return (
    typeof value === "string" &&
    (ERROR_TAXONOMY as readonly string[]).includes(value)
  );
}

/**
 * Map any thrown value to a taxonomy code. AppError instances keep their
 * code; a bare taxonomy string is itself; everything else — including Error
 * instances whose messages could carry internals — maps to `internal`.
 */
export function toErrorCode(value: unknown): ErrorCode {
  if (value instanceof AppError) {
    return value.code;
  }
  if (isErrorCode(value)) {
    return value;
  }
  return "internal";
}

/**
 * An error raised deliberately by app code: a taxonomy code plus a
 * safe, plain-language, non-promissory message. Anything internal goes in
 * `cause` for in-process debugging and is never serialized to logs.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly safeMessage: string;

  constructor(code: ErrorCode, safeMessage: string, options?: ErrorOptions) {
    super(safeMessage, options);
    this.name = "AppError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

/**
 * Plain-language, pilot-agnostic user-facing copy for each code. No promise
 * language (the banned-claims contract applies); the model_unavailable copy
 * tells the user they can keep going, so the demo survives the rail.
 */
const ERROR_USER_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  validation_error: "We couldn't use that answer. Please check it and try again.",
  not_found: "We couldn't find that page or session.",
  db_error: "We're having trouble saving right now. Please try again in a moment.",
  model_unavailable:
    "Our assistant is unavailable right now. You can keep filling in your answers.",
  rate_limited: "That was a lot of activity at once. Please wait a moment and try again.",
  consent_required:
    "Nothing was sent to any AI provider because sharing isn't turned on. Turn on sharing below to use the assistant, or keep going in the step-by-step form.",
  internal: "Something went wrong on our side. Please try again.",
};

/** The safe user-facing message for a taxonomy code. */
export function userMessageFor(code: ErrorCode): string {
  return ERROR_USER_MESSAGES[code];
}

/**
 * Log any thrown value safely: the taxonomy code always, the safe message
 * only when it is the code's canonical copy from ERROR_USER_MESSAGES (a
 * custom message could have user content concatenated into it), and nothing
 * else — no message, stack, or cause from unknown errors can reach the
 * serialized line.
 */
export function reportError(
  error: unknown,
  options?: { event?: string; fields?: LogFields },
): void {
  const code = toErrorCode(error);
  const fields: LogFields = { ...options?.fields, error_code: code };
  if (error instanceof AppError && error.safeMessage === userMessageFor(code)) {
    fields.error_message = error.safeMessage;
  }
  emit("error", options?.event ?? "error", fields);
}
