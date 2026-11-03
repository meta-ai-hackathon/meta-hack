// Core logic for the user-journey walkthrough CLI (scripts/walkthrough.mjs).
//
// Split from the executable so the CLI's offline logic is testable the same
// way its sibling standalone checks are (scripts/meta_smoke_test.py ↔
// tests/test_meta_smoke_test.py): the HTTP layer is injectable, so the
// journey's exit-code contract and violation stops are pinned by
// walkthrough-core.test.mjs without a running app.
//
// See walkthrough.mjs for the full journey description.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANSWER_STATUS_LABELS,
  findBannedClaims,
  findPiiEcho,
  findPiiValueExposure,
  findPiiValueLeaks,
  verifyRedaction,
} from "./walkthrough-detectors.mjs";
import {
  CONVERSATION_PLAN,
  FORM_JOURNEY_PLAN,
  SAMPLE_FORM_UNMAPPED_ANSWERS,
  SPRINT_FORM_UNMAPPED_ANSWERS,
} from "./walkthrough-plans.mjs";

export const DEFAULT_URL = "http://localhost:3100";
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Per-request timeout for the v2 journeys: each typed turn runs two live
 * model calls (extraction + reply), and the match explanation is a third —
 * reasoning-token bursts make 30s too tight for a deployed cold start. */
export const V2_TIMEOUT_MS = 90_000;
const RETRY_ATTEMPTS = 3;
const SESSION_COOKIE = "bn_session";
/** The committed sample registry entry the v2 journeys fill — the pilot
 * seam's stated contract ("the registry entry the validation journeys
 * fill", src/lib/pilot.ts); the sample stays registered for exactly this. */
export const SAMPLE_FORM_ID = "sample-application-form";
/** The TWO REAL applications one sprint session prepares (milestone
 * snap-form, VAL-SPRINT-002): the pilot's primary form plus the
 * additional application. Order mirrors the pilot seam; a drift test
 * pins both ids against src/lib/pilot.ts. */
export const SPRINT_FORM_IDS = Object.freeze(["dhb-5200", "dss-8207"]);
/** The BN-25 lifecycle vocabulary (src/lib/honesty.ts) — the review leg
 * asserts the served session status is one of these. */
export const BN25_SESSION_STATUSES = Object.freeze([
  "draft",
  "prepared",
  "handed_off",
  "user_reported_submitted",
  "user_reported_decided",
]);
/** The conversation engine's per-session turn cap (src/lib/conversation.ts):
 * 12 user turns per rolling 60s. The journeys pace under it. */
const TURN_WINDOW_MS = 60_000;
const TURN_PACE_LIMIT = 11;
/** Patient turn retries for a throttled or cold-starting model: each
 * attempt waits long enough for a rate-limit window to pass. */
