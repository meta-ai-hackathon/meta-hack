#!/usr/bin/env node
// BN-38 evaluation record CLI (HACK-60).
//
// Runs the frozen, labeled cases in eval-cases.mjs against a running Benefits
// Navigator, scores each one (eval-record-core.mjs), and writes the
// markdown record that states its denominator and lists every negative:
//
//   node scripts/eval-record.mjs                       # http://localhost:3100, record to stdout
//   node scripts/eval-record.mjs --url https://meta-hack-omega.vercel.app \
//     --commit <sha served> --out docs/evaluation-record.md
//
// Like walkthrough.mjs it talks to the app over HTTP only, never an app
// import, so it measures whatever that surface serves. Each category of
// cases gets its own fresh session: the answer turns walk the whole flow in
// one, and each probe category shares one. Every typed turn carries the
// typed-path AI consent receipt the walkthrough sends (voice off), and every
// synthetic session is purged through /api/session/purge at the end, even
// when a run fails partway.
//
// Nothing private is printed or written: the console shows case ids and
// outcome codes, and the record shows the probes' own text, outcome codes
// and HTTP status codes. Replies and response bodies stay in memory.
//
// Exit codes: 0 record written and every session purged, 1 a purge failed
// (synthetic rows may be left behind), 2 usage error or the run could not
// finish, 3 no case ran at all. A run where nothing ran never overwrites
// the --out file unless --force is given, so an outage cannot replace a
// real record with an empty one.
//
// Node built-ins only. Node >= 22.

import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_URL,
  EXIT_OK,
  TURN_ATTEMPTS,
  TURN_RETRY_WAIT_MS,
  V2_TIMEOUT_MS,
  consentHeaderValue,
  http,
  parseJsonBody,
  sessionCookieFrom,
} from "./walkthrough-core.mjs";
import { CONVERSATION_PLAN } from "./walkthrough-plans.mjs";
import { EVAL_CASES } from "./eval-cases.mjs";
import {
  CATEGORIES,
  RECORD_MODEL,
  buildRecord,
  renderRecord,
  scoreCase,
} from "./eval-record-core.mjs";

export { EXIT_OK };
export const EXIT_PURGE_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOTHING_RAN = 3;

/** The conversation engine's cap is MAX_TURNS_PER_WINDOW user turns per
 * TURN_RATE_WINDOW_SECONDS per session (src/lib/conversation.ts); the
 * harness paces one under it, the same way the walkthrough does. The
 * walkthrough keeps its own copies private and this PR only adds one export
 * to that file, so these are pinned to the engine's values by a drift test
 * in eval-record-core.test.mjs instead. */
export const TURN_WINDOW_MS = 60_000;
export const TURN_PACE_LIMIT = 11;
/** The statuses worth a patient retry, the same set the walkthrough's
 * fetch helper and turn loop retry on. */
export const TRANSIENT_STATUSES = Object.freeze([429, 502, 503, 504]);
/** A runaway guard for the answer-turn loop (the spec has 37 questions). */
const MAX_FLOW_STEPS = 120;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** parseJsonBody, minus its error message: that message quotes the body,
 * and no body text may reach the console or the record. */
function safeJson(text, what) {
  try {
    return parseJsonBody(text, what);
  } catch {
    return null;
  }
}

/** The taxonomy error code of an error body (a closed vocabulary), or null. */
function errorCodeOf(text) {
  const body = safeJson(text, "error body");
  const errorCode = body?.error?.code;
  return typeof errorCode === "string" && /^[a-z_]{1,40}$/.test(errorCode) ? errorCode : null;
}

function cookieOf(result) {
  try {
    return result?.response ? sessionCookieFrom(result.response) : null;
  } catch {
    return null;
  }
}

function replyOf(body) {
  return typeof body?.assistantReply === "string" ? body.assistantReply : "";
}

function failureOf(status, text, fallbackCode) {
  const errorCode = errorCodeOf(text) ?? fallbackCode;
  return {
    reason: errorCode === "model_unavailable" ? "model_unavailable" : "http_error",
    status,
    errorCode,
  };
}

class EvalRun {
  constructor({ base, timeoutMs, transport, sleepFn, nowFn, log }) {
    this.base = base;
    this.timeoutMs = timeoutMs;
    this.transport = transport;
    this.sleepFn = sleepFn;
    this.nowFn = nowFn;
    this.log = log;
    this.stats = {
      turnsCompleted: 0,
      turnRequestsFailed: 0,
      sessionsOpened: 0,
      sessionsPurged: 0,
      unstuckQuestions: 0,
      branchQuestionsAsked: [],
    };
  }

