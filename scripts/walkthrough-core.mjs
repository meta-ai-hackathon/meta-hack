// Core logic for the user-journey walkthrough CLI (scripts/walkthrough.mjs).
//
// Split from the executable so the CLI's offline logic is testable the same
// way its sibling standalone checks are (scripts/meta_smoke_test.py ↔
// tests/test_meta_smoke_test.py): the HTTP layer is injectable, so the
// journey's exit-code contract and violation stops are pinned by
// walkthrough-core.test.mjs without a running app.
//
// See walkthrough.mjs for the full journey description.

import {
  ANSWER_STATUS_LABELS,
  findBannedClaims,
  findPiiValueExposure,
  findPiiValueLeaks,
} from "./walkthrough-detectors.mjs";

export const DEFAULT_URL = "http://localhost:3100";
export const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_ATTEMPTS = 3;
const SESSION_COOKIE = "bn_session";

/** Journey exit codes: 0 clean, 1 violation, 2 journey error. All of the
 * failure exits are nonzero by contract (the CLI must exit nonzero on any
 * mid-journey violation). */
export const EXIT_OK = 0;
export const EXIT_VIOLATION = 1;
export const EXIT_JOURNEY_ERROR = 2;

export function exitCodeForRun(completed) {
  return completed ? EXIT_OK : EXIT_VIOLATION;
}

// The answer script the walkthrough performs, keyed by question id. It
// covers every question the spec can ask given these answers, with a
// realistic tri-state mix:
//   - known answers that trigger skips (main_goal=food skips the private
//     goal_detail text; income_sources=[job,benefits] skips other_income;
//     id_status=have_id skips id_issue_detail; mailing_situation=po_box
//     skips shelter_mail_consent; contact_preference=email skips phone),
//   - known answers that trigger follow-ups (household_children=2 keeps
//     childcare_cost; housing_status=rental_or_own keeps housing_cost and
//     utilities_cost; contact_preference=email asks email_contact),
//   - honest "not sure" answers with no value, and unverified best guesses.
// No question classification is duplicated here: which questions are pii
// comes from the served state payload (the serialization boundary relays
// each question's `pii` flag), never from a hand-copy of the spec.
// All person-specific values are fictional; pii values are submitted and
// then asserted to never reappear in any client-visible body.
export const JOURNEY_PLAN = [
  { id: "application_role", status: "known", value: "self" },
  { id: "main_goal", status: "known", value: "food" },
  { id: "state", status: "known", value: "CA" },
  { id: "county", status: "known", value: "Contra Costa County" },
  { id: "household_size", status: "known", value: 3 },
  { id: "household_children", status: "known", value: 2 },
  { id: "household_seniors", status: "known", value: 0 },
  { id: "income_sources", status: "known", value: ["job", "benefits"] },
  { id: "job_income_amount", status: "known", value: 2400 },
  { id: "job_income_frequency", status: "known", value: "biweekly" },
  { id: "benefits_income_amount", status: "unknown" },
  { id: "benefits_income_frequency", status: "unverified", value: "monthly" },
  { id: "housing_status", status: "known", value: "rental_or_own" },
  { id: "housing_cost", status: "unverified", value: 1800 },
  { id: "utilities_cost", status: "known", value: 95 },
  { id: "childcare_cost", status: "known", value: 400 },
  { id: "medical_cost", status: "unknown" },
  { id: "id_status", status: "known", value: "have_id" },
  { id: "date_of_birth", status: "known", value: "1990-05-14" },
  { id: "citizenship_status", status: "unknown" },
  { id: "disability_status", status: "known", value: "no" },
  { id: "student_status", status: "known", value: "not_student" },
  { id: "veteran_status", status: "known", value: false },
  { id: "received_benefits_before", status: "known", value: false },
  { id: "mailing_situation", status: "known", value: "po_box" },
  { id: "contact_preference", status: "known", value: "email" },
  { id: "email_contact", status: "known", value: "jamie.watts@example.com" },
  { id: "best_time_to_reach", status: "known", value: "afternoon" },
];

const PLAN_BY_ID = new Map(JOURNEY_PLAN.map((step) => [step.id, step]));

// ---------------------------------------------------------------------------
// Small fetch/response helpers
// ---------------------------------------------------------------------------

export class WalkthroughError extends Error {
  constructor(message) {
    super(message);
    this.name = "WalkthroughError";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** fetch with a hard timeout and patient retries for cold starts. */
async function fetchWithRetry(url, init, timeoutMs) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const transient = [429, 502, 503, 504].includes(response.status);
      if (transient && attempt < RETRY_ATTEMPTS) {
        await sleep(1000 * attempt);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(1000 * attempt);
      }
    }
  }
  throw lastError ?? new Error("request failed");
}

