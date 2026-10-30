import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_TAXONOMY,
  IDENTITY_KEYS,
  LOG_LEVELS,
  PII_QUESTION_IDS,
  type LogLine,
  AppError,
  createRequestId,
  currentRequestId,
  isErrorCode,
  isPiiFieldName,
  log,
  logInfo,
  logWarn,
  redactFields,
  requestIdFromHeaders,
  reportError,
  setLogSink,
  toErrorCode,
  userMessageFor,
  withFreshRequestId,
  runWithRequestId,
} from "./telemetry";
import { assertNoBannedClaims } from "./honesty";

// Parsed from the repo's spec at test time — the redactor's field list must
// cover every pii:true question (VAL-TEL-002 is a full-population test, not a
// sample).
const SPEC_PATH = fileURLToPath(
  new URL("../../specs/question-spec/generic-questions.json", import.meta.url),
);

interface SpecQuestion {
  id: string;
  pii: boolean;
}

function specPiiIds(): string[] {
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
    questions: SpecQuestion[];
  };
  return spec.questions.filter((q) => q.pii).map((q) => q.id);
}

/** Replace the module sink with an in-memory collector. */
function captureLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  return { lines, restore: () => setLogSink((line) => console.log(line)) };
}

function parseLines(lines: string[]): LogLine[] {
  return lines.map((line) => JSON.parse(line) as LogLine);
}

let restoreSink: () => void = () => {};

afterEach(() => {
  restoreSink();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// VAL-TEL-001: structured lines with required fields
// ---------------------------------------------------------------------------

describe("structured logger lines (VAL-TEL-001)", () => {
  it("emits every line as valid JSON with requestId, event, timestamp, level", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    log("debug", "test.no_fields");
    logInfo("test.with_fields", { sessionId: "sess_123", attemptCount: 2 });
    logWarn("test.warn_fields", { retryCount: 1 });
    log("error", "test.error_fields", { sessionId: "sess_456" });

    const parsed = parseLines(captured.lines);
    expect(parsed).toHaveLength(4);
    for (const line of parsed) {
      expect(typeof line.requestId).toBe("string");
      expect(line.requestId.length).toBeGreaterThan(0);
      expect(typeof line.event).toBe("string");
      expect(line.event.length).toBeGreaterThan(0);
      expect(typeof line.timestamp).toBe("string");
      expect(LOG_LEVELS as readonly string[]).toContain(line.level);
    }
    expect(parsed.map((l) => l.level)).toEqual(["debug", "info", "warn", "error"]);
    expect(parsed[1].sessionId).toBe("sess_123");
    expect(parsed[1].attemptCount).toBe(2);
  });

  it("timestamps are ISO-8601 UTC and near now", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    logInfo("test.timestamp_shape");

    const parsed = parseLines(captured.lines)[0];
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    const at = new Date(parsed.timestamp).getTime();
    expect(Number.isNaN(at)).toBe(false);
    expect(Math.abs(Date.now() - at)).toBeLessThan(60_000);
  });

  it("default sink writes parseable JSON lines to stdout", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    restoreSink = () => spy.mockRestore();

    logInfo("test.default_sink", { sessionId: "sess_789" });

    expect(spy).toHaveBeenCalledTimes(1);
    const emitted = String(spy.mock.calls[0][0]);
    const parsed = JSON.parse(emitted) as LogLine;
    expect(parsed.event).toBe("test.default_sink");
    expect(parsed.sessionId).toBe("sess_789");
    expect(typeof parsed.requestId).toBe("string");
  });

  it("reports redactedFieldCount only when fields were redacted", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    logInfo("test.clean", { sessionId: "sess_1" });
    logInfo("test.dirty", { phone_contact: "555-0100", sessionId: "sess_2" });

    const parsed = parseLines(captured.lines);
    expect(parsed[0].redactedFieldCount).toBeUndefined();
    expect(parsed[1].redactedFieldCount).toBeGreaterThan(0);
    // Structural keys always win: caller fields can never override them.
    log("info", "test.override", { level: "zombie", event: "nope" });
    const pinned = parseLines(captured.lines)[2];
    expect(pinned.level).toBe("info");
    expect(pinned.event).toBe("test.override");
  });
});

// ---------------------------------------------------------------------------
// Request ids: fresh per request, propagated to all lines in that request
// ---------------------------------------------------------------------------