  say(line) {
    this.log(`[${new Date(this.nowFn()).toISOString()}] ${line}`);
  }

  async healthCheck() {
    try {
      const response = await this.transport(this.base, "/api/health", {}, this.timeoutMs);
      const body = safeJson(response.text, "GET /api/health");
      this.say(`HEALTH    GET /api/health → ${response.status}`);
      if (response.status === 200 && body?.ok === true) {
        return { ok: true };
      }
      return { ok: false, failure: { reason: "http_error", status: response.status, errorCode: "health_check_failed" } };
    } catch {
      this.say("HEALTH    GET /api/health failed (network)");
      return { ok: false, failure: { reason: "http_error", errorCode: "network" } };
    }
  }

  /** POST /api/session: a fresh synthetic session for one category. */
  async openSession(label) {
    let response;
    try {
      response = await this.transport(this.base, "/api/session", { method: "POST", body: {} }, this.timeoutMs);
    } catch {
      return { ok: false, failure: { reason: "http_error", errorCode: "network" } };
    }
    const cookie = cookieOf(response);
    const body = safeJson(response.text, "POST /api/session");
    const session = { cookie, state: body?.state, turnTimes: [], purged: false, label };
    if (cookie) {
      this.stats.sessionsOpened += 1;
    }
    this.say(`SESSION   ${label}: POST /api/session → ${response.status}`);
    if (response.status !== 201 || !cookie || !body?.state || typeof body.state !== "object") {
      return {
        ok: false,
        session: cookie ? session : null,
        failure: failureOf(response.status, response.text, "session_not_created"),
      };
    }
    return { ok: true, session };
  }

  /** POST /api/session/purge with the explicit confirmation. */
  async purgeSession(session) {
    try {
      const response = await this.transport(
        this.base,
        "/api/session/purge",
        { method: "POST", body: { confirmed: true }, cookie: session.cookie },
        this.timeoutMs,
      );
      const body = safeJson(response.text, "POST /api/session/purge");
      if (response.status === 200 && body?.purged === true) {
        session.purged = true;
        this.stats.sessionsPurged += 1;
        this.say(`PURGED    ${session.label}: POST /api/session/purge → ${response.status}`);
        return;
      }
      this.say(`PURGE FAILED ${session.label}: POST /api/session/purge → ${response.status}`);
    } catch {
      this.say(`PURGE FAILED ${session.label}: network`);
    }
  }

  /** Stay one under the engine's per-session turn cap. */
  async pace(session) {
    const now = this.nowFn();
    session.turnTimes = session.turnTimes.filter((time) => now - time < TURN_WINDOW_MS);
    if (session.turnTimes.length >= TURN_PACE_LIMIT) {
      const wait = TURN_WINDOW_MS - (now - session.turnTimes[0]) + 250;
      if (wait > 0) {
        this.say(`PAUSE     ${Math.ceil(wait / 1000)}s to stay under the per-minute turn cap`);
        await this.sleepFn(wait);
      }
      const fresh = this.nowFn();
      session.turnTimes = session.turnTimes.filter((time) => fresh - time < TURN_WINDOW_MS);
    }
    session.turnTimes.push(this.nowFn());
  }

  /**
   * One typed turn with the AI consent receipt (voice off). A throttled or
   * unavailable model gets the walkthrough's patient retries; whatever
   * still fails is a not-run outcome for the case, never a guess.
   */
  async sendTurn(session, text) {
    let failure = null;
    for (let attempt = 1; attempt <= TURN_ATTEMPTS; attempt++) {
      // Every attempt is a real server turn, so retries are paced too.
      await this.pace(session);
      let response;
      try {
        response = await this.transport(
          this.base,
          "/api/conversation/turn",
          {
            method: "POST",
            body: { text },
            cookie: session.cookie,
            headers: { "x-bn-consent": consentHeaderValue() },
          },
          this.timeoutMs,
        );
      } catch {
        this.stats.turnRequestsFailed += 1;
        failure = { reason: "http_error", errorCode: "network" };
        if (attempt < TURN_ATTEMPTS) {
          this.say(`RETRY     turn request failed (network); waiting ${TURN_RETRY_WAIT_MS / 1000}s`);
          await this.sleepFn(TURN_RETRY_WAIT_MS);
        }
        continue;
      }
      const cookie = cookieOf(response);
      if (cookie) {
        session.cookie = cookie;
      }
      if (response.status === 200) {
        const body = safeJson(response.text, "POST /api/conversation/turn");
        if (body && typeof body === "object" && body.state && typeof body.state === "object") {
          this.stats.turnsCompleted += 1;
          return { ok: true, body };
        }
        this.stats.turnRequestsFailed += 1;
        return { ok: false, failure: { reason: "http_error", status: 200, errorCode: "unexpected_body" } };
      }
      this.stats.turnRequestsFailed += 1;
      failure = failureOf(response.status, response.text, null);
      if (!TRANSIENT_STATUSES.includes(response.status) || attempt === TURN_ATTEMPTS) {
        break;
      }
      this.say(
        `RETRY     turn returned HTTP ${response.status}; waiting ${TURN_RETRY_WAIT_MS / 1000}s`,
      );
      await this.sleepFn(TURN_RETRY_WAIT_MS);
    }
    return { ok: false, failure };
  }