export const TURN_ATTEMPTS = 4;
export const TURN_RETRY_WAIT_MS = 25_000;

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
//     income_kind=both adds the self-employment + prior-employer chain
//     (HACK-85's branched flow); job_income_seasonal=no skips the 6-month
//     seasonal total (HACK-130); id_status=have_id skips id_issue_detail;
//     mailing_situation=po_box skips shelter_mail_consent;
//     contact_preference=email skips phone),
//   - known answers that trigger follow-ups (household_children=2 keeps
//     childcare_cost; housing_status=rental_or_own keeps housing_cost and
//     utilities_cost; contact_preference=email asks email_contact),
//   - honest "not sure" answers with no value, and unverified best guesses.
// No question classification is duplicated here: which questions are pii
// comes from the served state payload (the serialization boundary relays
// each question's `pii` flag), never from a hand-copy of the spec.
// All person-specific values are fictional; pii values are submitted and
// then asserted to never reappear in any client-visible body.
// walkthrough-core.test.mjs walks this plan on the app's own flow engine
// for every journey it serves, so a spec change that asks the persona
// something new fails the suite instead of the pre-demo check (HACK-133).
export const JOURNEY_PLAN = [
  { id: "application_role", status: "known", value: "self" },
  { id: "main_goal", status: "known", value: "food" },
  { id: "state", status: "known", value: "CA" },
  { id: "county", status: "known", value: "Contra Costa County" },
  { id: "household_size", status: "known", value: 3 },
  { id: "household_children", status: "known", value: 2 },
  { id: "household_seniors", status: "known", value: 0 },
  { id: "income_sources", status: "known", value: ["job", "benefits"] },
  { id: "income_kind", status: "known", value: "both" },
  { id: "self_employment_statements_offer", status: "known", value: "will_share" },
  { id: "prior_employer_current", status: "known", value: "no_longer_there" },
  { id: "prior_employer_last_month", status: "known", value: "June 2025" },
  { id: "job_income_amount", status: "known", value: 2400 },
  { id: "job_income_frequency", status: "known", value: "biweekly" },
  // HACK-130 (#138) asks next whether ALL of the household's job work is
  // seasonal. The persona's biweekly paycheck is year-round work, so the
  // answer is no: the flow skips the 6-month seasonal total, and the $580
  // screen's match keeps converting the paycheck, as it did before.
  { id: "job_income_seasonal", status: "known", value: "no" },
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
  // The work-requirements questions (milestone work-requirements), in spec
  // order. The persona is a parent of a child under 18 whose household
  // makes at least $580 a month — so the Civilla two-section design's
  // reporting section (wr_work_activity_who/types/hours) is never asked
  // (the exemption and income paths hide it), and neither is the
  // which-situations follow-up (wr_applied_last_month = no). The four
  // branch-covered ids below are still plan entries — the coverage check
  // demands the plan can answer anything the flow could ask if an answer
  // landed differently than intended.
  { id: "wr_exempt_situations", status: "known", value: ["parent_child_under_18"] },
  { id: "wr_pregnant", status: "known", value: "no" },
  { id: "wr_drug_alcohol_treatment", status: "known", value: "no" },
  { id: "wr_drug_alcohol_disorder", status: "known", value: "no" },
  { id: "wr_disability_hard_work", status: "known", value: "no" },
  { id: "wr_mental_health_hard_work", status: "known", value: "no" },
  { id: "wr_serious_health_condition", status: "known", value: "no" },
  { id: "wr_jail_prison_past_4_months", status: "known", value: "no" },
  { id: "wr_foster_care_under_26", status: "known", value: "no" },
  { id: "wr_veteran_100_disabled", status: "known", value: "no" },
  { id: "wr_applied_last_month", status: "known", value: "no" },
  // Branch coverage: asked only when wr_applied_last_month = yes.
  { id: "wr_applied_last_month_which", status: "known", value: ["parent_child_under_18"] },
  { id: "wr_medical_travel_1hr", status: "known", value: "no" },
  { id: "wr_hospital_care_24hr", status: "known", value: "no" },
  { id: "wr_student_enrolled", status: "known", value: "not_enrolled" },
  { id: "wr_income_580", status: "known", value: "yes" },
  // Branch coverage: the work-activity reporting section, asked only when
  // no exemption/income/student path applies (the persona's answers hide
  // it). The who is free-form private content; the hours number is NOT
  // tracked as a private value (digits-only needles over-match — the
  // structural leak check carries the boundary, per the vault-row
  // deflake lesson).
  { id: "wr_work_activity_who", status: "known", value: "Me and my sister", privateValue: "Me and my sister" },
  { id: "wr_work_activity_types", status: "known", value: ["job_internship", "caregiving"] },
  { id: "wr_work_activity_hours", status: "known", value: 30 },
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

/**
 * The consent receipt the v2 journeys send with every typed turn (and
 * the match explanation request): the AI toggle on, voice off — the
 * exact grant the consent surface's typed path gives, named in the
 * transcript (HACK-81). No session data rides this header; the receipt
 * names the decision only. The sprint journey's scripted-audio turn
 * passes { voice: true } — the voice path's own receipt (the voice
 * toggle rides ON the AI consent, src/lib/consent.ts).
 */
export function consentHeaderValue({ voice = false } = {}) {
  // Receipt v2 (41cd06c bound the receipt to a providerId; the server
  // fails closed on anything older): the AI toggle on, voice on only for
  // a scripted-audio turn — the same grant the consent surface gives.
  return JSON.stringify({
    v: 2,
    providerId: "meta-model-api",
    ai: true,
    voice,
    at: new Date().toISOString(),
  });
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

/** GET/POST against the target app, returning {status, text, response}.
 * A FormData/string/Uint8Array body passes through raw (fetch sets the
 * multipart boundary itself); anything else is JSON-encoded. */
export async function http(
  base,
  path,
  { method = "GET", body, cookie, headers = {} } = {},
  timeoutMs,
) {
  const requestHeaders = { ...headers };
  const rawBody =
    body instanceof FormData ||
    typeof body === "string" ||
    body instanceof Uint8Array;
  if (body !== undefined && !rawBody) {
    requestHeaders["content-type"] = "application/json";
  }
  if (cookie) {
    requestHeaders.cookie = cookie;
  }
  const response = await fetchWithRetry(
    `${base}${path}`,
    {
      method,
      headers: requestHeaders,
      body:
        body === undefined
          ? undefined
          : rawBody
            ? body
            : JSON.stringify(body),
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
// Sprint journey helpers (scripted audio, local DB evidence, 1040 fixture)
// ---------------------------------------------------------------------------

/**
 * A scripted spoken turn (the mission's VAL-VOICE-001 synthetic-voice
 * pattern): the plan sentence rendered to a 16 kHz mono 16-bit PCM WAV
 * with the machine's `say` + `afconvert` — exactly the audio format the
 * STT route accepts. macOS-only tools; a failure is a journey error,
 * NEVER a silent typed fallback (the voice-consented path must actually
 * ride the voice rail for its transcript to mean anything). `exec` is
 * injectable so the unit tests never shell out.
 */
export function scriptedWavBytes(text, exec = execFileSync) {
  const dir = mkdtempSync(join(tmpdir(), "walkthrough-voice-"));
  try {
    const aiffPath = join(dir, "turn.aiff");
    const wavPath = join(dir, "turn.wav");
    exec("say", ["-o", aiffPath, text]);
    exec("afconvert", [
      "-f", "WAVE",
      "-d", "LEI16@16000",
      "-c", "1",
      aiffPath,
      wavPath,
    ]);
    return new Uint8Array(readFileSync(wavPath));
  } catch (error) {
    throw new WalkthroughError(
      `could not synthesize the scripted voice turn (say + afconvert are the `
        + `mission's macOS tools): ${error?.message ?? error}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Local-only DB evidence for the purge (VAL-SPRINT-003): row counts for
 * one session in the four data tables, read with docker exec psql
 * against the compose Postgres. Opt-in (--db-verify) because the
 * walkthrough also runs against deployed URLs where no local container
 * exists. `sessionId` MUST be the UUID the session cookie carries (the
 * caller validates it — it is interpolated into the SQL). `exec` is
 * injectable so the unit tests never shell out.
 */
export function psqlRowCounts(sessionId, exec = execFileSync) {
  const tables = ["answer", "vault_entry", "conversation_turn", "session_audit_note"];
  const counts = {};
  for (const table of tables) {
    const output = exec(
      "docker",
      [
        "exec", "benefits-navigator-pg",
        "psql", "-U", "postgres", "-d", "benefits_navigator",
        "-tAc", `SELECT count(*) FROM ${table} WHERE session_id = '${sessionId}'`,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    counts[table] = Number(output.trim());
  }
  return counts;
}

/**
 * The committed 1040 test fixture the income stage's upload leg posts
 * (read from disk — the walkthrough never imports app code; this is test
 * data, not app behavior).
 */
function taxReturnFixtureBytes() {
  return new Uint8Array(
    readFileSync(new URL("../src/lib/income/fixtures/f1040.pdf", import.meta.url)),
  );
}

/**
 * A FILLED copy of the committed 1040 fixture, built in memory the same
 * way the tax-parse suite synthesizes its filled inputs (HACK-58's
 * synthetic pattern — never a committed filled persona). The committed
 * template is BLANK, so an honest parse of the raw fixture proposes
 * nothing; the walkthrough needs the findings so the confirm leg can
 * exercise the tax_return provenance the purge must cover. Uses the
 * app's own pinned @cantoo/pdf-lib (lazy import — the other modes never
 * load it); the same IRS AcroForm names the parser reads back.
 */
let cachedFilled1040 = null;
async function filled1040FixtureBytes() {
  if (cachedFilled1040 !== null) {
    return cachedFilled1040;
  }
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  const pdf = await PDFDocument.load(taxReturnFixtureBytes(), {
    ignoreEncryption: true,
    updateMetadata: false,
  });
  const form = pdf.getForm();
  const P1 = "topmostSubform[0].Page1[0].";
  form.getTextField(`${P1}f1_47[0]`).setText("52500"); // line 1a wages
  form.getTextField(`${P1}f1_75[0]`).setText("48200"); // line 11 AGI
  form.getCheckBox(`${P1}Checkbox_ReadOrder[0].c1_8[1]`).check(); // MFJ
  cachedFilled1040 = await pdf.save();
  return cachedFilled1040;
}

/** The multipart body of a scripted voice turn: the `audio` part the
 * turn route reads (src/app/api/conversation/turn/route.ts). A Blob part
 * is re-readable, so one FormData survives the turn's retry loop. */
function audioTurnFormData(audio) {
  const form = new FormData();
  form.set("audio", new Blob([audio], { type: "audio/wav" }), "turn.wav");
  return form;
}

/**
 * The quick-questions counter's honesty (VAL-QQ-008, progress counts
 * consistent): every served client state carries the engine's N-of-M
 * block, the numbers agree with the id lists, the remaining set never
 * leaves the required universe, a just-answered question never stays
 * "remaining" (ask-once through the HTTP surface), and the count only
 * ever shrinks while the journey accumulates answers. Returns a problem
 * string, or null when the block is consistent.
 */
export function quickQuestionsCounterProblem(previousState, nextState, answeredId) {
  const block = nextState?.quickQuestions;
  if (block === null || typeof block !== "object" || Array.isArray(block)) {
    return "the served client state carries no quickQuestions counter block";
  }
  const { requiredIds, requiredCount, remainingIds, remainingCount } = block;
  if (!Array.isArray(requiredIds) || !Array.isArray(remainingIds)) {
    return "the quickQuestions block carries no question-id lists";
  }
  if (typeof requiredCount !== "number" || typeof remainingCount !== "number") {
    return "the quickQuestions block carries non-numeric counts";
  }
  if (requiredCount !== requiredIds.length) {
    return `requiredCount ${requiredCount} does not match the required list (${requiredIds.length})`;
  }
  if (remainingCount !== remainingIds.length) {
    return `remainingCount ${remainingCount} does not match the remaining list (${remainingIds.length})`;
  }
  if (requiredCount < remainingCount) {
    return `remainingCount ${remainingCount} exceeds the required universe (${requiredCount})`;
  }
  const required = new Set(requiredIds);
  const stray = remainingIds.filter((id) => !required.has(id));
  if (stray.length > 0) {
    return `remaining ids outside the required universe: ${stray.join(", ")}`;
  }
  if (answeredId !== undefined && remainingIds.includes(answeredId)) {
    return `the just-answered question "${answeredId}" is still in the remaining set (ask-once violated)`;
  }
  const previousCount = previousState?.quickQuestions?.remainingCount;
  if (typeof previousCount === "number" && remainingCount > previousCount) {
    return `the remaining count grew from ${previousCount} to ${remainingCount} as answers accumulated`;
  }
  return null;
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
   * @param {(ms: number) => Promise<void>} sleepFn the paceTurns waiter;
   *   injectable so the turn-cap pacing tests never actually sleep.
   */
  constructor(base, timeoutMs, transport = http, sleepFn = sleep) {
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.transport = transport;
    this.sleepFn = sleepFn;
    this.lines = [];
    this.violations = [];
    this.privateValues = [];
    this.cookie = null;
    this.turnTimes = [];
    this.turnsSent = 0;
    this.lastAssistantReply = null;
    // The purge ledger (VAL-SPRINT-003): every answer id this journey
    // saved (any route), the subset that is private (vault rows), and
    // the turn count. The confirmed purge's deleted-count receipt is
    // checked against these lower bounds.
    this.savedAnswerIds = new Set();
    this.savedPiiAnswerIds = new Set();
  }

  /**
   * Note one answer the journey saved through any route (ask-once
   * evidence + the purge ledger's lower bound). `vaulted` — a pii save
   * that carried a VALUE: a status-only "I'm not sure" writes the answer
   * row but no vault row (the store's delete-on-disavow), so it must not
   * inflate the vault ledger.
   */
  noteSavedAnswer(questionId, vaulted = false) {
    this.savedAnswerIds.add(questionId);
    if (vaulted) {
      this.savedPiiAnswerIds.add(questionId);
    }
  }

  /** The purge receipt's lower bounds from this journey's own ledger. */
  purgeLedger() {
    return {
      answers: this.savedAnswerIds.size,
      vaultEntries: this.savedPiiAnswerIds.size,
      turns: this.turnsSent,
    };
  }

  stamp() {
    return new Date().toISOString();
  }

  recordViolation(kind, detail) {
    this.violations.push({ kind, detail, at: this.stamp() });
  }

  /**
   * The transcript itself must never become the echo the detectors hunt:
   * any tracked private value that reaches a logged or quoted string
   * (an assistant reply, a server error body) is replaced with a marker
   * before printing.
   */
  maskPrivateValues(text) {
    let masked = String(text);
    for (const value of this.privateValues) {
      if (value !== "" && masked.includes(value)) {
        masked = masked.split(value).join("[private value removed from the transcript]");
      }
    }
    return masked;
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

  // ---------------------------------------------------------------------
  // v2 journey legs (VAL-WALK2-001/003, VAL-X2-001/002): the conversation
  // engine's HTTP surface, with the same violation scans on every leg.
  // ---------------------------------------------------------------------

  /**
   * Stay under the conversation engine's per-session turn cap (12 user
   * turns per rolling 60s): pace one under it. A person tapping through
   * push-to-talk cannot beat this either — the wait IS the honest pace.
   */
  async paceTurns() {
    const now = Date.now();
    this.turnTimes = this.turnTimes.filter((time) => now - time < TURN_WINDOW_MS);
    if (this.turnTimes.length >= TURN_PACE_LIMIT) {
      const wait = TURN_WINDOW_MS - (now - this.turnTimes[0]) + 250;
      if (wait > 0) {
        this.log(
        `PAUSE     ${Math.ceil(wait / 1000)}s — pacing typed turns under `
          + `the server's per-minute cap`,
        );
        await this.sleepFn(wait);
      }
      const fresh = Date.now();
      this.turnTimes = this.turnTimes.filter((time) => fresh - time < TURN_WINDOW_MS);
    }
    this.turnTimes.push(Date.now());
  }

  /**
   * One conversation turn — typed text (JSON) or scripted audio
   * (multipart, when `audio` bytes are passed). The walkthrough is an
   * AI-consented client: the consent header carries the AI toggle on,
   * and the voice toggle ONLY on the audio turn — each send carries the
   * receipt for what it actually is, exactly what the consent surface's
   * grants name (HACK-81). The response — reply, redacted transcript,
   * state, and any extra field — is scanned with the full detector set:
   * banned claims (whole body + assistant turn specifically), pii echoes
   * on the parsed payload, structural pii leaks in the state, raw-text
   * exposure of every tracked private value, and the redaction of this
   * turn's own words.
   *
   * @param {string} userText the words typed or spoken for this turn
   * @param {{audio?: Uint8Array}} [options] audio bytes for a voice turn
   * @returns {object} the parsed turn response
   */
  async conversationTurn(userText, { audio } = {}) {
    await this.paceTurns();
    const isVoice = audio instanceof Uint8Array;
    let response;
    for (let attempt = 1; attempt <= TURN_ATTEMPTS; attempt++) {
      // Every attempt is a real server turn: if the engine counts failed
      // turns toward its per-minute cap, the pacer must count them too.
      if (attempt > 1) {
        this.turnTimes.push(Date.now());
      }
      response = await this.transport(
        this.base,
        "/api/conversation/turn",
        {
          method: "POST",
          body: isVoice
            ? audioTurnFormData(audio)
            : { text: userText },
          cookie: this.cookie,
          headers: { "x-bn-consent": consentHeaderValue({ voice: isVoice }) },
        },
        this.timeoutMs,
      );
      // The route issues/refreshes the session cookie on error responses
      // too (a fresh visitor whose reply failed keeps their saved
      // answers) — capture it so a retry resumes instead of orphaning.
      const retryCookie = sessionCookieFrom(response.response);
      if (retryCookie) {
        this.cookie = retryCookie;
      }
      const transient = [429, 502, 503, 504].includes(response.status);
      if (!transient || attempt === TURN_ATTEMPTS) {
        break;
      }
      // A throttled or cold-starting model: wait it out. Retrying the
      // turn is safe — a failed turn persists no transcript (the route's
      // atomicity), and saved answers update rather than duplicate.
      this.log(
        `RETRY     turn failed with ${response.status} — the model is `
          + `throttling or unavailable; waiting ${TURN_RETRY_WAIT_MS / 1000}s `
          + "before trying again",
      );
      await this.sleepFn(TURN_RETRY_WAIT_MS);
    }
    if (response.status !== 200) {
      throw new WalkthroughError(
        `conversation turn rejected: ${response.status} `
          + this.maskPrivateValues(response.text.slice(0, 200)),
      );
    }
    this.turnsSent += 1;
    const body = parseJsonBody(response.text, "POST /api/conversation/turn");
    this.lastAssistantReply =
      typeof body.assistantReply === "string" ? body.assistantReply : this.lastAssistantReply;
    // Every scan runs unconditionally — the transcript must name ALL the
    // violations a body carries (what and where), not just the first kind.
    this.scanResponse("conversation turn", response.text, body.state);
    // The assistant's own words get their own violation kind: a promise in
    // an assistant turn means the app's reply gate failed to fire.
    for (const match of findBannedClaims(String(body.assistantReply ?? ""))) {
      this.recordViolation("assistant_banned_claim", {
        where: "conversation turn assistantReply",
        pattern: match.patternSource,
        matchedText: match.matchedText,
      });
    }
    for (const echo of findPiiEcho(body, this.privateValues)) {
      this.recordViolation("pii_echo", {
        where: "conversation turn response",
        path: echo.path,
        detail: "a submitted private value appeared in a client payload field",
      });
    }
    const unredacted = verifyRedaction(
      userText,
      body.redactedUserTranscript ?? "",
      this.privateValues,
    );
    if (unredacted.length > 0) {
      this.recordViolation("redaction_failure", {
        where: "conversation turn redactedUserTranscript",
        detail: `${unredacted.length} submitted private value(s) survived `
          + "in the delivered transcript",
      });
    }
    return body;
  }

  /** GET (or POST) /api/match — the ranked cards, each scanned like
   * every other body. The AI explanation request carries the AI consent
   * receipt; the DECLINED path asks with NO receipt at all (the
   * deterministic cards must serve fine without one — a consent refusal
   * never blocks the journey, HACK-81). */
  async getMatch({ consented = true } = {}) {
    const response = await this.transport(
      this.base,
      "/api/match",
      {
        cookie: this.cookie,
        headers: consented ? { "x-bn-consent": consentHeaderValue() } : {},
      },
      this.timeoutMs,
    );
    if (response.status !== 200) {
      throw new WalkthroughError(
        `match failed: ${response.status} ${this.maskPrivateValues(response.text.slice(0, 200))}`,
      );
    }
    const body = parseJsonBody(response.text, "GET /api/match");
    if (body.hasSession !== true) {
      throw new WalkthroughError("match hasSession=false — the session cookie was not honored");
    }
    const matchCount = Array.isArray(body.matches) ? body.matches.length : -1;
    const toResolveCount = Array.isArray(body.toResolve) ? body.toResolve.length : -1;
    this.log(
      `MATCH     GET /api/match → ${response.status}, ${matchCount} card(s) `
        + `that may be worth pursuing, ${toResolveCount} to resolve`
        + (consented ? "" : " (no consent receipt — the deterministic cards, zero sends)"),
    );
    this.scanResponse("match", response.text);
    for (const echo of findPiiEcho(body, this.privateValues)) {
      this.recordViolation("pii_echo", {
        where: "match response",
        path: echo.path,
        detail: "a submitted private value appeared in a match card or to-resolve item",
      });
    }
    return body;
  }

  /** GET /api/forms/<formId>/review — the prepared-package view. Asserts
   * the session status is BN-25 vocabulary and scans the payload. */
  async getReview(formId) {
    const response = await this.transport(
      this.base,
      `/api/forms/${formId}/review`,
      { cookie: this.cookie },
      this.timeoutMs,
    );
    if (response.status !== 200) {
      throw new WalkthroughError(
        `review failed: ${response.status} ${this.maskPrivateValues(response.text.slice(0, 200))}`,
      );
    }
    const body = parseJsonBody(response.text, `GET /api/forms/${formId}/review`);
    if (body.hasSession !== true) {
      throw new WalkthroughError(
        "review hasSession=false — the session cookie was not honored",
      );
    }
    if (!BN25_SESSION_STATUSES.includes(body.sessionStatus)) {
      throw new WalkthroughError(
        `review sessionStatus "${body.sessionStatus}" is outside the BN-25 vocabulary`,
      );
    }
    const counts = body.counts ?? {};
    this.log(
      `REVIEW    GET /api/forms/${formId}/review → ${response.status}, ` +
        `${counts.prefilled ?? "?"} pre-filled / ${counts.asked ?? "?"} asked / ` +
        `${counts.notApplicable ?? "?"} not applicable (session: ${body.sessionStatus})`,
    );
    for (const field of Array.isArray(body.fields) ? body.fields : []) {
      if (field.state === "not_applicable") {
        this.log(`          skipped by the flow: ${field.fieldName} (not applicable)`);
      } else if (field.state === "prefilled") {
        this.log(
          `          pre-filled: ${field.fieldName} — `
            + (field.provenance ?? "provenance not shown"),
        );
      }
    }
    this.scanResponse("review", response.text);
    for (const echo of findPiiEcho(body, this.privateValues)) {
      this.recordViolation("pii_echo", {
        where: "review response",
        path: echo.path,
        detail: "a submitted private value appeared in the prepared-package view",
      });
    }
    return body;
  }

  /**
   * The ask-once proof on one form's prepared-package review
   * (VAL-SPRINT-002): at least one field pre-filled from the session's
   * answers, and every still-needed field's spec question genuinely has
   * no known answer — an answered question is never re-asked, and a
   * mapped field is never left blank while its answer exists. Throws
   * (journey error) on either breach. Returns the pre-filled count.
   */
  assertReviewCarryover(review, formId) {
    const fields = Array.isArray(review.fields) ? review.fields : [];
    const stateAnswers = this.state?.answers ?? {};
    const prefilled = fields.filter((field) => field.state === "prefilled");
    if (prefilled.length < 1) {
      throw new WalkthroughError(
        `no ${formId} field pre-filled from the session's answers — the `
          + "carry-over round-trip did not happen",
      );
    }
    for (const item of Array.isArray(review.toResolve) ? review.toResolve : []) {
      const field = fields.find((candidate) => candidate.fieldName === item.fieldName);
      if (!field) {
        throw new WalkthroughError(
          `review to-resolve names "${item.fieldName}", which the field view does not contain`,
        );
      }
      if (field.specQuestionId) {
        const answer = stateAnswers[field.specQuestionId];
        if (answer && answer.status === "known") {
          throw new WalkthroughError(
            `review still needs "${item.fieldName}" although its question was `
              + `answered — ask-once violated on ${formId}`,
          );
        }
      }
    }
    return prefilled.length;
  }

  /** GET /api/conversation/history — the resume transcript: turns were
   * redacted at write time; the state passes the usual boundary. */
  async getHistory() {
    const response = await this.transport(
      this.base,
      "/api/conversation/history",
      { cookie: this.cookie },
      this.timeoutMs,
    );
    if (response.status !== 200) {
      throw new WalkthroughError(
        `history failed: ${response.status} ${this.maskPrivateValues(response.text.slice(0, 200))}`,
      );
    }
    const body = parseJsonBody(response.text, "GET /api/conversation/history");
    const turns = Array.isArray(body.turns) ? body.turns : [];
    this.log(
      `HISTORY   GET /api/conversation/history → ${response.status}, `
        + `${turns.length} turn(s)`,
    );
    if (turns.length < 2) {
      throw new WalkthroughError(
          `history has ${turns.length} turn(s) — a conversational journey `
            + "must store both sides of at least one exchange",
      );
    }
    this.scanResponse("history", response.text, body.state);
    for (const echo of findPiiEcho(body, this.privateValues)) {
      this.recordViolation("pii_echo", {
        where: "conversation history",
        path: echo.path,
        detail: "a submitted private value appeared in a stored turn transcript",
      });
    }
    return body;
  }

  /**
   * POST /api/forms/<formId>/fill — the PDF download leg. Unmapped field
   * answers ride the multipart request (memory-only on the server, never
   * stored); the filled bytes come back as an attachment. The filled PDF
   * is the person's own download and carries their answers BY DESIGN, so
   * this leg shape-checks the response (content type, %PDF magic, size)
   * instead of running the text detectors over binary bytes.
   */
  async fillForm(formId, unmappedAnswers) {
    const form = new FormData();
    if (unmappedAnswers !== undefined && unmappedAnswers !== null) {
      form.set("answers", JSON.stringify(unmappedAnswers));
    }
    const response = await this.transport(
      this.base,
      `/api/forms/${formId}/fill`,
      { method: "POST", body: form, cookie: this.cookie },
      this.timeoutMs,
    );
    if (response.status !== 200) {
      throw new WalkthroughError(
        `form fill failed: ${response.status} ${this.maskPrivateValues(response.text.slice(0, 200))}`,
      );
    }
    const contentType = response.response?.headers?.get?.("content-type") ?? "";
    if (!contentType.includes("application/pdf")) {
      throw new WalkthroughError(
        `fill returned content-type "${contentType}" — expected a filled PDF attachment`,
      );
    }
    if (!response.text.startsWith("%PDF")) {
      throw new WalkthroughError("fill response is not a PDF (missing %PDF header)");
    }
    if (response.text.length < 1000) {
      throw new WalkthroughError(
          `fill response is suspiciously small (${response.text.length} chars) `
            + "— refusing to call it a filled PDF",
      );
    }
    this.log(
      `PDF       POST /api/forms/${formId}/fill → ${response.status}, ` +
          `filled PDF downloaded (~${Math.round(response.text.length / 1024)} KB, `
            + "generated on the fly, never persisted server-side)",
    );
  }

  /**
   * Drive the conversation's typed turns with a plan (shared by the v2
   * journeys): answer whatever question the flow shows next, retry once
   * with plainer words when the extraction saved nothing, track the
   * submitted private values, and log the skip behavior each turn causes.
   *
   * @param {readonly {id: string, text: string, retry: string,
   *   intent: string, privateValue?: string}[]} plan typed turns by id
   * @param {string} what transcript label for the loop
   * @param {{audioFirstTurn?: boolean, audioGenerator?: (text: string) =>
   *   Promise<Uint8Array>}} [options] the sprint journey's voice-consented
   *   talk speaks its FIRST turn as scripted audio (the injected generator
   *   renders the plan sentence to WAV) and types the rest — the sanctioned
   *   mode B (voice with exit-to-typing at any point)
   * @returns {Promise<{skippedBy: Map<string, string>}>}
   */
  async runTurnLoop(plan, what, { audioFirstTurn = false, audioGenerator } = {}) {
    const planById = new Map(plan.map((step) => [step.id, step]));
    let state = this.state;
    let turnNumber = 0;
    const skippedBy = new Map();
    while (!state.complete) {
      if (state.currentIndex === null) {
        throw new WalkthroughError(
          "flow is not complete but no question is current — stuck intake state",
        );
      }
      const question = state.questions[state.currentIndex];
      const step = planById.get(question.id);
      if (!step) {
        throw new WalkthroughError(
          `the conversation asked for "${question.id}", which the journey plan does not cover`,
        );
      }
      const isPii = question.pii === true;
      if (isPii && typeof step.privateValue === "string" && step.privateValue.trim() !== "") {
        // The value is about to be typed: every body from this turn on is
        // checked for it (echo + redaction). The plan's privateValue is
        // explicit and typed in canonical form, so the tracking does not
        // guess types — any pii question with a stated value is covered.
        this.privateValues.push(step.privateValue);
      }
      const beforeIds = new Set(state.questions.map((item) => item.id));

      const isAudioTurn = audioFirstTurn && turnNumber === 0;
      let outcome = isAudioTurn
        ? await this.conversationTurn(step.text, {
            audio: await audioGenerator(step.text),
          })
        : await this.conversationTurn(step.text);
      if (isAudioTurn) {
        this.log(
          "VOICE     the talk stage opens with a scripted spoken turn "
            + "(WAV → the STT route) — voice consent receipt attached",
        );
      }
      let newState = outcome.state;
      if (!newState || typeof newState !== "object") {
        throw new WalkthroughError(`turn for "${question.id}" returned no client state`);
      }
      if (newState.answers?.[question.id] === undefined) {
        // The extraction saved nothing for the question the flow was
        // asking — one honest retry with the plainest possible words.
        this.log(`RETRY     no answer saved for ${question.id}; trying plainer words`);
        outcome = await this.conversationTurn(step.retry ?? step.text);
        newState = outcome.state;
        if (!newState || typeof newState !== "object") {
          throw new WalkthroughError(
            `retry turn for "${question.id}" returned no client state`,
          );
        }
        if (newState.answers?.[question.id] === undefined) {
          throw new WalkthroughError(
            `the conversation could not extract an answer for "${question.id}" `
              + "after a plain-word retry",
          );
        }
      }
      turnNumber += 1;
      const servedStatus = newState.answers[question.id]?.status ?? "unknown";
      this.noteSavedAnswer(question.id, isPii && servedStatus !== "unknown");
      const statusLabel = ANSWER_STATUS_LABELS[servedStatus] ?? servedStatus;
      const displayValue = isPii
        ? "(answer kept private)"
        : JSON.stringify(newState.answers[question.id]?.value);
      const intentNote =
        step.intent !== undefined && step.intent !== servedStatus
          ? ` (intended: ${step.intent} attempt)`
          : "";
      this.log(
        `TURN ${String(turnNumber).padStart(2, "0")}    ${question.id} = ${displayValue}` +
          ` — ${statusLabel}${intentNote}`,
      );
      if (typeof outcome.assistantReply === "string") {
        // Masked: a reply that echoed a private value must not have the
        // transcript print the very value the detector reports by path.
        this.log(`          the assistant: ${this.maskPrivateValues(outcome.assistantReply)}`);
      }

      const afterIds = new Set(newState.questions.map((item) => item.id));
      const nowSkipped = [...beforeIds].filter((id) => !afterIds.has(id));
      const nowAsked = [...afterIds].filter((id) => !beforeIds.has(id));
      for (const id of nowSkipped) {
        skippedBy.set(id, question.id);
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

      state = newState;
      this.state = newState;
      if (this.violations.length > 0) {
        return { skippedBy };
      }
    }
    // turnsSent counts what was actually sent — a plain-word retry sends a
    // second turn for one question, and the transcript must not undercount.
    this.log(
      `COMPLETE  ${what} finished — ${turnNumber} question(s) answered in ` +
        `${this.turnsSent} typed turn(s), ` +
        `${skippedBy.size} question(s) skipped by the flow`,
    );
    return { skippedBy };
  }

  /**
   * The quick-questions phase of the typed journeys: the work-requirements
   * questions (milestone work-requirements) answered through the wizard's answer route
   * (POST /api/intake/answer — a server endpoint, the same save the
   * quick-questions stage makes; NO MODEL in the loop), before the typed talk turns begin. ONLY those
   * sensitive questions are captured here — every other required question
   * stays with the typed turns, so the journeys keep their full
   * typed-turn coverage (claude-review P2). The phase mirrors the
   * product's own default flow (entry → quick questions → talk), where
   * sensitive select answers are captured through the local UI route and
   * never sent to the model (claude-review P1).
   *
   * @returns {Promise<{skippedBy: Map<string, string>}>} the skip ledger
   *   this phase caused (the work-activity section hiding, for example)
   */
  async answerWorkRequirementsLocally() {
    let state = this.state;
    let answerNumber = 0;
    const skippedBy = new Map();
    // Progress guard: every pass must answer one pending id and shrink
    // the remaining set — a route that saved nothing would otherwise
    // spin forever (claude-review P3).
    while (
      state?.quickQuestions &&
      state.quickQuestions.remainingCount > 0 &&
      answerNumber <= state.quickQuestions.requiredIds.length
    ) {
      const pendingWr = state.quickQuestions.remainingIds.filter((id) =>
        id.startsWith("wr_"),
      );
      if (pendingWr.some((id) => !PLAN_BY_ID.has(id))) {
        throw new WalkthroughError(
          `the work-requirements questions include a pending id the journey plan does not cover: ` +
            pendingWr.filter((id) => !PLAN_BY_ID.has(id)).join(", "),
        );
      }
      if (pendingWr.length === 0) {
        break;
      }
      const step = PLAN_BY_ID.get(pendingWr[0]);
      const served = state.questions.find((item) => item.id === step.id);
      const isPii = served?.pii === true;
      const beforeIds = new Set(state.questions.map((item) => item.id));
      const response = await this.transport(
        this.base,
        "/api/intake/answer",
        {
          method: "POST",
          body: {
            questionId: step.id,
            status: step.status,
            value: step.value ?? null,
          },
          cookie: this.cookie,
        },
        this.timeoutMs,
      );
      const newState = parseJsonBody(response.text, `answer ${step.id}`);
      if (response.status !== 200) {
        throw new WalkthroughError(
          `local answer ${step.id} rejected: ${response.status} ` +
            `${this.maskPrivateValues(response.text.slice(0, 200))}`,
        );
      }
      answerNumber += 1;
      this.noteSavedAnswer(step.id, isPii && step.status !== "unknown");
      this.log(
        `QQ-ANSWER ${String(answerNumber).padStart(2, "0")}  ${step.id} = ` +
          `${Walkthrough.plannedDisplay(step, isPii)} — ` +
          `${ANSWER_STATUS_LABELS[step.status]}  (answer route, no model)`,
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
      const counterProblem = quickQuestionsCounterProblem(state, newState, step.id);
      if (counterProblem) {
        this.recordViolation("quick_questions_counter", {
          where: `answer ${step.id}`,
          detail: counterProblem,
        });
        return { skippedBy };
      }
      state = newState;
      this.state = newState;
    }
    if (answerNumber > 0) {
      this.log(
        `QQ-LOCAL  ${answerNumber} work-requirements question(s) answered ` +
          "through the answer route — the model saw none of them",
      );
    }
    return { skippedBy };
  }

  /**
   * The v2 CONVERSATIONAL journey (text mode), the full cross-area run:
   * health → create session → the quick-questions phase through the local
   * select route → typed turns driving the conversation
   * (realistic tri-state mix) → match → review with the skip behavior →
   * save → exit → resume via the session token (+ stored history) → the
   * PDF download leg. Resolves true when completed cleanly, false when a
   * violation stopped the walk.
   *
   * @param {{plan?: object[], formId?: string, unmappedAnswers?: object,
   *   }} [options] injectable for the unit tests
   */
  async runConversation(options = {}) {
    const {
      plan = CONVERSATION_PLAN,
      formId = SAMPLE_FORM_ID,
      unmappedAnswers = SAMPLE_FORM_UNMAPPED_ANSWERS,
    } = options;
    this.log(
      `WALKTHROUGH target ${this.base} — conversational journey (text mode): `
        + "typed turns → match → review → save/resume → PDF download",
    );
    await this.startSession();
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    this.log(
      "CONSENT   typed turns carry the AI consent receipt (voice off) — the "
        + "same grant the consent surface's typed path gives (HACK-81)",
    );
    const { skippedBy: qqSkippedBy } = await this.answerWorkRequirementsLocally();
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    const { skippedBy } = await this.runTurnLoop(plan, "conversation");
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    for (const [id, asker] of qqSkippedBy) {
      if (!skippedBy.has(id)) {
        skippedBy.set(id, asker);
      }
    }
    this.summarizeSkips(skippedBy);

    await this.getMatch();
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    const review = await this.getReview(formId);
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    const notApplicable = (review.fields ?? []).filter(
      (field) => field.state === "not_applicable",
    );
    this.log(
      `          skipped fields observed on the review: ` +
        (notApplicable.length === 0
          ? "(none)"
          : notApplicable.map((field) => field.fieldName).join(", ")),
    );

    // Save and exit, then resume with the session token: the saved state,
    // the restored state, and the stored transcript must agree.
    const savedState = await this.saveSession();
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    const resumedState = await this.resumeSession();
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    if (!deepEqual(savedState, resumedState)) {
      throw new WalkthroughError(
        "resumed state differs from the saved state — progress did not restore identically",
      );
    }
    this.log("RESUMED   state identical to the saved state — progress restored");
    const history = await this.getHistory();
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    if (!deepEqual(savedState, history.state)) {
      throw new WalkthroughError(
        "conversation history state differs from the saved state — resume is not consistent",
      );
    }
    const lastReply = this.lastAssistantReply;
    if (
      typeof lastReply === "string" &&
      !history.turns.some((turn) => turn.transcript === lastReply)
    ) {
      throw new WalkthroughError(
        "the last delivered assistant reply is missing from the stored history",
      );
    }
    this.log(
      "          stored history carries the delivered reply — transcript and state agree",
    );

    await this.fillForm(formId, unmappedAnswers);
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    await this.endHealthCheck();
    this.summarizePlan(plan, "conversation plan");
    this.log("WALKTHROUGH PASSED");
    return true;
  }

  /**
   * The v2 FORM-DRIVEN journey: health → create session → answer the
   * form's questions through the conversation → the prepared-package
   * review, where mapped fields pre-fill from the conversation's answers
   * and skipped questions are honestly not-applicable → fill → download
   * the filled PDF. Resolves true when completed cleanly, false when a
   * violation stopped the walk.
   */
  async runFormJourney(options = {}) {
    const {
      plan = FORM_JOURNEY_PLAN,
      formId = SAMPLE_FORM_ID,
      unmappedAnswers = SAMPLE_FORM_UNMAPPED_ANSWERS,
    } = options;
    this.log(
      `WALKTHROUGH target ${this.base} — form-driven journey: `
        + "conversation → pre-fill → review → filled PDF",
    );
    await this.startSession();
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    this.log(
      "CONSENT   typed turns carry the AI consent receipt (voice off) — the "
        + "same grant the consent surface's typed path gives (HACK-81)",
    );
    const { skippedBy: qqSkippedBy } = await this.answerWorkRequirementsLocally();
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    const { skippedBy } = await this.runTurnLoop(plan, "form-driven conversation");
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    for (const [id, asker] of qqSkippedBy) {
      if (!skippedBy.has(id)) {
        skippedBy.set(id, asker);
      }
    }
    this.summarizeSkips(skippedBy);

    const review = await this.getReview(formId);
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    const prefilledCount = this.assertReviewCarryover(review, formId);
    const fields = Array.isArray(review.fields) ? review.fields : [];
    this.log(
      `          pre-fill observed: ${prefilledCount} field(s) from the `
        + `conversation's answers; `
        + `${fields.filter((field) => field.state === "not_applicable").length} not applicable`,
    );

    await this.fillForm(formId, unmappedAnswers);
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    await this.endHealthCheck();
    this.summarizePlan(plan, "form journey plan");
    this.log("WALKTHROUGH PASSED");
    return true;
  }

  /**
   * The income stage's legs (milestone income-capture; VAL-SPRINT-001's
   * fourth stage): the 1040 upload's deterministic in-memory parse —
   * never persisted, never a model — followed by the confirm-or-correct
   * save. The parser's proposals are confirmed with provenance
   * `tax_return`; one row is typed over with provenance `user` (both
   * real paths of the stage). The served state must then report income
   * handled — the results gate's income conjunct (VAL-QQ-011).
   */
  async incomeStage({ uploadBytes } = {}) {
    const file = uploadBytes ?? (await filled1040FixtureBytes());
    const uploadForm = new FormData();
    uploadForm.set(
      "file",
      new Blob([file], { type: "application/pdf" }),
      "f1040.pdf",
    );
    const uploaded = await this.transport(
      this.base,
      "/api/intake/tax-return",
      { method: "POST", body: uploadForm, cookie: this.cookie },
      this.timeoutMs,
    );
    if (uploaded.status !== 200) {
      throw new WalkthroughError(
        `tax-return upload failed: ${uploaded.status} `
          + this.maskPrivateValues(uploaded.text.slice(0, 200)),
      );
    }
    const parsedBody = parseJsonBody(uploaded.text, "POST /api/intake/tax-return");
    if (
      parsedBody.readable !== true ||
      !Array.isArray(parsedBody.findings) ||
      parsedBody.findings.length === 0
    ) {
      throw new WalkthroughError(
        "the committed 1040 test fixture did not parse readably — the "
          + "income upload path is broken",
      );
    }
    this.scanResponse("tax-return upload", uploaded.text);
    this.log(
      `INCOME    POST /api/intake/tax-return → 200 — ${parsedBody.findings.length} `
        + `finding(s) parsed in memory (never stored, never a model), `
        + `monthly proposal: `
        + (parsedBody.monthlyDerived === null
          ? "none (the person types instead)"
          : parsedBody.monthlyDerived),
    );

    // Confirm-or-correct through the confirm route: the proposal ids are
    // confirmed (provenance tax_return) and one value is typed over
    // (provenance user). Both ride the standard answer store.
    const confirmations = (parsedBody.monthlyDerived === null
      ? []
      : [
          {
            questionId: "job_income_amount",
            action: "confirm",
            value: parsedBody.monthlyDerived,
          },
          {
            questionId: "job_income_frequency",
            action: "confirm",
            value: "monthly",
          },
        ]
    ).concat([
      { questionId: "benefits_income_amount", action: "correct", value: 300 },
    ]);
    const confirmed = await this.transport(
      this.base,
      "/api/intake/tax-return/confirm",
      { method: "POST", body: { confirmations }, cookie: this.cookie },
      this.timeoutMs,
    );
    if (confirmed.status !== 200) {
      throw new WalkthroughError(
        `tax-return confirm failed: ${confirmed.status} `
          + this.maskPrivateValues(confirmed.text.slice(0, 200)),
      );
    }
    const confirmedBody = parseJsonBody(confirmed.text, "POST /api/intake/tax-return/confirm");
    this.scanResponse("tax-return confirm", confirmed.text, confirmedBody.state);
    const savedRows = new Map(
      (Array.isArray(confirmedBody.saved) ? confirmedBody.saved : []).map(
        (row) => [row.questionId, row.provenance],
      ),
    );
    if (savedRows.get("benefits_income_amount") !== "user") {
      throw new WalkthroughError(
        "the income stage's typed-over value did not save with provenance user",
      );
    }
    if (parsedBody.monthlyDerived !== null && savedRows.get("job_income_amount") !== "tax_return") {
      throw new WalkthroughError(
        "the confirmed tax proposal did not save with provenance tax_return",
      );
    }
    for (const { questionId } of confirmations) {
      this.noteSavedAnswer(questionId, false);
    }
    this.state = confirmedBody.state;
    if (this.state?.income?.handled !== true) {
      throw new WalkthroughError(
        "the income stage saved its answers but the served state still "
          + "reports income unhandled — the results stage would never open",
      );
    }
    this.log(
      `INCOME    confirm → ${savedRows.size} answer(s) saved with `
        + "tax_return + user provenances — the served state reports income "
        + "handled, the results stage is reachable",
    );
  }

  /**
   * The visible purge's HTTP legs (HACK-80, VAL-DEMOEXP-006/007,
   * VAL-SPRINT-003): the unconfirmed call is refused and deletes
   * nothing; the confirmed call wipes every data row and its
   * deleted-count receipt is checked against the journey's own ledger;
   * `--db-verify` adds local psql row counts (before AND after) against
   * the compose Postgres; the resume + both form reviews then show the
   * empty, unstarted journey.
   */
  async purgeStage({ consented = true, dbVerify = false, dbRunner = psqlRowCounts } = {}) {
    // The session id the cookie carries (the token IS the session id —
    // src/lib/intake/store.ts loadSession). UUID-validated before any
    // psql interpolation.
    const sessionId = this.cookie?.startsWith(`${SESSION_COOKIE}=`)
      ? this.cookie.slice(SESSION_COOKIE.length + 1)
      : null;
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // 1. The unconfirmed call is refused — no purge without confirmation.
    const refused = await this.transport(
      this.base,
      "/api/session/purge",
      { method: "POST", body: {}, cookie: this.cookie },
      this.timeoutMs,
    );
    if (refused.status < 400) {
      this.recordViolation("purge_unconfirmed_accepted", {
        where: "POST /api/session/purge",
        detail: `the purge went through without {confirmed: true} (status ${refused.status})`,
      });
      return this.reportViolations();
    }
    this.log(
      `PURGE     POST /api/session/purge (no confirmation) → ${refused.status} `
        + "— refused, nothing deleted (VAL-DEMOEXP-007)",
    );

    // Local DB evidence, BEFORE the confirmed purge.
    if (dbVerify) {
      if (!sessionId || !uuidPattern.test(sessionId)) {
        throw new WalkthroughError(
          "--db-verify needs the session's UUID for the psql row counts; "
            + `the cookie holds: ${this.maskPrivateValues(String(sessionId))}`,
        );
      }
      const beforeCounts = await dbRunner(sessionId);
      this.log(`PURGE     DB row counts BEFORE (session ${sessionId}): ${JSON.stringify(beforeCounts)}`);
    }

    // 2. The confirmed purge — the receipt is checked against the ledger.
    const purged = await this.transport(
      this.base,
      "/api/session/purge",
      { method: "POST", body: { confirmed: true }, cookie: this.cookie },
      this.timeoutMs,
    );
    if (purged.status !== 200) {
      throw new WalkthroughError(
        `confirmed purge failed: ${purged.status} `
          + this.maskPrivateValues(purged.text.slice(0, 200)),
      );
    }
    const purgedBody = parseJsonBody(purged.text, "POST /api/session/purge");
    this.scanResponse("purge", purged.text);
    const deleted = purgedBody.deleted ?? {};
    const ledger = this.purgeLedger();
    const problems = [];
    if (purgedBody.purged !== true) {
      problems.push("the route did not report purged: true");
    }
    if (!Number.isFinite(deleted.answers) || deleted.answers < ledger.answers) {
      problems.push(
        `deleted.answers ${JSON.stringify(deleted.answers)} is short of the `
          + `${ledger.answers} answer(s) this journey saved`,
      );
    }
    if (!Number.isFinite(deleted.vaultEntries) || deleted.vaultEntries < ledger.vaultEntries) {
      problems.push(
        `deleted.vaultEntries ${JSON.stringify(deleted.vaultEntries)} is short of the `
          + `${ledger.vaultEntries} private answer(s) this journey saved`,
      );
    }
    if (consented && (!Number.isFinite(deleted.turns) || deleted.turns < 2 * this.turnsSent)) {
      problems.push(
        `deleted.turns ${JSON.stringify(deleted.turns)} is short of the `
          + `${2 * this.turnsSent} transcript row(s) this journey's `
          + `${this.turnsSent} turn(s) wrote`,
      );
    }
    if (problems.length > 0) {
      for (const problem of problems) {
        this.recordViolation("purge_incomplete", {
          where: "POST /api/session/purge",
          detail: problem,
        });
      }
      return this.reportViolations();
    }
    this.log(
      `PURGE     POST /api/session/purge {{confirmed: true}} → 200 — deleted `
        + `${deleted.answers} answer(s), ${deleted.vaultEntries} vault row(s), `
        + `${deleted.turns} transcript row(s), ${deleted.auditNotes ?? "?"} audit note(s)`,
    );

    // Local DB evidence, AFTER the confirmed purge: every data table must
    // be empty for this session.
    if (dbVerify) {
      const afterCounts = await dbRunner(sessionId);
      this.log(`PURGE     DB row counts AFTER: ${JSON.stringify(afterCounts)}`);
      const stillThere = Object.entries(afterCounts).filter(([, count]) => count !== 0);
      if (stillThere.length > 0) {
        for (const [table] of stillThere) {
          this.recordViolation("purge_incomplete", {
            where: "psql row counts",
            detail: `${table} still has rows for this session after the purge`,
          });
        }
        return this.reportViolations();
      }
      this.log(
        "PURGE     DB evidence: zero rows in answer, vault_entry, "
          + "conversation_turn, session_audit_note for this session",
      );
    }

    // 3. The client state resets: the resume shows the empty journey.
    const after = await this.resumeSession();
    if (Object.keys(after.answers ?? {}).length !== 0) {
      throw new WalkthroughError(
        "the resumed state still carries answers — the purge did not reset the client state",
      );
    }
    const qq = after.quickQuestions;
    if (qq && qq.remainingCount !== qq.requiredCount) {
      throw new WalkthroughError(
        `the post-purge quick-questions counter reads ${qq.remainingCount} of `
          + `${qq.requiredCount} — the reset journey must ask every required `
          + "question again",
      );
    }
    this.log(
      "PURGED    the resume shows the empty journey — every answer gone, "
        + "the quick-questions counter back to N = M",
    );

    // 4. Both forms' prepared state is gone: zero pre-filled fields.
    for (const formId of SPRINT_FORM_IDS) {
      const review = await this.getReview(formId);
      const prefilledCount = (Array.isArray(review.fields) ? review.fields : []).filter(
        (field) => field.state === "prefilled",
      ).length;
      if (prefilledCount !== 0) {
        throw new WalkthroughError(
          `the post-purge ${formId} review still pre-fills ${prefilledCount} `
            + "field(s) — the fill/review state did not clear",
        );
      }
    }
    this.log(
      "PURGED    both form reviews serve zero pre-filled fields — the "
        + "prepared applications are gone",
    );
  }

  /**
   * The SPRINT cross-journey proof (milestone snap-form part 4,
   * VAL-SPRINT-001..003): the full five-stage journey — Choose mode →
   * Quick questions → Talk → Income → Results — in ONE real session,
   * then the visible purge. Two consent paths:
   *
   * - voice-consented (default): the talk stage OPENS with a scripted
   *   spoken turn (the plan sentence rendered to WAV, the voice consent
   *   receipt attached) and then exits to typing — the sanctioned mode B;
   *   every send carries a receipt.
   * - declined-consent: ZERO conversation sends — the deterministic
   *   wizard covers every remaining question through the local answer
   *   route, and the match leg asks with no consent receipt at all.
   *
   * The results stage prepares BOTH real applications from the same
   * answers (review + fill per form, no re-asking — VAL-SPRINT-002), and
   * the purge legs prove the erasure covers the quick-question answers,
   * the tax-derived answers, and both forms' state (VAL-SPRINT-003).
   *
   * @param {{plan?: object[], consent?: "voice"|"declined", dbVerify?:
   *   boolean, audioGenerator?: (text: string) => Promise<Uint8Array>,
   *   dbRunner?: (sessionId: string) => Promise<Record<string, number>>,
   *   unmappedAnswers?: object, uploadBytes?: Uint8Array}} [options]
   *   injectables for the unit tests
   */
  async runSprintJourney(options = {}) {
    const {
      plan = CONVERSATION_PLAN,
      consent = "voice",
      dbVerify = false,
      audioGenerator = (text) => scriptedWavBytes(text),
      dbRunner = psqlRowCounts,
      unmappedAnswers = SPRINT_FORM_UNMAPPED_ANSWERS,
      uploadBytes,
    } = options;
    const declined = consent === "declined";
    this.log(
      `WALKTHROUGH target ${this.base} — sprint cross-journey `
        + `(${declined ? "declined-consent deterministic" : "voice-consented"} path): `
        + "choose mode → quick questions → talk → income → results → purge",
    );

    // Stage 1 — Choose mode: the session IS the entry stage; the mode
    // choice is the consent decision every later send must honor.
    await this.startSession();
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    this.log(
      "STAGE 1   Choose mode — "
        + (declined
          ? "the zero-send deterministic wizard (no AI receipt anywhere)"
          : "mode B: voice with exit-to-typing — a scripted audio turn, then typed turns"),
    );

    // Stage 2 — Quick questions: the sensitive screen answered through
    // the stage's own route (the answer route, never the model).
    this.log(
      "STAGE 2   Quick questions — the pending required questions the "
        + "quick-questions stage captures, through the answer route (no model)",
    );
    await this.answerWorkRequirementsLocally();
    if (this.violations.length > 0) {
      return this.reportViolations();
    }

    // Stage 3 — Talk: the conversation's typed turns (or, on the declined
    // path, the deterministic wizard covering every remaining question
    // with zero sends).
    if (declined) {
      this.log(
        "STAGE 3   Talk — the deterministic path: every remaining question "
          + "through the answer route with ZERO conversation sends",
      );
      const { stopped } = await this.answerFlowLocally();
      if (stopped || this.violations.length > 0) {
        return this.reportViolations();
      }
      this.log(
        "TALK      the talk stage completed with zero conversation sends — "
          + "consent refusal never blocked the journey (HACK-81)",
      );
    } else {
      this.log("STAGE 3   Talk — the conversation's turns (scripted audio first, then typed)");
      await this.runTurnLoop(plan, "sprint talk", { audioFirstTurn: true, audioGenerator });
      if (this.violations.length > 0) {
        return this.reportViolations();
      }
    }

    // Stage 4 — Income: upload + confirm-or-correct (both real paths).
    this.log(
      "STAGE 4   Income — the 1040 upload's deterministic parse, then "
        + "confirm-or-correct",
    );
    await this.incomeStage({ uploadBytes });
    if (this.violations.length > 0) {
      return this.reportViolations();
    }

    // Stage 5 — Results: one session prepares BOTH applications.
    this.log(
      `STAGE 5   Results — one session prepares both applications `
        + `(${SPRINT_FORM_IDS.join(" + ")}), ask-once`,
    );
    await this.getMatch({ consented: !declined });
    if (this.violations.length > 0) {
      return this.reportViolations();
    }
    for (const formId of SPRINT_FORM_IDS) {
      const review = await this.getReview(formId);
      if (this.violations.length > 0) {
        return this.reportViolations();
      }
      const prefilledCount = this.assertReviewCarryover(review, formId);
      this.log(
        `REUSE     ${formId}: ${prefilledCount} field(s) pre-filled from this `
          + "session's answers — no answered question re-asked",
      );
      await this.fillForm(formId, unmappedAnswers[formId]);
      if (this.violations.length > 0) {
        return this.reportViolations();
      }
    }

    // The visible purge: refusal, confirmed erasure, client-state reset.
    await this.purgeStage({ consented: !declined, dbVerify, dbRunner });
    if (this.violations.length > 0) {
      return this.reportViolations();
    }

    await this.endHealthCheck();
    this.summarizePlan(plan, "sprint talk plan");
    this.log("WALKTHROUGH PASSED");
    return true;
  }

  /** The journey's shared opening: health check + session creation. The
   * violation scan records; the caller checks and stops the walk. */
  async startSession() {
    const health = await this.transport(this.base, "/api/health", {}, this.timeoutMs);
    const healthBody = parseJsonBody(health.text, "GET /api/health");
    this.log(`HEALTH    GET /api/health → ${health.status} ${JSON.stringify(healthBody)}`);
    if (health.status !== 200 || healthBody.ok !== true) {
      throw new WalkthroughError(
        `health check failed: ${health.status} ${this.maskPrivateValues(health.text.slice(0, 200))}`,
      );
    }
    this.scanResponse("GET /api/health", health.text);

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
    if (!createdBody.state || typeof createdBody.state !== "object") {
      throw new WalkthroughError("session creation returned no client state");
    }
    this.scanResponse("create session", created.text, createdBody.state);
    this.state = createdBody.state;
  }

  /** POST /api/session on the existing token — the "Save and finish
   * later" step; returns the saved client state. */
  async saveSession() {
    const saved = await this.transport(
      this.base,
      "/api/session",
      { method: "POST", body: {}, cookie: this.cookie },
      this.timeoutMs,
    );
    this.log(`SAVE      POST /api/session → ${saved.status} (progress saved)`);
    if (saved.status !== 200) {
      throw new WalkthroughError(`save failed: ${saved.status} ${this.maskPrivateValues(saved.text.slice(0, 200))}`);
    }
    const savedBody = parseJsonBody(saved.text, "POST /api/session");
    this.scanResponse("save", saved.text, savedBody.state);
    return savedBody.state;
  }

  /** GET /api/session with the captured token — resuming after exit. */
  async resumeSession() {
    const resumed = await this.transport(
      this.base,
      "/api/session",
      { cookie: this.cookie },
      this.timeoutMs,
    );
    this.log(`RESUME    GET /api/session → ${resumed.status}`);
    if (resumed.status !== 200) {
      throw new WalkthroughError(
        `resume failed: ${resumed.status} ${this.maskPrivateValues(resumed.text.slice(0, 200))}`,
      );
    }
    const resumedBody = parseJsonBody(resumed.text, "GET /api/session");
    this.scanResponse("resume", resumed.text, resumedBody.state);
    return resumedBody.state;
  }

  /** The journey's shared closing health check. */
  async endHealthCheck() {
    const finalHealth = await this.transport(this.base, "/api/health", {}, this.timeoutMs);
    this.log(`HEALTH    GET /api/health → ${finalHealth.status}`);
    if (finalHealth.status !== 200) {
      throw new WalkthroughError(`final health check failed: ${finalHealth.status}`);
    }
  }

  summarizeSkips(skippedBy) {
    this.log(
      "SUMMARY   skipped by the flow: " +
        (skippedBy.size === 0
          ? "(none)"
          : [...skippedBy.entries()]
              .map(([id, cause]) => `${id} (after ${cause})`)
              .join(", ")),
    );
  }

  summarizePlan(plan, label) {
    const counts = { known: 0, unknown: 0, unverified: 0 };
    for (const step of plan) {
      if (counts[step.intent] !== undefined) {
        counts[step.intent] += 1;
      }
    }
    this.log(
      `SUMMARY   ${label} intended mix: ` +
        Object.entries(counts)
          .map(([status, count]) => `${count} ${ANSWER_STATUS_LABELS[status]}`)
          .join(" · "),
    );
    this.log(
      "SUMMARY   private values submitted: " +
        `${this.privateValues.length} (checked: never echoed in any body, `
          + "redaction verified per turn)",
    );
    this.log("SUMMARY   violations: none");
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

  /**
   * The wizard's answer loop: answer whatever question the flow shows
   * next through the local answer route (POST /api/intake/answer — no
   * model in the loop), observing the skip behavior, tracking private
   * free-form values, and checking the quick-questions counter after
   * every answer. Shared by the wizard journey (run) and the sprint
   * journey's DECLINED talk stage (the deterministic zero-send path).
   *
   * @returns {Promise<{answerNumber: number, skippedBy: Map<string,
   *   string>, stopped: boolean}>} stopped=true when a violation ended
   *   the loop (the caller reports and stops the walk)
   */
  async answerFlowLocally() {
    let state = this.state;
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
          `answer ${step.id} rejected: ${answer.status} ${this.maskPrivateValues(answer.text.slice(0, 200))}`,
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
      this.noteSavedAnswer(step.id, isPii && step.status !== "unknown");
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
        return { answerNumber, skippedBy, stopped: true };
      }
      const counterProblem = quickQuestionsCounterProblem(state, newState, step.id);
      if (counterProblem) {
        this.recordViolation("quick_questions_counter", {
          where: `answer ${step.id}`,
          detail: counterProblem,
        });
        return { answerNumber, skippedBy, stopped: true };
      }
      state = newState;
      this.state = newState;
    }
    return { answerNumber, skippedBy, stopped: false };
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
        `health check failed: ${health.status} ${this.maskPrivateValues(health.text.slice(0, 200))}`,
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
    this.state = createdBody.state;
    const { answerNumber, skippedBy, stopped } = await this.answerFlowLocally();
    if (stopped || this.violations.length > 0) {
      return this.reportViolations();
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
        `save failed: ${saved.status} ${this.maskPrivateValues(saved.text.slice(0, 200))}`,
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
        `resume failed: ${resumed.status} ${this.maskPrivateValues(resumed.text.slice(0, 200))}`,
      );
    }
    if (this.scanResponse("resume", resumed.text, resumedBody.state)) {
      return this.reportViolations();
    }
    // The save response is the server's own current view of the session —
    // the baseline the resume must restore identically.
    if (!deepEqual(savedBody.state ?? this.state, resumedBody.state)) {
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
    "Usage: pnpm walkthrough [--mode <wizard|conversation|form>]" +
      " [--url <base-url>] [--timeout <ms>]",
    "",
    "Walks a full user journey over HTTP against a running Benefits",
    "Navigator: create session, mixed tri-state answers, observed skips,",
    "save, exit, resume, transcript with honest-status labels.",
    "",
    "Modes:",
    "  wizard (default)   The step-by-step wizard journey: intake answers",
    "                     through /api/intake, skips, save, resume.",
    "  conversation       The v2 conversational journey (text mode): typed",
    "                     turns driving the conversation with a realistic",
    "                     tri-state mix (known answers that trigger skips,",
    "                     'not sure', and unverified attempts), benefit",
    "                     match, prepared-form review with the skip",
    "                     behavior, save, resume via the session token,",
    "                     then the PDF download leg.",
    "  form               The v2 form-driven journey against the committed",
    "                     sample form registry: the form's questions asked",
    "                     through the conversation, mapped fields",
    "                     pre-filled from the session's answers, then the",
    "                     filled-PDF download.",
    "  sprint             The sprint cross-journey proof: the full",
    "                     five-stage journey (Choose mode → Quick",
    "                     questions → Talk → Income → Results) in ONE",
    "                     session, both real applications prepared from",
    "                     the same answers (review + fill each), then the",
    "                     visible purge with its receipt checked against",
    "                     the journey's own ledger. --consent voice (the",
    "                     default) opens the talk stage with a scripted",
    "                     spoken turn (say + afconvert → the STT route);",
    "                     --consent declined runs the deterministic path",
    "                     with ZERO conversation sends. --db-verify adds",
    "                     local psql row counts (before/after the purge)",
    "                     against the compose Postgres.",
    "",
    "The v2 typed turns send the AI consent receipt (voice off), the same",
    "grant the consent surface's typed path gives. Assistant replies are",
    "banned-claim-checked, and every client payload (subtitles, redacted",
    "transcripts, state) is pii-echo-checked; the redaction of each typed",
    "private value is verified.",
    "",
    "Options:",
    "  --url <base-url>   Target app (default: http://localhost:3100).",
    "                     Any deployed URL works, e.g. the Vercel",
    "                     production or preview deployment.",
    "  --timeout <ms>     Per-request timeout (default: 30000 wizard,",
    "                     90000 for the v2 and sprint modes — each typed",
    "                     turn runs live model calls).",
    "  --mode <mode>      wizard | conversation | form | sprint",
    "                     (default: wizard).",
    "  --consent <path>   sprint mode only: voice (default) | declined.",
    "                     The declined path makes ZERO conversation sends",
    "                     — the deterministic wizard completes the journey.",
    "  --db-verify        sprint mode only: verify the purge with local",
    "                     docker exec psql row counts (before/after).",
    "  --help             Show this help.",
    "",
    "Exit codes: 0 clean journey, 1 violation detected (the transcript",
    "names what and where), 2 journey error (bad URL, failed request,",
    "unexpected question).",
  ].join("\n");
}

/** Parse CLI arguments; returns null when --help was handled (usage was
 * printed). Throws WalkthroughError on anything unrecognized. */
export function parseArgs(argv) {
  const options = {
    url: DEFAULT_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    mode: "wizard",
    consent: "voice",
    dbVerify: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      return null;
    } else if (arg === "--url") {
      options.url = argv[++index];
    } else if (arg === "--timeout") {
      options.timeoutMs = Number(argv[++index]);
      options.timeoutExplicit = true;
    } else if (arg === "--mode") {
      options.mode = argv[++index];
    } else if (arg === "--consent") {
      options.consent = argv[++index];
    } else if (arg === "--db-verify") {
      options.dbVerify = true;
    } else {
      throw new WalkthroughError(`unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (!["wizard", "conversation", "form", "sprint"].includes(options.mode)) {
    throw new WalkthroughError(
      `--mode must be wizard, conversation, form, or sprint — got: ${options.mode}`,
    );
  }
  // The sprint-only options bite on misuse: a typo'd mode should never
  // silently run the wrong consent path or skip the DB evidence.
  if (!["voice", "declined"].includes(options.consent)) {
    throw new WalkthroughError(
      `--consent must be voice or declined — got: ${options.consent}`,
    );
  }
  if (options.consent !== "voice" && options.mode !== "sprint") {
    throw new WalkthroughError("--consent applies only to --mode sprint");
  }
  if (options.dbVerify && options.mode !== "sprint") {
    throw new WalkthroughError("--db-verify applies only to --mode sprint");
  }
  // The v2 modes run two live model calls per turn; their default timeout
  // is higher. An explicit --timeout always wins.
  if (!options.timeoutExplicit && options.mode !== "wizard") {
    options.timeoutMs = V2_TIMEOUT_MS;
  }
  delete options.timeoutExplicit;
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
    let completed;
    if (options.mode === "conversation") {
      completed = await walk.runConversation();
    } else if (options.mode === "form") {
      completed = await walk.runFormJourney();
    } else if (options.mode === "sprint") {
      completed = await walk.runSprintJourney({
        consent: options.consent,
        dbVerify: options.dbVerify,
      });
    } else {
      completed = await walk.run();
    }
    process.exitCode = exitCodeForRun(completed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${new Date().toISOString()}] JOURNEY ERROR ${message}`);
    console.error(`[${new Date().toISOString()}] WALKTHROUGH FAILED`);
    process.exitCode = EXIT_JOURNEY_ERROR;
  }
}