describe("request ids", () => {
  it("assigns a fresh id per request and propagates it to every line in it", async () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    await withFreshRequestId(async () => {
      logInfo("outer.start");
      await Promise.resolve();
      logInfo("outer.middle");
      await withFreshRequestId(async () => {
        await Promise.resolve();
        logInfo("inner.step");
      });
      logInfo("outer.end");
    });

    const parsed = parseLines(captured.lines);
    const outerIds = new Set(
      parsed
        .filter((l) => l.event.startsWith("outer."))
        .map((l) => l.requestId),
    );
    expect(outerIds.size).toBe(1);
    const inner = parsed.find((l) => l.event === "inner.step");
    expect(inner).toBeDefined();
    expect(inner?.requestId).not.toBe(parsed[0].requestId);
  });

  it("separate requests get different ids", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    withFreshRequestId(() => logInfo("request.first"));
    withFreshRequestId(() => logInfo("request.second"));

    const parsed = parseLines(captured.lines);
    expect(parsed[0].requestId).not.toBe(parsed[1].requestId);
  });

  it("logs outside any request context still carry a valid requestId", () => {
    expect(currentRequestId()).toBeUndefined();
    const captured = captureLines();
    restoreSink = captured.restore;

    logInfo("orphan.line");

    const parsed = parseLines(captured.lines)[0];
    expect(typeof parsed.requestId).toBe("string");
    expect(parsed.requestId.length).toBeGreaterThan(0);
  });

  it("runWithRequestId reuses an explicit id (e.g. from a header)", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    runWithRequestId("req_explicit_1", () => {
      expect(currentRequestId()).toBe("req_explicit_1");
      logInfo("explicit.line");
    });

    const parsed = parseLines(captured.lines)[0];
    expect(parsed.requestId).toBe("req_explicit_1");
  });

  it("createRequestId produces unique ids", () => {
    const ids = new Set(Array.from({ length: 100 }, () => createRequestId()));
    expect(ids.size).toBe(100);
  });

  it("requestIdFromHeaders echoes a valid id and replaces invalid input", () => {
    const headers = new Headers({ "x-request-id": "req_valid_123" });
    expect(requestIdFromHeaders(headers)).toBe("req_valid_123");

    // Log-injection guard: junk values never reach a log line. (Newlines
    // cannot occur here at all — the Headers API rejects them — so the junk
    // is spaced/quoted garbage that a proxy could still forward.)
    const junk = new Headers({ "x-request-id": 'bad id with "quotes"' });
    const fresh = requestIdFromHeaders(junk);
    expect(fresh).not.toContain("\n");
    expect(fresh).not.toContain('"');
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{1,128}$/);

    expect(requestIdFromHeaders(new Headers())).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });
});

// ---------------------------------------------------------------------------
// VAL-TEL-002: full-population PII redaction
// ---------------------------------------------------------------------------