  /** After a miss: the wizard's own answer route marks the question not
   * sure, so the flow can move on to the next case. */
  async markNotSure(session, questionId) {
    try {
      const response = await this.transport(
        this.base,
        "/api/intake/answer",
        { method: "POST", body: { questionId, status: "unknown", value: null }, cookie: session.cookie },
        this.timeoutMs,
      );
      const body = safeJson(response.text, "POST /api/intake/answer");
      if (response.status === 200 && body && Array.isArray(body.questions)) {
        this.stats.unstuckQuestions += 1;
        return { ok: true, state: body };
      }
      return { ok: false, failure: failureOf(response.status, response.text, "unstick_failed") };
    } catch {
      return { ok: false, failure: { reason: "http_error", errorCode: "network" } };
    }
  }

  logOutcome(testCase, observation) {
    this.say(`CASE      ${testCase.id} → ${scoreCase(testCase, observation).outcome}`);
  }

  /** The probe categories: every probe typed in turn in one fresh session. */
  async runProbes(session, cases, observations) {
    let stopped = false;
    for (const testCase of cases) {
      if (stopped) {
        observations.set(testCase.id, { ran: false, reason: "stopped_after_failure" });
        continue;
      }
      const result = await this.sendTurn(session, testCase.text);
      const observation = result.ok
        ? { ran: true, responses: [{ reply: replyOf(result.body), body: result.body }], privateValues: [] }
        : { ran: false, ...result.failure };
      observations.set(testCase.id, observation);
      this.logOutcome(testCase, observation);
      stopped = !result.ok;
    }
  }