/** GET/POST against the target app, returning {status, text, response}. */
export async function http(base, path, { method = "GET", body, cookie } = {}, timeoutMs) {
  const headers = {};
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (cookie) {
    headers.cookie = cookie;
  }
  const response = await fetchWithRetry(
    `${base}${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    timeoutMs,
  );
  return { status: response.status, text: await response.text(), response };
}

export function parseJsonBody(text, what) {
  try {
    return JSON.parse(text);
  } catch {
    throw new WalkthroughError(
      `${what} returned a non-JSON body (first 200 chars): ${text.slice(0, 200)}`,
    );
  }
}

/** Pull the session cookie out of a response's set-cookie headers. */
export function sessionCookieFrom(response) {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    if (pair.trim().startsWith(`${SESSION_COOKIE}=`)) {
      return pair.trim();
    }
  }
  return null;
}

export function deepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  return keysA.every((key) => deepEqual(a[key], b[key]));
}

// ---------------------------------------------------------------------------
// Walkthrough state
// ---------------------------------------------------------------------------

export class Walkthrough {
  /**
   * @param {string} base target app base URL
   * @param {number} timeoutMs per-request timeout
   * @param {(base: string, path: string, options: object, timeoutMs: number)
   *   => Promise<{status: number, text: string, response: object}>} transport
   *   HTTP layer; injectable so tests can drive the journey without a
   *   running app (defaults to the real fetch-based http()).
   */
  constructor(base, timeoutMs, transport = http) {
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.transport = transport;
    this.lines = [];
    this.violations = [];
    this.privateValues = [];
    this.cookie = null;
  }

  stamp() {
    return new Date().toISOString();
  }

  recordViolation(kind, detail) {
    this.violations.push({ kind, detail, at: this.stamp() });
  }

  log(line) {
    const stamped = `[${this.stamp()}] ${line}`;
    this.lines.push(stamped);
    console.log(stamped);
  }

  /**
   * Scan one response body for banned-claim language and PII leaks.
   * Returns true when a violation was found (the caller stops the journey).
   */
  scanResponse(what, text, parsedState) {
    let found = false;
    for (const match of findBannedClaims(text)) {
      this.recordViolation("banned_claim", {
        where: what,
        pattern: match.patternSource,
        matchedText: match.matchedText,
      });
      found = true;
    }
    const exposure = findPiiValueExposure(text, this.privateValues);
    if (exposure.length > 0) {
      // Never echo the leaked value itself — it is private content.
      this.recordViolation("pii_value_exposure", {
        where: what,
        detail: "a submitted private value appeared in a client-visible body",
      });
      found = true;
    }
    if (parsedState !== undefined) {
      for (const leak of findPiiValueLeaks(parsedState)) {
        this.recordViolation("pii_value_leak", {
          where: what,
          questionId: leak.questionId,
          detail: "a client payload shipped a value under a pii:true question",
        });
        found = true;
      }
    }
    return found;
  }

  /** Print every violation found; the journey returns not-completed (the
   * process must exit nonzero, never silently green). */
  reportViolations() {
    this.log(
      `VIOLATION  ${this.violations.length} violation(s) detected — journey stops here`,
    );
    for (const violation of this.violations) {
      const detail = Object.entries(violation.detail ?? {})
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
      this.log(
        `VIOLATION  [${violation.kind}] at ${violation.at} — ${detail}`,
      );
    }
    this.log("WALKTHROUGH FAILED (violations)");
    return false;
  }

  /** Human-readable rendering of a planned answer for the transcript. */
  static plannedDisplay(step, isPii) {
    if (step.status === "unknown") {
      return "(no value given)";
    }
    if (isPii) {
      return "(answer kept private)";
    }
    return Array.isArray(step.value)
      ? step.value.map((item) => JSON.stringify(item)).join(", ")
      : JSON.stringify(step.value);
  }

  /** Walk the full journey; resolves true when completed cleanly, false
   * when a violation stopped the walk (never throws for violations). */
  async run() {
    this.log(`WALKTHROUGH target ${this.base} — user-journey walkthrough`);

    // 1. The app is up.
    const health = await this.transport(
      this.base,
      "/api/health",
      {},
      this.timeoutMs,
    );
    const healthBody = parseJsonBody(health.text, "GET /api/health");
    this.log(
      `HEALTH    GET /api/health → ${health.status} ${JSON.stringify(healthBody)}`,
    );
    if (health.status !== 200 || healthBody.ok !== true) {
      throw new WalkthroughError(
        `health check failed: ${health.status} ${health.text.slice(0, 200)}`,
      );
    }
    if (this.scanResponse("GET /api/health", health.text)) {
      return this.reportViolations();
    }

    // 2. Create a session (the token comes back as an httpOnly cookie —
    // captured, never printed).
    const created = await this.transport(
      this.base,
      "/api/session",
      { method: "POST", body: {} },
      this.timeoutMs,
    );
    const createdBody = parseJsonBody(created.text, "POST /api/session");
    this.cookie = sessionCookieFrom(created.response);
    this.log(
      `CREATE    POST /api/session → ${created.status}, session token captured` +
        ` (${createdBody?.state?.questions?.length ?? "?"} questions visible)`,
    );
    if (created.status !== 201 || !this.cookie) {
      throw new WalkthroughError(
        `session creation failed: ${created.status} (cookie captured: ${Boolean(this.cookie)})`,
      );
    }

    // 3. Walk the flow: answer whatever question the server shows next and
    // observe the skip behavior each answer causes. Whether a question is
    // pii comes from the served payload — the one authoritative source.
    let state = createdBody.state;
    let answerNumber = 0;
    const skippedBy = new Map();
    while (!state.complete) {
      if (state.currentIndex === null) {
        throw new WalkthroughError(
          "flow is not complete but no question is current — stuck intake state",
        );
      }
      const question = state.questions[state.currentIndex];
      const step = PLAN_BY_ID.get(question.id);
      if (!step) {
        throw new WalkthroughError(
          `the flow asked for "${question.id}", which the journey plan does not cover`,
        );
      }
      const isPii = question.pii === true;
      const isFreeForm = question.type === "text" || question.type === "date";

      const beforeIds = new Set(state.questions.map((item) => item.id));
      const answer = await this.transport(
        this.base,
        "/api/intake/answer",
        {
          method: "POST",
          body: { questionId: step.id, status: step.status, value: step.value ?? null },
          cookie: this.cookie,
        },
        this.timeoutMs,
      );
      const newState = parseJsonBody(answer.text, `answer ${step.id}`);
      if (answer.status !== 200) {
        throw new WalkthroughError(
          `answer ${step.id} rejected: ${answer.status} ${answer.text.slice(0, 200)}`,
        );
      }
      answerNumber += 1;

      if (isPii && step.status !== "unknown" && isFreeForm) {
        // Track private free-form content (text/date answers) so every
        // later body is scanned for it. Select-option values are spec
        // vocabulary — they legitimately appear in every payload's option
        // list — so the PII boundary for those rests on the structural
        // check in scanResponse (no `value` key under a pii question, ever).
        this.privateValues.push(String(step.value));
      }
      this.log(
        `ANSWER ${String(answerNumber).padStart(2, "0")}  ${step.id} = ` +
          `${Walkthrough.plannedDisplay(step, isPii)} — ${ANSWER_STATUS_LABELS[step.status]}`,
      );

      const afterIds = new Set(newState.questions.map((item) => item.id));
      const nowSkipped = [...beforeIds].filter((id) => !afterIds.has(id));
      const nowAsked = [...afterIds].filter((id) => !beforeIds.has(id));
      for (const id of nowSkipped) {
        skippedBy.set(id, step.id);
      }
      if (nowSkipped.length > 0 || nowAsked.length > 0) {
        const parts = [];
        if (nowSkipped.length > 0) {
          parts.push(`no longer asked: ${nowSkipped.join(", ")}`);
        }
        if (nowAsked.length > 0) {
          parts.push(`newly asked: ${nowAsked.join(", ")}`);
        }
        this.log(`          ${parts.join(" · ")}`);
      }

      if (this.scanResponse(`answer ${step.id}`, answer.text, newState)) {
        return this.reportViolations();
      }
      state = newState;
    }

    const statusCounts = { known: 0, unknown: 0, unverified: 0 };
    for (const step of JOURNEY_PLAN) {
      if (skippedBy.has(step.id) === false) {
        statusCounts[step.status] += 1;
      }
    }
    this.log(
      `COMPLETE  flow finished — ${answerNumber} answered, ` +
        `${skippedBy.size} skipped by the flow`,
    );

    // 4. Save (the wizard's "Save and finish later" — a session POST on the
    // existing token) and exit.
    const saved = await this.transport(
      this.base,
      "/api/session",
      { method: "POST", body: {}, cookie: this.cookie },
      this.timeoutMs,
    );
    this.log(`SAVE      POST /api/session → ${saved.status} (progress saved)`);
    if (saved.status !== 200) {
      throw new WalkthroughError(
        `save failed: ${saved.status} ${saved.text.slice(0, 200)}`,
      );
    }
    const savedBody = parseJsonBody(saved.text, "POST /api/session");
    if (this.scanResponse("save", saved.text, savedBody.state)) {
      return this.reportViolations();
    }

    // 5. Resume with the session token and verify identical progress.
    const resumed = await this.transport(
      this.base,
      "/api/session",
      { cookie: this.cookie },
      this.timeoutMs,
    );
    const resumedBody = parseJsonBody(resumed.text, "GET /api/session");
    this.log(`RESUME    GET /api/session → ${resumed.status}`);
    if (resumed.status !== 200) {
      throw new WalkthroughError(
        `resume failed: ${resumed.status} ${resumed.text.slice(0, 200)}`,
      );
    }
    if (this.scanResponse("resume", resumed.text, resumedBody.state)) {
      return this.reportViolations();
    }
    // The save response is the server's own current view of the session —
    // the baseline the resume must restore identically.
    if (!deepEqual(savedBody.state ?? state, resumedBody.state)) {
      throw new WalkthroughError(
        "resumed state differs from the saved state — progress did not restore identically",
      );
    }
    this.log("RESUMED   state identical to the saved state — progress restored");

    // 6. Still healthy at the end of the walk.
    const finalHealth = await this.transport(
      this.base,
      "/api/health",
      {},
      this.timeoutMs,
    );
    this.log(`HEALTH    GET /api/health → ${finalHealth.status}`);

    this.log(
      "SUMMARY   answers: " +
        Object.entries(statusCounts)
          .map(([status, count]) => `${count} ${ANSWER_STATUS_LABELS[status]}`)
          .join(" · "),
    );
    this.log(
      "SUMMARY   skipped by the flow: " +
        (skippedBy.size === 0
          ? "(none)"
          : [...skippedBy.entries()]
              .map(([id, cause]) => `${id} (after ${cause})`)
              .join(", ")),
    );
    this.log(
      "SUMMARY   private values submitted: " +
        `${this.privateValues.length} (checked: never echoed in any body)`,
    );
    this.log("SUMMARY   violations: none");
    this.log("WALKTHROUGH PASSED");
    return true;
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export function usage() {
  return [
    "Usage: pnpm walkthrough [--url <base-url>] [--timeout <ms>]",
    "",
    "Walks a full user journey over HTTP against a running Benefits",
    "Navigator: create session, mixed tri-state answers, observed skips,",
    "save, exit, resume, transcript with honest-status labels.",
    "",
    "Options:",
    "  --url <base-url>   Target app (default: http://localhost:3100).",
    "                     Any deployed URL works, e.g. the Vercel",
    "                     production or preview deployment.",
    "  --timeout <ms>     Per-request timeout (default: 30000).",
    "  --help             Show this help.",
  ].join("\n");
}

/** Parse CLI arguments; returns null when --help was handled (usage was
 * printed). Throws WalkthroughError on anything unrecognized. */
export function parseArgs(argv) {
  const options = { url: DEFAULT_URL, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      return null;
    } else if (arg === "--url") {
      options.url = argv[++index];
    } else if (arg === "--timeout") {
      options.timeoutMs = Number(argv[++index]);
    } else {
      throw new WalkthroughError(`unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (typeof options.url !== "string" || !/^https?:\/\//.test(options.url)) {
    throw new WalkthroughError(`--url must be an http(s) URL, got: ${options.url}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new WalkthroughError(`--timeout must be a positive number of ms`);
  }
  options.url = options.url.replace(/\/+$/, "");
  return options;
}

export async function main() {
  // Everything — argument parsing included — is inside the guarded region:
  // a usage error is a journey error (exit 2), never a raw stack trace.
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options === null) {
      process.exitCode = EXIT_OK;
      return;
    }
    const walk = new Walkthrough(options.url, options.timeoutMs);
    const completed = await walk.run();
    process.exitCode = exitCodeForRun(completed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${new Date().toISOString()}] JOURNEY ERROR ${message}`);
    console.error(`[${new Date().toISOString()}] WALKTHROUGH FAILED`);
    process.exitCode = EXIT_JOURNEY_ERROR;
  }
}