describe("PII redaction (VAL-TEL-002)", () => {
  it("covers exactly the pii:true question ids parsed from the spec", () => {
    const specIds = specPiiIds();
    expect(specIds.length).toBeGreaterThan(0);
    expect([...PII_QUESTION_IDS].sort()).toEqual([...specIds].sort());
  });

  it("the redactor bites on every pii:true question id", () => {
    for (const id of specPiiIds()) {
      expect(isPiiFieldName(id)).toBe(true);
      const cleaned = redactFields<Record<string, unknown>>({ [id]: "seed" });
      expect(Object.keys(cleaned)).not.toContain(id);
    }
  });

  it("full population: values for EVERY pii:true question leak nothing", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    const ids = specPiiIds();
    const camel = (id: string): string =>
      id.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    const unique = (id: string, placement: string): string =>
      `PII-VALUE-${id}-${placement}`;

    // Seed a record that carries every pii:true question's value in several
    // shapes: flat, nested, inside arrays, under prefixed keys, camelCased,
    // and deep.
    const flat: Record<string, string> = {};
    const nested: Record<string, string> = {};
    const prefixed: Record<string, string> = {};
    const camelCased: Record<string, string> = {};
    const deep: Record<string, Record<string, string>> = { answers: {} };
    const inArray: Record<string, string>[] = [];
    for (const id of ids) {
      flat[id] = unique(id, "flat");
      nested[id] = unique(id, "nested");
      prefixed[`answer_${id}`] = unique(id, "prefixed");
      camelCased[camel(id)] = unique(id, "camel");
      deep.answers[id] = unique(id, "deep");
      inArray.push({ [id]: unique(id, "array") });
    }
    const seeded = {
      ...flat,
      answersSection: nested,
      prefixedKeys: prefixed,
      camelKeys: camelCased,
      deepNesting: deep,
      answerList: inArray,
      // Controls: non-PII fields must survive redaction untouched.
      sessionId: "sess_control_1",
      status: "prepared",
      attemptCount: 3,
    };

    logInfo("test.pii_seeded_full_population", seeded);

    const output = captured.lines.join("\n");
    // Every seeded value, in every placement, must be absent.
    for (const id of ids) {
      for (const placement of [
        "flat",
        "nested",
        "prefixed",
        "camel",
        "deep",
        "array",
      ]) {
        expect(output).not.toContain(unique(id, placement));
      }
      // And the question ids themselves must not appear as identifying
      // content in the emitted line.
      expect(output).not.toContain(id);
    }
    // Controls survive — the redactor strips PII, not everything.
    const parsed = parseLines(captured.lines)[0];
    expect(parsed.sessionId).toBe("sess_control_1");
    expect(parsed.status).toBe("prepared");
    expect(parsed.attemptCount).toBe(3);
    // The line is still a fully valid structured line.
    expect(typeof parsed.requestId).toBe("string");
    expect(parsed.event).toBe("test.pii_seeded_full_population");
    expect(LOG_LEVELS as readonly string[]).toContain(parsed.level);
  });

  it("strips the known identity keys and their common variants", () => {
    const seeded: Record<string, unknown> = {
      name: "Jane Q. Applicant",
      address: "12 Main St",
      ssn: "123-45-6789",
      dob: "1980-01-01",
      phone: "555-0100",
      email: "jane@example.com",
      first_name: "Jane",
      last_name: "Applicant",
      email_address: "jane@example.com",
      phone_number: "555-0100",
      street_address: "12 Main St",
      "User.Email": "jane@example.com",
      "phone-number": "555-0100",
    };

    const cleaned = redactFields<Record<string, unknown>>(seeded);
    const output = JSON.stringify(cleaned);
    for (const key of Object.keys(seeded)) {
      expect(Object.keys(cleaned)).not.toContain(key);
    }
    expect(output).not.toContain("Jane");
    expect(output).not.toContain("jane@example.com");
    expect(output).not.toContain("555-0100");
    expect(output).not.toContain("123-45-6789");
    expect(IDENTITY_KEYS).toEqual([
      "name",
      "address",
      "ssn",
      "dob",
      "phone",
      "email",
    ]);
  });

  it("matches camelCase spellings and identity aliases", () => {
    const seeded: Record<string, unknown> = {
      emailAddress: "jane@example.com",
      dateOfBirth: "1980-01-01",
      phoneContact: "555-0100",
      goalDetail: "free text detail",
      social_security_number: "123-45-6789",
      birth_date: "1980-01-01",
      national_id: "ID-123456",
      government_id: "GOV-999",
      e_mail: "jane@example.com",
      telephone: "555-0100",
      answer_social_security_number: "123-45-6789",
    };

    const cleaned = redactFields<Record<string, unknown>>(seeded);
    for (const key of Object.keys(seeded)) {
      expect(Object.keys(cleaned)).not.toContain(key);
    }
    const output = JSON.stringify(cleaned);
    expect(output).not.toContain("jane@example.com");
    expect(output).not.toContain("1980-01-01");
    expect(output).not.toContain("555-0100");
    expect(output).not.toContain("123-45-6789");
  });

  it("walks shared references intact but breaks genuine cycles", () => {
    const shared = { attemptCount: 2 };
    const cleaned = redactFields<Record<string, unknown>>({
      a: shared,
      b: shared,
    });
    // A DAG reference is walked twice, not mislabeled "[cyclic]".
    expect(cleaned).toEqual({
      a: { attemptCount: 2 },
      b: { attemptCount: 2 },
    });
  });

  it("preserves Dates and walks Map/Set payloads", () => {
    const cleaned = redactFields<Record<string, unknown>>({
      startedAt: new Date("2026-01-01T00:00:00Z"),
      piiMap: new Map<string, unknown>([["name", "Jane Q. Applicant"]]),
      okMap: new Map<string, unknown>([["attemptCount", 2]]),
      piiSet: new Set<unknown>([{ email: "jane@example.com" }, 1]),
    });
    expect(cleaned.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(cleaned.piiMap).toEqual({});
    expect(cleaned.okMap).toEqual({ attemptCount: 2 });
    expect(JSON.stringify(cleaned)).not.toContain("jane@example.com");
    expect(JSON.stringify(cleaned)).not.toContain("Jane");
  });

  it("ignores caller-supplied redactedFieldCount", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    logInfo("test.forged_count", { redactedFieldCount: 42 });

    const parsed = parseLines(captured.lines)[0];
    expect(parsed.redactedFieldCount).toBeUndefined();
  });

  it("keeps non-PII fields so logs stay useful", () => {
    const cleaned = redactFields<Record<string, unknown>>({
      sessionId: "sess_1",
      status: "draft",
      counts: { answered: 4, remaining: 9 },
      tags: ["draft", "caseworker_assisted"],
    });
    expect(cleaned).toEqual({
      sessionId: "sess_1",
      status: "draft",
      counts: { answered: 4, remaining: 9 },
      tags: ["draft", "caseworker_assisted"],
    });
  });

  it("survives cyclic structures without throwing or leaking", () => {
    const cyclic: Record<string, unknown> = { name: "Jane Q. Applicant" };
    cyclic.self = cyclic;

    const cleaned = redactFields<Record<string, unknown>>(cyclic);
    expect(() => JSON.stringify(cleaned)).not.toThrow();
    expect(JSON.stringify(cleaned)).not.toContain("Jane Q. Applicant");

    const captured = captureLines();
    restoreSink = captured.restore;
    logInfo("test.cycle", cyclic);
    const parsed = parseLines(captured.lines)[0];
    expect(JSON.stringify(parsed)).not.toContain("Jane Q. Applicant");
  });
});