  /**
   * The answer turns: walk the whole flow in one session, typing each plan
   * turn when the flow asks its question, with one plainer retry when
   * nothing saved (the walkthrough's loop, minus the printed replies).
   */
  async runAnswerTurns(session, cases, plan, observations) {
    const caseByQuestion = new Map(cases.map((testCase) => [testCase.questionId, testCase]));
    const planById = new Map(plan.map((step) => [step.id, step]));
    const privateValues = [];
    const asked = new Set();
    let state = session.state;
    let failure = null;
    for (let steps = 0; steps < MAX_FLOW_STEPS && state?.complete !== true; steps++) {
      const question =
        Number.isInteger(state?.currentIndex) && Array.isArray(state?.questions)
          ? state.questions[state.currentIndex]
          : undefined;
      if (!question || typeof question.id !== "string") {
        failure = { reason: "http_error", errorCode: "stuck_flow" };
        break;
      }
      const step = planById.get(question.id);
      if (!step || asked.has(question.id)) {
        failure = { reason: "http_error", errorCode: step ? "repeated_question" : "uncovered_question" };
        break;
      }
      asked.add(question.id);
      const testCase = caseByQuestion.get(question.id);
      if (!testCase) {
        this.stats.branchQuestionsAsked.push(question.id);
      }
      if (question.pii === true && typeof step.privateValue === "string" && step.privateValue.trim() !== "") {
        // Tracked before it is typed: every body from here on is checked
        // for it, and it never reaches the console or the record.
        privateValues.push(step.privateValue);
      }
      const bodies = [];
      let result = await this.sendTurn(session, step.text);
      if (result.ok) {
        bodies.push(result.body);
        state = result.body.state;
        if (state.answers?.[question.id] === undefined) {
          result = await this.sendTurn(session, step.retry ?? step.text);
          if (result.ok) {
            bodies.push(result.body);
            state = result.body.state;
          }
        }
      }
      if (!result.ok) {
        failure = result.failure;
        if (testCase) {
          // A first response that already broke a rule is scored from what
          // it showed, so a failed retry can never hide a violation as not
          // run. Without one, the case could not finish: not run.
          const partial = {
            ran: true,
            responses: bodies.map((body) => ({ reply: replyOf(body), body })),
            privateValues: [...privateValues],
            saved: null,
          };
          const flagged = bodies.length > 0 && scoreCase(testCase, partial).flags.length > 0;
          observations.set(testCase.id, flagged ? partial : { ran: false, ...failure });
          this.logOutcome(testCase, observations.get(testCase.id));
        }
        break;
      }
      const saved = state.answers?.[question.id];
      if (testCase) {
        observations.set(testCase.id, {
          ran: true,
          responses: bodies.map((body) => ({ reply: replyOf(body), body })),
          privateValues: [...privateValues],
          saved: saved ?? null,
        });
        this.logOutcome(testCase, observations.get(testCase.id));
      } else {
        this.say(`BRANCH    the flow asked ${question.id}, a branch-only plan turn (not scored)`);
      }
      if (saved === undefined) {
        const unstuck = await this.markNotSure(session, question.id);
        if (!unstuck.ok) {
          failure = unstuck.failure;
          break;
        }
        state = unstuck.state;
      }
    }
    if (failure === null && state?.complete !== true) {
      failure = { reason: "http_error", errorCode: "flow_did_not_finish" };
    }
    // The cases the loop never typed: answered by an earlier turn (scored
    // on what was saved), never asked by the flow, or cut off by a failure.
    for (const testCase of cases) {
      if (observations.has(testCase.id)) {
        continue;
      }
      const saved = state?.answers?.[testCase.questionId];
      const observation =
        saved !== undefined && saved !== null
          ? { ran: true, responses: [], privateValues: [...privateValues], saved, answeredEarlier: true }
          : { ran: false, reason: failure === null ? "not_asked_by_flow" : "stopped_after_failure" };
      observations.set(testCase.id, observation);
      this.logOutcome(testCase, observation);
    }
  }
}

/**
 * Run every case against the app at `base` and return the observations
 * plus the run facts the record states. The transport, clock and sleep are
 * injectable so eval-record-core.test.mjs can drive a fake app.
 */
export async function runEvaluation({
  base,
  timeoutMs = V2_TIMEOUT_MS,
  cases = EVAL_CASES,
  plan = CONVERSATION_PLAN,
  transport = http,
  sleepFn = defaultSleep,
  nowFn = () => Date.now(),
  log = (line) => console.log(line),
}) {
  const run = new EvalRun({ base, timeoutMs, transport, sleepFn, nowFn, log });
  const startedAt = new Date(nowFn()).toISOString();
  const observations = new Map();
  const health = await run.healthCheck();
  for (const category of CATEGORIES) {
    const inCategory = cases.filter((testCase) => testCase.category === category);
    if (inCategory.length === 0) {
      continue;
    }
    const opened = health.ok ? await run.openSession(category) : { ok: false, failure: health.failure };
    try {
      if (!opened.ok) {
        for (const testCase of inCategory) {
          observations.set(testCase.id, { ran: false, ...opened.failure });
          run.logOutcome(testCase, observations.get(testCase.id));
        }
        continue;
      }
      if (category === "answer_turn") {
        await run.runAnswerTurns(opened.session, inCategory, plan, observations);
      } else {
        await run.runProbes(opened.session, inCategory, observations);
      }
    } finally {
      if (opened.session) {
        await run.purgeSession(opened.session);
      }
    }
  }
  return {
    observations,
    meta: {
      startedAt,
      target: base,
      model: RECORD_MODEL,
      ...run.stats,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export function usage() {
  return [
    "Usage: node scripts/eval-record.mjs [--url <base-url>] [--commit <sha>] [--out <file>] [--force] [--timeout <ms>]",
    "",
    "Runs the frozen, labeled cases in scripts/eval-cases.mjs against a running",
    "Benefits Navigator over HTTP, scores each one, and writes the BN-38",
    "evaluation record: its denominator, counts per category, and every",
    "negative case. Each category runs in a fresh synthetic session that is",
    "purged at the end. Typed turns only, with the AI consent receipt (voice off).",
    "",
    "Options:",
    `  --url <base-url>   Target app (default: ${DEFAULT_URL}).`,
    "  --commit <sha>     The main commit the target serves, for the record. The",
    "                     app does not report its build, so check the head of",
    "                     main and its finished production deployment first.",
    "  --out <file>       Write the record here (relative path) instead of stdout.",
    "  --force            Write --out even when no case ran (an outage).",
    `  --timeout <ms>     Per-request timeout (default: ${V2_TIMEOUT_MS}).`,
    "  --help             Show this help.",
    "",
    "Exit codes: 0 record written and every session purged, 1 a purge failed,",
    "2 usage error or the run could not finish, 3 no case ran (then --out is",
    "left untouched unless --force is given).",
  ].join("\n");
}

/**
 * What to do with a finished run: whether to write the --out file, and the
 * exit code. A failed purge outranks everything, because synthetic rows may
 * be left in a shared database. A run where no case ran leaves --out alone
 * unless --force is given.
 */
export function finishRun(record, meta, options) {
  const nothingRan = record.denominator > 0 && record.totals.not_run === record.denominator;
  const purgeFailed = meta.sessionsPurged !== meta.sessionsOpened;
  return {
    writeOut: options.out !== null && (!nothingRan || options.force === true),
    exitCode: purgeFailed ? EXIT_PURGE_FAILED : nothingRan ? EXIT_NOTHING_RAN : EXIT_OK,
    nothingRan,
  };
}

/** Parse CLI arguments; null when --help was handled. */
export function parseArgs(argv) {
  const options = { url: DEFAULT_URL, commit: null, out: null, timeoutMs: V2_TIMEOUT_MS, force: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help") {
      console.log(usage());
      return null;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--url" || arg === "--commit" || arg === "--out" || arg === "--timeout") {
      const value = argv[++index];
      if (value === undefined) {
        throw new UsageError(`${arg} needs a value\n\n${usage()}`);
      }
      if (arg === "--url") {
        options.url = value;
      } else if (arg === "--commit") {
        options.commit = value;
      } else if (arg === "--out") {
        options.out = value;
      } else {
        options.timeoutMs = Number(value);
      }
      continue;
    }
    throw new UsageError(`unknown argument: ${arg}\n\n${usage()}`);
  }
  if (typeof options.url !== "string" || !/^https?:\/\/[^\s]+$/.test(options.url)) {
    throw new UsageError(`--url must be an http(s) URL, got: ${options.url}`);
  }
  options.url = options.url.replace(/\/+$/, "");
  if (options.commit !== null && !/^[0-9a-f]{7,40}$/.test(options.commit)) {
    throw new UsageError("--commit must be a 7 to 40 character lowercase hex commit id");
  }
  if (options.out !== null && (options.out.startsWith("/") || options.out.includes(".."))) {
    throw new UsageError("--out must be a path relative to the current directory, without ..");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new UsageError("--timeout must be a positive number of ms");
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof UsageError ? error.message : "EVAL ERROR could not read the arguments");
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (options === null) {
    process.exitCode = EXIT_OK;
    return;
  }
  try {
    const { observations, meta } = await runEvaluation({ base: options.url, timeoutMs: options.timeoutMs });
    const record = buildRecord(EVAL_CASES, observations, {
      ...meta,
      commit: options.commit,
      out: options.out,
    });
    const markdown = renderRecord(record);
    const finish = finishRun(record, meta, options);
    if (finish.writeOut) {
      await writeFile(options.out, markdown, "utf8");
      console.log(`[${new Date().toISOString()}] WROTE     ${options.out}`);
    } else if (options.out !== null) {
      console.error(
        `[${new Date().toISOString()}] NOTHING RAN ${options.out} left untouched; pass --force to write it anyway`,
      );
    } else {
      process.stdout.write(markdown);
    }
    const totals = Object.entries(record.totals)
      .map(([outcome, n]) => `${outcome} ${n}`)
      .join(", ");
    console.error(
      `[${new Date().toISOString()}] SUMMARY   ${record.denominator} cases: ${totals}; `
        + `negatives ${record.negatives.length}; sessions purged ${meta.sessionsPurged} of ${meta.sessionsOpened}`,
    );
    process.exitCode = finish.exitCode;
  } catch (error) {
    // Only the error's kind: no message from a failed run may quote a body.
    console.error(`[${new Date().toISOString()}] EVAL ERROR ${error instanceof Error ? error.name : "unknown"}`);
    process.exitCode = EXIT_USAGE;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("unhandledRejection", () => {
    console.error("EVAL ERROR unhandled rejection");
    process.exit(EXIT_USAGE);
  });
  await main();
}