// ---------------------------------------------------------------------------
// VAL-TEL-003: closed error taxonomy
// ---------------------------------------------------------------------------

describe("closed error taxonomy (VAL-TEL-003)", () => {
  it("is exactly the seven-code closed set including model_unavailable and consent_required", () => {
    expect([...ERROR_TAXONOMY].sort()).toEqual(
      [
        "validation_error",
        "not_found",
        "db_error",
        "model_unavailable",
        "rate_limited",
        "consent_required",
        "internal",
      ].sort(),
    );
    expect(ERROR_TAXONOMY).toContain("model_unavailable");
    // Mission v2.1 M5 (HACK-81): consent refusals are their own honest
    // failure class — never disguised as a validation error.
    expect(ERROR_TAXONOMY).toContain("consent_required");
  });

  it("maps each taxonomy code to itself and isErrorCode guards it", () => {
    for (const code of ERROR_TAXONOMY) {
      expect(isErrorCode(code)).toBe(true);
      expect(toErrorCode(code)).toBe(code);
    }
    expect(isErrorCode("everything_is_fine")).toBe(false);
    expect(isErrorCode(null)).toBe(false);
  });

  it("maps unknown errors to internal", () => {
    for (const unknown of [
      new Error("totally unexpected"),
      "a random string failure",
      42,
      null,
      { code: "something_custom" },
      new TypeError("cannot read property of undefined"),
    ]) {
      expect(toErrorCode(unknown)).toBe("internal");
    }
  });

  it("unknown errors log error_code=internal with zero detail leakage", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    const secret = "SECRET-DB-URL=postgres://user:hunter2@db.internal/prod";
    reportError(new Error(secret));
    reportError(new TypeError("at Postgres.pool hunter2"), {
      event: "intake.answer_submit",
    });
    reportError({ password: "hunter2", userMessage: "oops" });

    const output = captured.lines.join("\n");
    expect(output).not.toContain("hunter2");
    expect(output).not.toContain("SECRET-DB-URL");
    expect(output).not.toContain("Postgres");
    expect(output).not.toContain("oops");
    const parsed = parseLines(captured.lines);
    for (const line of parsed) {
      expect(line.error_code).toBe("internal");
      expect(line.level).toBe("error");
    }
    expect(parsed[1].event).toBe("intake.answer_submit");
  });

  it("AppError keeps its code and safe message but never leaks the cause", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    const cause = new Error("hunter2-internal-stack");
    const err = new AppError("model_unavailable", userMessageFor("model_unavailable"), { cause });
    reportError(err, { event: "guide.message" });

    const output = captured.lines.join("\n");
    expect(output).toContain('"error_code":"model_unavailable"');
    expect(output).toContain(userMessageFor("model_unavailable"));
    expect(output).not.toContain("hunter2-internal-stack");
    const parsed = parseLines(captured.lines)[0];
    expect(parsed.error_message).toBe(userMessageFor("model_unavailable"));
  });

  it("logs a custom AppError message as code only, never the custom copy", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    // A developer habit the redactor must survive: concatenating context
    // into a "safe" message. The log carries the code, not the copy.
    const err = new AppError(
      "validation_error",
      `Could not save answer for jane@example.com`,
    );
    reportError(err, { event: "intake.answer_submit" });

    const output = captured.lines.join("\n");
    expect(output).toContain('"error_code":"validation_error"');
    expect(output).not.toContain("jane@example.com");
    expect(output).not.toContain("Could not save answer");
    const parsed = parseLines(captured.lines)[0];
    expect(parsed.error_message).toBeUndefined();
  });

  it("every code maps to a plain-language, non-promissory safe message", () => {
    const messages = new Map<string, string>();
    for (const code of ERROR_TAXONOMY) {
      const message = userMessageFor(code);
      expect(message.length).toBeGreaterThan(0);
      // No promise language may ever ship through an error message.
      expect(() => assertNoBannedClaims(message)).not.toThrow();
      messages.set(message, code);
    }
    // And every message is distinct, so no category renders another's copy.
    expect(messages.size).toBe(ERROR_TAXONOMY.length);
  });
});
