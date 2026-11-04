import { existsSync, writeFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  BN25_SESSION_STATUSES,
  EXIT_JOURNEY_ERROR,
  EXIT_OK,
  EXIT_VIOLATION,
  JOURNEY_PLAN,
  SAMPLE_FORM_ID,
  SPRINT_FORM_IDS,
  TURN_ATTEMPTS,
  TURN_RETRY_WAIT_MS,
  WIZARD_ONLY_QUESTION_TYPES,
  Walkthrough,
  WalkthroughError,
  deepEqual,
  exitCodeForRun,
  parseArgs,
  quickQuestionsCounterProblem,
  scriptedWavBytes,
  usage,
} from "./walkthrough-core.mjs";
import {
  CONVERSATION_PLAN,
  FORM_JOURNEY_PLAN,
} from "./walkthrough-plans.mjs";

// The walkthrough CLI's own logic, unit-tested the way its sibling
// standalone checks are (scripts/meta_smoke_test.py ↔
// tests/test_meta_smoke_test.py): argument parsing and the journey's
// exit-code contract run against an injected transport, so no app or
// network is needed. The violation detectors themselves are covered by
// walkthrough-detectors.test.mjs; these tests pin the wiring that acts on
// their findings — a violation must stop the journey as not-completed
// (exit 1), a clean walk completes (exit 0), never silently green.

const SESSION_COOKIE = "bn_session=fake-token; Path=/; Max-Age=30; HttpOnly";

function jsonResponse(status, body, { setCookie } = {}) {
  return {
    status,
    text: JSON.stringify(body),
    response: {
      headers: { getSetCookie: () => (setCookie ? [setCookie] : []) },
    },
  };
}

function question(id, { pii = false, type = "single_select" } = {}) {
  return {
    id,
    prompt: `Prompt for ${id}`,
    help: "Help text.",
    type,
    required: false,
    pii,
    options: [],
  };
}

function clientState(questions, answers, currentIndex) {
  const complete = currentIndex === null;
  // The served shape always carries the quick-questions counter block
  // (VAL-QQ-008); fixtures derive a consistent one from the same
  // questions/answers the state carries, the way buildClientState does.
  const requiredIds = questions.map((question) => question.id);
  const remainingIds = questions
    .filter((question) => answers[question.id] === undefined)
    .map((question) => question.id);
  return {
    questions,
    answers,
    progress: { answered: questions.length, remaining: 0, total: questions.length },
    currentIndex: complete ? null : currentIndex,
    complete,
    quickQuestions: {
      programs: ["nc_medicaid"],
      requiredIds,
      requiredCount: requiredIds.length,
      remainingIds,
      remainingCount: remainingIds.length,
      complete: remainingIds.length === 0,
    },
  };
}

/** A scripted transport: each route matches (method, path) and answers
 * from a queue of canned responses. Each call is recorded with its
 * consent headers, its body, and whether the body was multipart
 * (FormData), so the consent-path tests can assert WHICH receipt rode
 * WHICH call, and the routing tests what each call carried. */
function fakeTransport(routes) {
  const calls = [];
  const transport = async (base, path, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({
      method,
      path,
      headers: options.headers,
      body: options.body,
      multipart: options.body instanceof FormData,
    });
    const route = routes.find(
      (candidate) => candidate.method === method && candidate.path === path,
    );
    if (!route) {
      throw new Error(`fakeTransport: no route for ${method} ${path}`);
    }
    return route.respondNext();
  };
  transport.calls = calls;
  return transport;
}

function queue(responses) {
  let index = 0;
  return () => {
    if (index >= responses.length) {
      throw new Error("fakeTransport: response queue exhausted");
    }
    return responses[index++];
  };
}

/** Routes for a clean one-question journey: health → create → answer →
 * save → resume → health. */
function cleanJourneyRoutes(finalState) {
  return [
    {
      method: "GET",
      path: "/api/health",
      respondNext: queue([jsonResponse(200, { ok: true }), jsonResponse(200, { ok: true })]),
    },
    {
      method: "POST",
      path: "/api/session",
      respondNext: queue([
        jsonResponse(
          201,
          { session: { status: "draft" }, state: clientState([question("application_role")], {}, 0) },
          { setCookie: SESSION_COOKIE },
        ),
        jsonResponse(200, {
          session: { status: "draft" },
          state: finalState,
        }),
      ]),
    },
    {
      method: "POST",
      path: "/api/intake/answer",
      respondNext: queue([
        jsonResponse(
          200,
          clientState(
            [question("application_role")],
            { application_role: { status: "known", value: "self" } },
            null,
          ),
        ),
      ]),
    },
    {
      method: "GET",
      path: "/api/session",
      respondNext: queue([
        jsonResponse(200, { session: { status: "draft" }, state: finalState }),
      ]),
    },
  ];
}

describe("walkthrough journey exit-code contract", () => {
  it("completes cleanly against a well-behaved app: run() true, exit 0", async () => {
    const finalState = clientState(
      [question("application_role")],
      { application_role: { status: "known", value: "self" } },
      null,
    );
    const transport = fakeTransport(cleanJourneyRoutes(finalState));
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    await expect(walk.run()).resolves.toBe(true);
    expect(walk.violations).toEqual([]);
    expect(exitCodeForRun(true)).toBe(EXIT_OK);
    // The journey hit every leg: health, create, answer, save, resume.
    const paths = transport.calls.map((call) => call.path);
    expect(paths).toEqual([
      "/api/health",
      "/api/session",
      "/api/intake/answer",
      "/api/session",
      "/api/session",
      "/api/health",
    ]);
  });

  it("a banned claim in any response stops the journey: run() false, exit 1", async () => {
    const leakyState = {
      ...clientState([question("application_role")], { application_role: { status: "known", value: "self" } }, null),
      // A server bug surfaced promise language in the client payload.
      banner: "Great news: you are eligible for assistance.",
    };
    const routes = cleanJourneyRoutes(leakyState);
    // The answer response carries the banned claim.
    routes[2].respondNext = queue([
      jsonResponse(200, {
        ...clientState([question("application_role")], { application_role: { status: "known" } }, 0),
        tip: "You will be approved.",
      }),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(walk.run()).resolves.toBe(false);
    expect(walk.violations.map((violation) => violation.kind)).toEqual(["banned_claim"]);
    expect(exitCodeForRun(false)).toBe(EXIT_VIOLATION);
    expect(exitCodeForRun(false)).not.toBe(EXIT_OK);
  });

  it("a pii value shipped under a pii question stops the journey", async () => {
    const piiQuestion = question("county", { pii: true, type: "text" });
    const routes = cleanJourneyRoutes(
      clientState(
        [piiQuestion],
        { county: { status: "known", value: "Contra Costa County" } },
        null,
      ),
    );
    routes[2].respondNext = queue([
      jsonResponse(
        200,
        clientState(
          [piiQuestion],
          // The boundary bug: a value under a pii:true question.
          { county: { status: "known", value: "Contra Costa County" } },
          null,
        ),
      ),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(walk.run()).resolves.toBe(false);
    // The structural leak detector bites (the value here was never submitted
    // by the walkthrough, so the exposure tracker is legitimately quiet).
    expect(walk.violations.map((violation) => violation.kind)).toEqual(["pii_value_leak"]);
    expect(exitCodeForRun(false)).toBe(EXIT_VIOLATION);
  });

  it("a submitted private value echoed back in a body stops the journey", async () => {
    const piiQuestion = question("county", { pii: true, type: "text" });
    const cleanState = clientState([piiQuestion], { county: { status: "known" } }, null);
    const routes = cleanJourneyRoutes(cleanState);
    // Make the flow present the pii free-form question first, so the
    // walkthrough actually submits the private value.
    routes[1].respondNext = queue([
      jsonResponse(
        201,
        { session: { status: "draft" }, state: clientState([piiQuestion], {}, 0) },
        { setCookie: SESSION_COOKIE },
      ),
      jsonResponse(200, { session: { status: "draft" }, state: cleanState }),
    ]);
    // The state is structurally clean, but the body echoes the submitted
    // value anyway (e.g. in an error message) — the exposure scan bites.
    routes[2].respondNext = queue([
      {
        status: 200,
        text:
          JSON.stringify(cleanState).slice(0, -1) +
          ',"note":"we have your Contra Costa County on file"}',
        response: { headers: { getSetCookie: () => [] } },
      },
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(walk.run()).resolves.toBe(false);
    expect(walk.violations.map((violation) => violation.kind)).toEqual(["pii_value_exposure"]);
  });

  it("a resumed state that differs from the saved state is a journey error", async () => {
    const finalState = clientState(
      [question("application_role")],
      { application_role: { status: "known", value: "self" } },
      null,
    );
    const routes = cleanJourneyRoutes(finalState);
    routes[3].respondNext = queue([
      jsonResponse(200, {
        session: { status: "draft" },
        state: clientState([question("application_role")], {}, 0),
      }),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(walk.run()).rejects.toBeInstanceOf(WalkthroughError);
  });

  it("every failure exit code is nonzero, by contract", () => {
    expect(EXIT_OK).toBe(0);
    expect(EXIT_VIOLATION).not.toBe(0);
    expect(EXIT_JOURNEY_ERROR).not.toBe(0);
  });
});

describe("the quick-questions counter check (VAL-QQ-008: progress counts consistent)", () => {
  const answered = { application_role: { status: "known", value: "self" } };
  const questions = [question("application_role"), question("main_goal")];

  it("a consistent block passes: counts match the lists, the answered question left the set", () => {
    const before = clientState(questions, {}, 0);
    const after = clientState(questions, answered, 1);
    expect(quickQuestionsCounterProblem(before, after, "application_role")).toBeNull();
    expect(quickQuestionsCounterProblem(null, after, "application_role")).toBeNull();
  });

  it("a served state without the counter block is a violation", () => {
    const after = clientState(questions, answered, 1);
    delete after.quickQuestions;
    expect(quickQuestionsCounterProblem(null, after, "application_role")).toContain(
      "no quickQuestions counter block",
    );
  });

  it("numbers that disagree with the id lists, or stray ids, are violations", () => {
    const after = clientState(questions, answered, 1);
    after.quickQuestions.remainingCount = 5;
    expect(quickQuestionsCounterProblem(null, after, "application_role")).toContain(
      "does not match the remaining list",
    );
    // remaining (2) over a required universe of 1, with each count
    // matching its own list: more still-to-ask questions than the
    // universe holds (the stray check would also catch this; the count
    // check fires first).
    const oversized = clientState(questions, answered, 1);
    oversized.quickQuestions.requiredIds = ["main_goal"];
    oversized.quickQuestions.requiredCount = 1;
    oversized.quickQuestions.remainingIds = ["main_goal", "state"];
    oversized.quickQuestions.remainingCount = 2;
    expect(quickQuestionsCounterProblem(null, oversized, "application_role")).toContain(
      "exceeds the required universe",
    );
    const stray = clientState(questions, answered, 1);
    stray.quickQuestions.remainingIds = ["not_a_required_id"];
    stray.quickQuestions.remainingCount = 1;
    expect(quickQuestionsCounterProblem(null, stray, "application_role")).toContain(
      "outside the required universe",
    );
  });

  it("a just-answered question still in the remaining set is the ask-once violation", () => {
    const before = clientState(questions, {}, 0);
    const after = clientState(questions, answered, 1);
    after.quickQuestions.remainingIds = ["application_role", "main_goal"];
    after.quickQuestions.remainingCount = 2;
    expect(quickQuestionsCounterProblem(before, after, "application_role")).toContain(
      "ask-once violated",
    );
  });

  it("a remaining count that grows as answers accumulate is a violation", () => {
    // Hand-built blocks (bypassing the fixture helper): a consistent
    // before-state of 3, then a served state whose universe — and with it
    // the remaining count — grew mid-journey. Every earlier check passes;
    // the monotone rule is what bites.
    const before = {
      quickQuestions: {
        requiredIds: ["a", "b", "c"],
        requiredCount: 3,
        remainingIds: ["a", "b", "c"],
        remainingCount: 3,
      },
    };
    const grown = {
      quickQuestions: {
        requiredIds: ["a", "b", "c", "d", "e"],
        requiredCount: 5,
        remainingIds: ["b", "c", "d", "e"],
        remainingCount: 4,
      },
    };
    expect(quickQuestionsCounterProblem(before, grown, "a")).toContain(
      "grew from 3 to 4",
    );
  });

  it("an inconsistent served counter stops the journey as a violation (exit 1)", async () => {
    const finalState = clientState(
      [question("application_role")],
      { application_role: { status: "known", value: "self" } },
      null,
    );
    const routes = cleanJourneyRoutes(finalState);
    // The app's counter lies: the answered question is still "remaining".
    const dishonestState = clientState(
      [question("application_role")],
      { application_role: { status: "known", value: "self" } },
      null,
    );
    dishonestState.quickQuestions.remainingIds = ["application_role"];
    dishonestState.remainingCount = 1;
    dishonestState.quickQuestions.remainingCount = 1;
    dishonestState.quickQuestions.complete = false;
    routes[2].respondNext = queue([jsonResponse(200, dishonestState)]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(walk.run()).resolves.toBe(false);
    expect(walk.violations.map((violation) => violation.kind)).toEqual([
      "quick_questions_counter",
    ]);
    expect(exitCodeForRun(false)).toBe(EXIT_VIOLATION);
  });

  it("a requiredCount that disagrees with the required list is a violation", () => {
    const after = clientState(questions, answered, 1);
    after.quickQuestions.requiredCount = 7;
    expect(quickQuestionsCounterProblem(null, after, "application_role")).toContain(
      "does not match the required list",
    );
    // Non-numeric counts can never pass silently (NaN comparisons are
    // false, which would let an "exceeds" check slip through).
    const NaNCount = clientState(questions, answered, 1);
    NaNCount.quickQuestions.requiredCount = undefined;
    expect(quickQuestionsCounterProblem(null, NaNCount, "application_role")).toContain(
      "non-numeric counts",
    );
  });
});

describe("the quick-questions counter check — properties (production logic)", () => {
  const idArb = fc.stringMatching(/^[a-z_]{1,10}$/);
  const idListArb = fc.uniqueArray(idArb, { minLength: 1, maxLength: 8 });

  /** A consistent N-of-M block for a required-id list and a subset. */
  function block(requiredIds, remainingIds) {
    return {
      quickQuestions: {
        requiredIds,
        requiredCount: requiredIds.length,
        remainingIds,
        remainingCount: remainingIds.length,
      },
    };
  }

  /**
   * A flat case: an id list, a boolean mask selecting the remaining
   * subset (index-wise; missing mask entries count as false), and the
   * index of the just-answered id within the UNASKED list (or null).
   * Flat generation keeps every arbitrary shrinkable without dependent
   * chains (a chained fc.subarray blew up fast-check's shrinker here).
   */
  const caseArb = fc.record({
    ids: idListArb,
    mask: fc.array(fc.boolean(), { maxLength: 12 }),
    answeredPick: fc.option(fc.integer({ min: 0, max: 11 }), { nil: undefined }),
    prevCount: fc.option(fc.integer({ min: 0, max: 12 }), { nil: undefined }),
  });

  function toCase({ ids, mask, answeredPick, prevCount }) {
    const remaining = ids.filter((_, index) => mask[index] === true);
    const unasked = ids.filter((id) => !remaining.includes(id));
    const answeredId =
      answeredPick !== null && answeredPick < unasked.length
        ? unasked[answeredPick]
        : undefined;
    const after = block(ids, remaining);
    // The consistent previous state's remaining set is a SUPERSET of the
    // next's (extra answers accumulated between the two states) — the
    // only transition shape the monotone rule allows.
    const before =
      prevCount === null
        ? null
        : block(
            ids,
            ids.filter(
              (id) =>
                remaining.includes(id) || ids.slice(0, prevCount).includes(id),
            ),
          );
    return { ids, remaining, answeredId, after, before };
  }

  it("PROPERTY: any consistent block passes, whatever the id list, the remaining subset, or the just-answered id", () => {
    fc.assert(
      fc.property(caseArb, (raw) => {
        const { answeredId, after, before } = toCase(raw);
        expect(quickQuestionsCounterProblem(null, after, answeredId)).toBeNull();
        // A consistent PREVIOUS state never makes a consistent next state
        // a problem unless its own remaining count grew past the next's —
        // and this previous state's count is the full universe, which can
        // only be ≥ the next's.
        expect(
          quickQuestionsCounterProblem(before, after, answeredId),
        ).toBeNull();
      }),
    );
  });

  it("PROPERTY: any remainingCount that disagrees with its list is detected", () => {
    fc.assert(
      fc.property(caseArb, fc.integer({ min: -3, max: 12 }), (raw, delta) => {
        const { remaining } = toCase(raw);
        const wrong = remaining.length + delta;
        if (wrong === remaining.length) {
          return;
        }
        // The universe is the remaining list itself: every structural
        // check is consistent except the mutated count.
        const nextState = block(remaining, remaining);
        nextState.quickQuestions.remainingCount = wrong;
        expect(
          quickQuestionsCounterProblem(null, nextState, undefined),
        ).toContain("does not match the remaining list");
      }),
    );
  });

  it("PROPERTY: a just-answered question left in the remaining set is always the ask-once violation", () => {
    fc.assert(
      fc.property(
        fc.record({
          ids: idListArb,
          mask: fc.array(fc.boolean(), { maxLength: 12 }),
          answeredPick: fc.integer({ min: 0, max: 11 }),
        }),
        (raw) => {
          const { ids } = raw;
          const remaining = ids.filter(
            (_, index) => raw.mask[index] === true,
          );
          fc.pre(remaining.length > 0);
          const answeredId = remaining[raw.answeredPick % remaining.length];
          const after = block(ids, remaining);
          expect(
            quickQuestionsCounterProblem(null, after, answeredId),
          ).toContain("ask-once violated");
        },
      ),
    );
  });

  it("PROPERTY: a remaining count that grows across consistent blocks is always detected", () => {
    fc.assert(
      fc.property(
        idListArb.filter((ids) => ids.length >= 2),
        fc.integer({ min: 0, max: 7 }),
        fc.integer({ min: 1, max: 8 }),
        (ids, beforeRaw, rise) => {
          const before = Math.min(beforeRaw, ids.length - 1);
          const after = Math.min(before + rise, ids.length);
          if (after <= before) {
            return;
          }
          const prevState = block(ids, ids.slice(0, before));
          const nextState = block(ids, ids.slice(0, after));
          expect(
            quickQuestionsCounterProblem(prevState, nextState, undefined),
          ).toContain(`grew from ${before} to ${after}`);
        },
      ),
    );
  });
});

describe("walkthrough journey plan", () => {
  it("covers a realistic tri-state mix: unknowns and unverified included", () => {
    const statuses = JOURNEY_PLAN.map((step) => step.status);
    expect(statuses.filter((status) => status === "unknown").length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((status) => status === "unverified").length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((status) => status === "known").length).toBeGreaterThanOrEqual(1);
  });

  it("carries no question classification — pii comes from the served payload", () => {
    for (const step of JOURNEY_PLAN) {
      expect(step).not.toHaveProperty("pii");
      expect(step).not.toHaveProperty("freeForm");
    }
  });

  it("ids are unique", () => {
    expect(new Set(JOURNEY_PLAN.map((step) => step.id)).size).toBe(JOURNEY_PLAN.length);
  });
});

describe("walkthrough CLI argument parsing", () => {
  it("defaults to the local dev server, the wizard mode, and a 30s timeout", () => {
    expect(parseArgs([])).toEqual({
      url: "http://localhost:3100",
      timeoutMs: 30000,
      mode: "wizard",
      consent: "voice",
      dbVerify: false,
    });
  });

  it("parses --url and strips trailing slashes", () => {
    expect(parseArgs(["--url", "https://example.com/"]).url).toBe("https://example.com");
  });

  it("parses --timeout as a number", () => {
    expect(parseArgs(["--timeout", "5000"]).timeoutMs).toBe(5000);
  });

  it("--help prints usage and asks for a clean exit", () => {
    expect(usage()).toContain("--url");
    expect(parseArgs(["--help"])).toBeNull();
  });

  it("rejects unknown arguments with a journey error", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(WalkthroughError);
  });

  it("rejects non-http URLs", () => {
    expect(() => parseArgs(["--url", "file:///etc/passwd"])).toThrow(WalkthroughError);
    expect(() => parseArgs(["--url", "ftp://example.com"])).toThrow(WalkthroughError);
  });

  it("rejects non-positive timeouts", () => {
    expect(() => parseArgs(["--timeout", "0"])).toThrow(WalkthroughError);
    expect(() => parseArgs(["--timeout", "-5"])).toThrow(WalkthroughError);
  });
});

describe("resume deep-equality (property-based)", () => {
  it("any JSON value equals a deep clone of itself", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(deepEqual(value, structuredClone(value))).toBe(true);
      }),
    );
  });

  it("an added key breaks equality for objects", () => {
    fc.assert(
      fc.property(
        fc.jsonValue().filter((value) => value !== null && typeof value === "object" && !Array.isArray(value)),
        fc.string(),
        (object, key) => {
          const mutated = { ...object, [key]: 1 };
          expect(deepEqual(object, mutated)).toBe(false);
        },
      ),
    );
  });

  it("never reports equality across different scalar types", () => {
    fc.assert(
      fc.property(fc.integer(), fc.string(), (aNumber, aString) => {
        expect(deepEqual(aNumber, aString)).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// v2 journeys (VAL-WALK2-001/003, VAL-X2-001/002): the conversational
// text-mode journey and the form-driven journey, pinned by the same
// injected-transport contract as the wizard walk — no app or network
// needed. The turn pacing is injectable so no test ever sleeps.
// ---------------------------------------------------------------------------

const V2_COOKIE = "bn_session=v2-token; Path=/; HttpOnly";

function v2Question(id, { pii = false, type = "single_select" } = {}) {
  return {
    id,
    prompt: `Prompt for ${id}`,
    help: "Help text.",
    type,
    required: false,
    pii,
    options: [],
  };
}

function turnBody({ reply, transcript, nextQuestionId, state, fresh = false }) {
  return {
    sessionId: "v2-session",
    fresh,
    assistantReply: reply,
    assistantTurnId: `turn-${Math.random().toString(36).slice(2)}`,
    redactedUserTranscript: transcript,
    nextQuestionId,
    state,
  };
}

/** A state whose required-for-programs set is already handled — the
 * talk-only scenario the v2 journey scripts (the conversation journey's
 * quick-questions phase no-ops on it). */
function talkOnlyState(state) {
  return {
    ...state,
    quickQuestions: {
      ...state.quickQuestions,
      remainingIds: [],
      remainingCount: 0,
      complete: true,
    },
  };
}

/** A two-question scripted conversation: one plain question, one pii
 * free-form one whose redacted transcript carries the app's marker. */
function v2JourneyRoutes({ formId = "form-x", historyTurns, finalState } = {}) {
  const appRoleQ = v2Question("application_role");
  const countyQ = v2Question("county", { pii: true, type: "text" });
  const initialState = talkOnlyState(clientState([appRoleQ, countyQ], {}, 0));
  const midState = clientState(
    [appRoleQ, countyQ],
    { application_role: { status: "known", value: "self" } },
    1,
  );
  const completeState = finalState ??
    clientState(
      [appRoleQ, countyQ],
      {
        application_role: { status: "known", value: "self" },
        county: { status: "known" },
      },
      null,
    );
  const pdfText = `%PDF-1.7\n${"x".repeat(2000)}`;
  return [
    {
      method: "GET",
      path: "/api/health",
      respondNext: queue([jsonResponse(200, { ok: true }), jsonResponse(200, { ok: true })]),
    },
    {
      method: "POST",
      path: "/api/session",
      respondNext: queue([
        jsonResponse(201, { session: { status: "draft" }, state: initialState }, { setCookie: V2_COOKIE }),
        jsonResponse(200, { session: { status: "draft" }, state: completeState }),
      ]),
    },
    {
      method: "GET",
      path: "/api/session",
      respondNext: queue([
        jsonResponse(200, { session: { status: "draft" }, state: completeState }),
      ]),
    },
    {
      method: "POST",
      path: "/api/conversation/turn",
      respondNext: queue([
        jsonResponse(
          200,
          turnBody({
            reply: "Thanks. Which county or city area do you live in?",
            transcript: "It's for myself.",
            nextQuestionId: "county",
            state: midState,
            fresh: true,
          }),
        ),
        jsonResponse(
          200,
          turnBody({
            reply: "That's everything on my list.",
            transcript: `My county is [redacted answer to "Which county or city area do you live in?"].`,
            nextQuestionId: null,
            state: completeState,
          }),
        ),
      ]),
    },
    {
      method: "GET",
      path: "/api/match",
      respondNext: queue([
        jsonResponse(200, {
          hasSession: true,
          matches: [],
          toResolve: [],
        }),
      ]),
    },
    {
      method: "GET",
      path: `/api/forms/${formId}/review`,
      respondNext: queue([
        jsonResponse(200, {
          hasSession: true,
          form: { id: formId, title: "Form X", version: "1.0.0", sourceUrl: "https://example.org/x.pdf", retrievedAt: "2026-10-30" },
          fields: [
            {
              fieldName: "county_field",
              type: "text",
              question: "Which county or city area do you live in?",
              state: "prefilled",
              specQuestionId: "county",
              required: false,
              piiLikely: true,
              status: "known",
              provenance: "user_supplied",
            },
            {
              fieldName: "name_field",
              type: "text",
              question: "What is your full name?",
              state: "asked",
              specQuestionId: null,
              required: true,
              piiLikely: true,
            },
          ],
          toResolve: [{ fieldName: "name_field", question: "What is your full name?" }],
          counts: { prefilled: 1, asked: 1, notApplicable: 0 },
          sessionStatus: "draft",
          steps: [],
        }),
      ]),
    },
    {
      method: "GET",
      path: "/api/conversation/history",
      respondNext: queue([
        jsonResponse(200, {
          turns: historyTurns ?? [
            { role: "user", transcript: "It's for myself.", createdAt: "2026-10-31T01:00:00.000Z" },
            { role: "assistant", transcript: "That's everything on my list.", createdAt: "2026-10-31T01:00:05.000Z" },
          ],
          state: completeState,
        }),
      ]),
    },
    {
      method: "GET",
      path: `/forms/${formId}.pdf`,
      respondNext: queue([
        {
          status: 200,
          text: pdfText,
          response: {
            headers: {
              getSetCookie: () => [],
              get: (key) => (key === "content-type" ? "application/pdf" : null),
            },
          },
        },
      ]),
    },
  ];
}

/** Look a scripted route up by method + path — overriding by index went
 * stale the moment the route list grew a GET /api/session entry. */
function routeOf(routes, method, pathStr) {
  const route = routes.find(
    (candidate) => candidate.method === method && candidate.path === pathStr,
  );
  if (!route) {
    throw new Error(`routeOf: no route for ${method} ${pathStr}`);
  }
  return route;
}

const MINI_PLAN = [
  { id: "application_role", text: "It's for myself.", retry: "Me", intent: "known" },
  {
    id: "county",
    text: "Mecklenburg County.",
    retry: "Mecklenburg County",
    intent: "known",
    privateValue: "Mecklenburg County",
  },
];

describe("the typed journeys' work-requirements capture phase", () => {
  /** Routes for a scripted QQ phase: two pending required ids (the
   * exemption screen and a sensitive one), answered locally; each answer
   * shrinks the pending list until it is empty. */
  function qqPhaseRoutes() {
    const exemptQ = v2Question("wr_exempt_situations");
    const pregnantQ = v2Question("wr_pregnant", { pii: true });
    const mkState = (remainingIds) => ({
      ...clientState([exemptQ, pregnantQ], {}, 0),
      quickQuestions: {
        programs: ["nc_medicaid"],
        requiredIds: [exemptQ.id, pregnantQ.id],
        requiredCount: 2,
        remainingIds,
        remainingCount: remainingIds.length,
        complete: remainingIds.length === 0,
      },
    });
    return [
      {
        method: "POST",
        path: "/api/intake/answer",
        respondNext: queue([
          jsonResponse(200, mkState(["wr_pregnant"])),
          jsonResponse(200, mkState([])),
        ]),
      },
    ];
  }

  it("answers the pending wr ids through the answer route, never the model", async () => {
    const transport = fakeTransport(qqPhaseRoutes());
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    walk.state = clientState(
      [v2Question("wr_exempt_situations"), v2Question("wr_pregnant", { pii: true })],
      {},
      0,
    );
    const { skippedBy } = await walk.answerWorkRequirementsLocally();
    expect(transport.calls.map((call) => call.path)).toEqual([
      "/api/intake/answer",
      "/api/intake/answer",
    ]);
    expect(skippedBy.size).toBe(0);
    // The transcript says the local route was used and the model saw
    // none of it; the pii answer's value is kept private in the log.
    const transcript = walk.lines.join("\n");
    expect(transcript).toContain("(answer route, no model)");
    expect(transcript).toContain("the model saw none of them");
    expect(transcript).toContain("(answer kept private)");
  });

  it("tracks the questions a local answer hides (the work-activity section)", async () => {
    const exemptQ = v2Question("wr_exempt_situations");
    const reportingQ = v2Question("wr_work_activity_who", { pii: true });
    const routes = [
      {
        method: "POST",
        path: "/api/intake/answer",
        respondNext: queue([
          jsonResponse(200, {
            ...clientState([exemptQ], {}, null),
            quickQuestions: {
              programs: ["nc_medicaid"],
              requiredIds: [exemptQ.id],
              requiredCount: 1,
              remainingIds: [],
              remainingCount: 0,
              complete: true,
            },
          }),
        ]),
      },
    ];
    const transport = fakeTransport(routes);
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    walk.state = {
      ...clientState([exemptQ, reportingQ], {}, 0),
      quickQuestions: {
        programs: ["nc_medicaid"],
        requiredIds: [exemptQ.id, reportingQ.id],
        requiredCount: 2,
        remainingIds: [exemptQ.id],
        remainingCount: 1,
        complete: false,
      },
    };
    const { skippedBy } = await walk.answerWorkRequirementsLocally();
    expect(skippedBy.get("wr_work_activity_who")).toBe("wr_exempt_situations");
  });

  it("refuses to guess when a pending id is outside the journey plan", async () => {
    const transport = fakeTransport(qqPhaseRoutes());
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    walk.state = {
      ...clientState([v2Question("wr_something_new")], {}, 0),
      quickQuestions: {
        programs: ["nc_medicaid"],
        requiredIds: ["wr_something_new"],
        requiredCount: 1,
        remainingIds: ["wr_something_new"],
        remainingCount: 1,
        complete: false,
      },
    };
    await expect(walk.answerWorkRequirementsLocally()).rejects.toThrow(
      /journey plan does not cover/,
    );
  });
});

describe("v2 conversational journey (VAL-WALK2-001 / VAL-X2-001 contract)", () => {
  it("walks every leg cleanly: turns, match, review, save, resume, history, PDF", async () => {
    const transport = fakeTransport(v2JourneyRoutes());
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    await expect(
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x" }),
    ).resolves.toBe(true);
    expect(walk.violations).toEqual([]);
    expect(exitCodeForRun(true)).toBe(EXIT_OK);
    const paths = transport.calls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toEqual([
      "GET /api/health",
      "POST /api/session",
      "POST /api/conversation/turn",
      "POST /api/conversation/turn",
      "GET /api/match",
      "GET /api/forms/form-x/review",
      "POST /api/session",
      "GET /api/session",
      "GET /api/conversation/history",
      "GET /forms/form-x.pdf",
      "GET /api/health",
    ]);
    // The last assistant turn stored server-side is the one delivered.
    expect(walk.lastAssistantReply).toBe("That's everything on my list.");
  });

  it("a banned claim in an assistant reply stops the journey", async () => {
    const routes = v2JourneyRoutes();
    routeOf(routes, "POST", "/api/conversation/turn").respondNext = queue([
      jsonResponse(
        200,
        turnBody({
          reply: "Great news: you qualify for assistance.",
          transcript: "It's for myself.",
          nextQuestionId: "county",
          state: clientState(
            [v2Question("application_role"), v2Question("county", { pii: true, type: "text" })],
            { application_role: { status: "known", value: "self" } },
            1,
          ),
          fresh: true,
        }),
      ),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x" }),
    ).resolves.toBe(false);
    expect(walk.violations.map((violation) => violation.kind)).toContain("assistant_banned_claim");
    expect(exitCodeForRun(false)).toBe(EXIT_VIOLATION);
  });

  it("a transient turn failure retries, re-captures the cookie, and waits the full backoff", async () => {
    const routes = v2JourneyRoutes();
    const retryCookie = "bn_session=retry-token; Path=/; HttpOnly";
    routeOf(routes, "POST", "/api/conversation/turn").respondNext = queue([
      // First attempt throttles; the error response still carries the
      // session cookie (the route's orphan-answering behavior).
      jsonResponse(503, { error: { code: "model_unavailable", message: "busy" } }, {
        setCookie: retryCookie,
      }),
      jsonResponse(
        200,
        turnBody({
          reply: "Thanks. Which county or city area do you live in?",
          transcript: "It's for myself.",
          nextQuestionId: "county",
          state: clientState(
            [v2Question("application_role"), v2Question("county", { pii: true, type: "text" })],
            { application_role: { status: "known", value: "self" } },
            1,
          ),
          fresh: true,
        }),
      ),
      jsonResponse(
        200,
        turnBody({
          reply: "That's everything on my list.",
          transcript: `My county is [redacted answer to "Which county or city area do you live in?"].`,
          nextQuestionId: null,
          state: clientState(
            [v2Question("application_role"), v2Question("county", { pii: true, type: "text" })],
            {
              application_role: { status: "known", value: "self" },
              county: { status: "known" },
            },
            null,
          ),
        }),
      ),
    ]);
    const slept = [];
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes), (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    await expect(
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x" }),
    ).resolves.toBe(true);
    // The retry resumed with the cookie from the error response, and the
    // wait was the full backoff — a shorter wait would hammer a
    // throttling model.
    expect(walk.cookie).toBe("bn_session=retry-token");
    expect(slept).toEqual([TURN_RETRY_WAIT_MS]);
  });

  it("every attempt transient is a journey error after the last attempt", async () => {
    const routes = v2JourneyRoutes();
    routeOf(routes, "POST", "/api/conversation/turn").respondNext = queue(
      Array.from({ length: TURN_ATTEMPTS }, () =>
        jsonResponse(502, { error: { code: "internal", message: "bad gateway" } }, {
          setCookie: "bn_session=retry-token-2; Path=/; HttpOnly",
        })),
    );
    const slept = [];
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes), (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    await expect(
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x" }),
    ).rejects.toBeInstanceOf(WalkthroughError);
    expect(slept).toEqual(Array.from({ length: TURN_ATTEMPTS - 1 }, () => TURN_RETRY_WAIT_MS));
    // The cookie from the failed attempts is still captured — a manual
    // retry by the operator resumes the session instead of orphaning it.
    expect(walk.cookie).toBe("bn_session=retry-token-2");
  });

  it("an error body quoting a submitted private value is masked before it reaches the transcript", async () => {
    const routes = v2JourneyRoutes();
    const countyQ = v2Question("county", { pii: true, type: "text" });
    const appRoleQ = v2Question("application_role");
    routeOf(routes, "POST", "/api/conversation/turn").respondNext = queue([
      jsonResponse(
        200,
        turnBody({
          reply: "Thanks. Which county or city area do you live in?",
          transcript: "It's for myself.",
          nextQuestionId: "county",
          state: clientState(
            [appRoleQ, countyQ],
            { application_role: { status: "known", value: "self" } },
            1,
          ),
          fresh: true,
        }),
      ),
      ...Array.from({ length: TURN_ATTEMPTS }, () =>
        jsonResponse(503, {
          error: { code: "model_unavailable", message: "bad upstream echoed: Mecklenburg County" },
        }, { setCookie: V2_COOKIE })),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes), () => {
      return Promise.resolve();
    });
    let message = "";
    try {
      await walk.runConversation({ plan: MINI_PLAN, formId: "form-x" });
    } catch (error) {
      message = error.message;
    }
    expect(message).not.toBe("");
    // The thrown message carries the marker, never the value itself.
    expect(message).not.toContain("Mecklenburg County");
    expect(message).toContain("[private value removed from the transcript]");
  });

  it("an unredacted transcript stops the journey as a redaction failure", async () => {
    const routes = v2JourneyRoutes();
    routeOf(routes, "POST", "/api/conversation/turn").respondNext = queue([
      jsonResponse(
        200,
        turnBody({
          reply: "Thanks. Which county or city area do you live in?",
          transcript: "It's for myself.",
          nextQuestionId: "county",
          state: clientState(
            [v2Question("application_role"), v2Question("county", { pii: true, type: "text" })],
            { application_role: { status: "known", value: "self" } },
            1,
          ),
          fresh: true,
        }),
      ),
      // The county turn came back UNREDACTED — the private words as typed.
      jsonResponse(
        200,
        turnBody({
          reply: "That's everything on my list.",
          transcript: "Mecklenburg County.",
          nextQuestionId: null,
          state: clientState(
            [v2Question("application_role"), v2Question("county", { pii: true, type: "text" })],
            {
              application_role: { status: "known", value: "self" },
              county: { status: "known" },
            },
            null,
          ),
        }),
      ),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x" }),
    ).resolves.toBe(false);
    expect(walk.violations.map((violation) => violation.kind)).toContain("redaction_failure");
  });

  it("a private value echoed in the stored history stops the journey", async () => {
    const routes = v2JourneyRoutes({
      historyTurns: [
        { role: "user", transcript: "It's for myself.", createdAt: "2026-10-31T01:00:00.000Z" },
        { role: "user", transcript: "Mecklenburg County.", createdAt: "2026-10-31T01:00:02.000Z" },
        { role: "assistant", transcript: "That's everything on my list.", createdAt: "2026-10-31T01:00:05.000Z" },
      ],
    });
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x" }),
    ).resolves.toBe(false);
    expect(walk.violations.map((violation) => violation.kind)).toContain("pii_echo");
  });

  it("a turn that saves nothing for the asked question twice is a journey error", async () => {
    const routes = v2JourneyRoutes();
    const stuckState = talkOnlyState(
      clientState(
        [v2Question("application_role"), v2Question("county", { pii: true, type: "text" })],
        {},
        0,
      ),
    );
    routeOf(routes, "POST", "/api/session").respondNext = queue([
      jsonResponse(201, { session: { status: "draft" }, state: stuckState }, { setCookie: V2_COOKIE }),
      jsonResponse(200, { session: { status: "draft" }, state: stuckState }),
    ]);
    routeOf(routes, "POST", "/api/conversation/turn").respondNext = queue([
      jsonResponse(
        200,
        turnBody({
          reply: "I'm not sure what you said.",
          transcript: "Hello?",
          nextQuestionId: "application_role",
          state: stuckState,
          fresh: true,
        }),
      ),
      jsonResponse(
        200,
        turnBody({
          reply: "I'm not sure what you said.",
          transcript: "Me.",
          nextQuestionId: "application_role",
          state: stuckState,
        }),
      ),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x" }),
    ).rejects.toBeInstanceOf(WalkthroughError);
  });
});

describe("v2 form-driven journey (VAL-WALK2-003 contract)", () => {
  it("walks turns, review, and the fill round-trip cleanly", async () => {
    const transport = fakeTransport(v2JourneyRoutes());
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    await expect(
      walk.runFormJourney({ plan: MINI_PLAN, formId: "form-x" }),
    ).resolves.toBe(true);
    expect(walk.violations).toEqual([]);
    const paths = transport.calls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toEqual([
      "GET /api/health",
      "POST /api/session",
      "POST /api/conversation/turn",
      "POST /api/conversation/turn",
      "GET /api/forms/form-x/review",
      "GET /forms/form-x.pdf",
      "GET /api/health",
    ]);
  });

  it("a review that still needs an answered mapped field is a journey error", async () => {
    const routes = v2JourneyRoutes();
    // The county field was answered through the conversation, so the
    // review listing it as still-needed is inconsistent.
    routeOf(routes, "GET", "/api/forms/form-x/review").respondNext = queue([
      jsonResponse(200, {
        hasSession: true,
        form: { id: "form-x", title: "Form X", version: "1.0.0", sourceUrl: "https://example.org/x.pdf", retrievedAt: "2026-10-30" },
        fields: [
          // A genuinely pre-filled field keeps the earlier pre-fill guard
          // quiet, so THIS test's target — the to-resolve consistency
          // check — is the logic that actually throws (a mapped field
          // answered through the conversation may not be still-needed).
          {
            fieldName: "role_field",
            type: "text",
            question: "Who is this application for?",
            state: "prefilled",
            specQuestionId: "application_role",
            required: false,
            piiLikely: false,
            status: "known",
            provenance: "user_supplied",
            value: "self",
          },
          {
            fieldName: "county_field",
            type: "text",
            question: "Which county or city area do you live in?",
            state: "asked",
            specQuestionId: "county",
            required: false,
            piiLikely: true,
          },
        ],
        toResolve: [{ fieldName: "county_field", question: "Which county or city area do you live in?" }],
        counts: { prefilled: 1, asked: 1, notApplicable: 0 },
        sessionStatus: "draft",
        steps: [],
      }),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(
      walk.runFormJourney({ plan: MINI_PLAN, formId: "form-x" }),
    ).rejects.toThrow(/still needs/);
  });

  it("a template download that returns a non-PDF body is a journey error", async () => {
    const routes = v2JourneyRoutes();
    routeOf(routes, "GET", "/forms/form-x.pdf").respondNext = queue([
      {
        status: 200,
        text: "<html>server error</html>",
        response: {
          headers: {
            getSetCookie: () => [],
            get: (key) => (key === "content-type" ? "text/html" : null),
          },
        },
      },
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(
      walk.runFormJourney({ plan: MINI_PLAN, formId: "form-x" }),
    ).rejects.toBeInstanceOf(WalkthroughError);
  });
});

describe("v2 journey plans (scripts/walkthrough-plans.mjs)", () => {
  it("each plan covers a realistic tri-state mix", () => {
    for (const plan of [CONVERSATION_PLAN, FORM_JOURNEY_PLAN]) {
      const intents = plan.map((step) => step.intent);
      expect(intents.filter((intent) => intent === "known").length).toBeGreaterThanOrEqual(1);
      expect(intents.filter((intent) => intent === "unknown").length).toBeGreaterThanOrEqual(1);
      expect(intents.filter((intent) => intent === "unverified").length).toBeGreaterThanOrEqual(1);
    }
  });

  it("every step retries with plainer words", () => {
    for (const plan of [CONVERSATION_PLAN, FORM_JOURNEY_PLAN]) {
      for (const step of plan) {
        expect(typeof step.retry).toBe("string");
        expect(step.retry.length).toBeGreaterThan(0);
      }
    }
  });

  it("ids are unique within each plan", () => {
    for (const plan of [CONVERSATION_PLAN, FORM_JOURNEY_PLAN]) {
      expect(new Set(plan.map((step) => step.id)).size).toBe(plan.length);
    }
  });

  it("the pii free-form steps type their value in canonical form", () => {
    for (const step of CONVERSATION_PLAN) {
      if (["county", "prior_employer_last_month", "date_of_birth", "email_contact"].includes(step.id)) {
        expect(step.privateValue, step.id).toBeDefined();
        expect(step.text.includes(step.privateValue), step.id).toBe(true);
      }
    }
  });
});

describe("v2 CLI argument parsing", () => {
  it("defaults to the wizard mode and its 30s timeout", () => {
    const options = parseArgs([]);
    expect(options.mode).toBe("wizard");
    expect(options.timeoutMs).toBe(30000);
    expect(options.url).toBe("http://localhost:3100");
  });

  it("the v2 modes default to a 90s per-request timeout (two live model calls a turn)", () => {
    expect(parseArgs(["--mode", "conversation"]).mode).toBe("conversation");
    expect(parseArgs(["--mode", "conversation"]).timeoutMs).toBe(90000);
    expect(parseArgs(["--mode", "form"]).timeoutMs).toBe(90000);
  });

  it("an explicit --timeout wins over the mode default", () => {
    expect(parseArgs(["--mode", "form", "--timeout", "45000"]).timeoutMs).toBe(45000);
  });

  it("rejects an unknown mode with a journey error", () => {
    expect(() => parseArgs(["--mode", "teleport"])).toThrow(WalkthroughError);
  });

  it("usage documents the modes and the exit codes", () => {
    const help = usage();
    expect(help).toContain("--mode");
    expect(help).toContain("conversation");
    expect(help).toContain("form");
  });
});

describe("turn pacing (v2)", () => {
  it("does not sleep while turns stay under the per-minute cap", async () => {
    const slept = [];
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport([]), (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    await walk.paceTurns();
    expect(slept).toEqual([]);
    expect(walk.turnTimes.length).toBe(1);
  });

  it("sleeps when the recent window reaches the cap, then records the turn", async () => {
    const slept = [];
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport([]), (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    walk.turnTimes = Array.from({ length: 11 }, (_, index) => Date.now() - index * 1000);
    await walk.paceTurns();
    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThan(0);
    expect(slept[0]).toBeLessThanOrEqual(61_000);
    expect(walk.turnTimes.length).toBe(12);
  });

  it("prunes stale timestamps from the window", async () => {
    const slept = [];
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport([]), (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    walk.turnTimes = [Date.now() - 120_000, Date.now() - 90_000];
    await walk.paceTurns();
    expect(slept).toEqual([]);
    expect(walk.turnTimes.length).toBe(1);
  });
});

describe("BN-25 session vocabulary (v2 review)", () => {
  it("carries exactly the BN-25 lifecycle states", () => {
    expect([...BN25_SESSION_STATUSES]).toEqual([
      "draft",
      "prepared",
      "handed_off",
      "user_reported_submitted",
      "user_reported_decided",
    ]);
  });

  it("mirrors the honesty spine's session vocabulary (drift test)", async () => {
    // The CLI cannot import app modules; the mirror is kept honest the
    // same way the detectors' vocabulary is — a drift test against the
    // owning export.
    const spine = await import("../src/lib/honesty");
    expect([...BN25_SESSION_STATUSES]).toEqual([...spine.SESSION_STATUSES]);
  });

  it("the sample form id mirrors the pilot seam (drift test)", async () => {
    const pilot = await import("../src/lib/pilot");
    expect(SAMPLE_FORM_ID).toBe(pilot.PILOT_CONFIG.sampleFormRegistryId);
  });

  it("the sprint form ids mirror the pilot seam's two applications (drift test)", async () => {
    const pilot = await import("../src/lib/pilot");
    expect([...SPRINT_FORM_IDS]).toEqual([
      pilot.PILOT_CONFIG.formRegistryId,
      ...pilot.PILOT_CONFIG.additionalApplications.map(
        (application) => application.formRegistryId,
      ),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Sprint cross-journey proof (VAL-SPRINT-001/002/003): the five-stage
// journey — Choose mode → Quick questions → Talk → Income → Results — in
// ONE real session, both consent paths, both real applications prepared
// from the same answers, and the visible purge. The same
// injected-transport contract as the other journeys; the scripted-audio
// generator and the psql runner are injectable too, so no test ever
// shells out to `say` or docker.
// ---------------------------------------------------------------------------

const SPRINT_COOKIE =
  "bn_session=9f0d7bd0-5b0d-4bcc-81f4-35a1cd94d310; Path=/; HttpOnly";

function incomeBlock(handled = true) {
  return {
    questionIds: ["job_income_amount", "job_income_frequency", "benefits_income_amount"],
    answeredCount: 3,
    confirmedCount: 2,
    totalCount: 3,
    handled,
  };
}

/** A review response fixture: `prefilledCount` pre-filled fields for the
 * carry-over assertion, the rest of the view minimal (a pre-filled
 * pii-likely field never carries a value — the boundary the review
 * payload itself keeps). */
function reviewBody(formId, prefilledCount) {
  const state = prefilledCount > 0 ? "prefilled" : "asked";
  return {
    hasSession: true,
    form: {
      id: formId,
      title: `Form ${formId}`,
      version: "1.0.0",
      sourceUrl: "https://example.org/form.pdf",
      retrievedAt: "2026-11-01",
    },
    fields: [
      {
        fieldName: "name_field",
        type: "text",
        question: "What is your full name?",
        state,
        specQuestionId: null,
        required: true,
        piiLikely: true,
        ...(prefilledCount > 0 ? { status: "known", provenance: "user_supplied" } : {}),
      },
      {
        fieldName: "role_field",
        type: "single_select",
        question: "Who is this application for?",
        state,
        specQuestionId: "application_role",
        required: false,
        piiLikely: false,
        ...(prefilledCount > 0
          ? { status: "known", provenance: "user_supplied", value: "self" }
          : {}),
      },
    ],
    toResolve: [],
    counts: { prefilled: prefilledCount, asked: 2 - prefilledCount, notApplicable: 0 },
    sessionStatus: "draft",
    steps: [],
  };
}

function pdfResponse() {
  return {
    status: 200,
    text: `%PDF-1.7\n${"x".repeat(2000)}`,
    response: {
      headers: {
        getSetCookie: () => [],
        get: (key) => (key === "content-type" ? "application/pdf" : null),
      },
    },
  };
}

/** The sprint journey's scripted app: three questions (one answered by
 * the quick-questions phase, two by the talk stage), the income stage's
 * two routes, both real forms' review+fill, the purge refusal and the
 * confirmed purge, and the post-purge resume + reviews. */
function sprintJourneyRoutes() {
  const questions = [
    v2Question("wr_exempt_situations"),
    v2Question("application_role"),
    v2Question("county", { pii: true, type: "text" }),
  ];
  const S0 = { ...clientState(questions, {}, 0), income: incomeBlock(false) };
  const S1 = {
    ...clientState(
      questions,
      { wr_exempt_situations: { status: "known", value: ["parent_child_under_18"] } },
      1,
    ),
    income: incomeBlock(false),
  };
  const S2 = {
    ...clientState(
      questions,
      {
        wr_exempt_situations: { status: "known", value: ["parent_child_under_18"] },
        application_role: { status: "known", value: "self" },
      },
      2,
    ),
    income: incomeBlock(false),
  };
  const S3 = {
    ...clientState(
      questions,
      {
        wr_exempt_situations: { status: "known", value: ["parent_child_under_18"] },
        application_role: { status: "known", value: "self" },
        county: { status: "known" },
      },
      null,
    ),
    income: incomeBlock(false),
  };
  const S4 = { ...S3, income: incomeBlock(true) };
  const S_EMPTY = { ...clientState(questions, {}, 0), income: incomeBlock(false) };
  return [
    {
      method: "GET",
      path: "/api/health",
      respondNext: queue([jsonResponse(200, { ok: true }), jsonResponse(200, { ok: true })]),
    },
    {
      method: "POST",
      path: "/api/session",
      respondNext: queue([
        jsonResponse(201, { session: { status: "draft" }, state: S0 }, { setCookie: SPRINT_COOKIE }),
      ]),
    },
    {
      method: "POST",
      path: "/api/intake/answer",
      respondNext: queue([
        jsonResponse(200, S1),
        jsonResponse(200, S2),
        jsonResponse(200, S3),
      ]),
    },
    {
      method: "POST",
      path: "/api/conversation/turn",
      respondNext: queue([
        jsonResponse(
          200,
          turnBody({
            reply: "Thanks. Which county or city area do you live in?",
            transcript: "It's for myself.",
            nextQuestionId: "county",
            state: S2,
            fresh: true,
          }),
        ),
        jsonResponse(
          200,
          turnBody({
            reply: "That's everything on my list.",
            transcript: `My county is [redacted answer to "Which county or city area do you live in?"].`,
            nextQuestionId: null,
            state: S3,
          }),
        ),
      ]),
    },
    {
      method: "POST",
      path: "/api/intake/tax-return",
      respondNext: queue([
        jsonResponse(200, {
          readable: true,
          findings: [
            { field: "agi_line_11", value: 12000, origin: "positional_text", confidence: "high" },
          ],
          monthlyDerived: 1000,
          message: null,
        }),
      ]),
    },
    {
      method: "POST",
      path: "/api/intake/tax-return/confirm",
      respondNext: queue([
        jsonResponse(200, {
          saved: [
            { questionId: "job_income_amount", provenance: "tax_return" },
            { questionId: "job_income_frequency", provenance: "tax_return" },
            { questionId: "benefits_income_amount", provenance: "user" },
          ],
          state: S4,
        }),
      ]),
    },
    {
      method: "GET",
      path: "/api/match",
      respondNext: queue([jsonResponse(200, { hasSession: true, matches: [], toResolve: [] })]),
    },
    {
      method: "GET",
      path: "/api/forms/dhb-5200/review",
      respondNext: queue([
        jsonResponse(200, reviewBody("dhb-5200", 2)),
        jsonResponse(200, reviewBody("dhb-5200", 0)),
      ]),
    },
    {
      method: "GET",
      path: "/api/forms/dss-8207/review",
      respondNext: queue([
        jsonResponse(200, reviewBody("dss-8207", 2)),
        jsonResponse(200, reviewBody("dss-8207", 0)),
      ]),
    },
    {
      method: "GET",
      path: "/forms/dhb-5200.pdf",
      respondNext: queue([pdfResponse()]),
    },
    {
      method: "GET",
      path: "/forms/dss-8207.pdf",
      respondNext: queue([pdfResponse()]),
    },
    {
      method: "POST",
      path: "/api/session/purge",
      respondNext: queue([
        jsonResponse(400, { error: { code: "validation_error", message: "not confirmed" } }),
        jsonResponse(200, {
          purged: true,
          deleted: { answers: 6, vaultEntries: 1, turns: 4, auditNotes: 0 },
        }),
      ]),
    },
    {
      method: "GET",
      path: "/api/session",
      respondNext: queue([
        jsonResponse(200, { session: { status: "draft" }, state: S_EMPTY }),
      ]),
    },
  ];
}

/** The sprint talk plan: the two questions the talk stage asks after the
 * quick-questions phase captured the sensitive screen (the county turn's
 * value is private and must never reappear in any body). */
const SPRINT_TALK_PLAN = [
  { id: "application_role", text: "It's for myself.", retry: "Me", intent: "known" },
  {
    id: "county",
    text: "Wake County.",
    retry: "Wake County",
    intent: "known",
    privateValue: "Wake County",
  },
];


const fakeAudioGenerator = (record) => async (text) => {
  record.push(text);
  return new Uint8Array([0x00, 0x01, 0x02]);
};

// The income upload leg's bytes, injected so the unit tests never read
// the real fixture or load the PDF library (the local journey runs prove
// the real bytes parse).
const FAKE_UPLOAD_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

describe("sprint cross-journey (VAL-SPRINT-001: five stages, both consent paths)", () => {
  it("the voice-consented path walks every leg in stage order, with the scripted audio turn first", async () => {
    const spokenTexts = [];
    const transport = fakeTransport(sprintJourneyRoutes());
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    await expect(
      walk.runSprintJourney({
        plan: SPRINT_TALK_PLAN,
        audioGenerator: fakeAudioGenerator(spokenTexts),
        uploadBytes: FAKE_UPLOAD_BYTES,
      }),
    ).resolves.toBe(true);
    expect(walk.violations).toEqual([]);
    expect(exitCodeForRun(true)).toBe(EXIT_OK);
    expect(spokenTexts).toEqual(["It's for myself."]);
    const paths = transport.calls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toEqual([
      "GET /api/health",
      "POST /api/session",
      // Stage 2: the quick-questions phase through the answer route.
      "POST /api/intake/answer",
      // Stage 3: the talk stage — one scripted-audio turn, then typed.
      "POST /api/conversation/turn",
      "POST /api/conversation/turn",
      // Stage 4: the income stage's two legs.
      "POST /api/intake/tax-return",
      "POST /api/intake/tax-return/confirm",
      // Stage 5: the results stage — one session, both applications.
      "GET /api/match",
      "GET /api/forms/dhb-5200/review",
      "GET /forms/dhb-5200.pdf",
      "GET /api/forms/dss-8207/review",
      "GET /forms/dss-8207.pdf",
      // The visible purge: refusal first, then the confirmed erasure.
      "POST /api/session/purge",
      "POST /api/session/purge",
      "GET /api/session",
      "GET /api/forms/dhb-5200/review",
      "GET /api/forms/dss-8207/review",
      "GET /api/health",
    ]);
    // The scripted-audio turn rode the VOICE path: multipart body, voice
    // consent receipt attached; the typed turn carries the AI receipt
    // with voice off (per-send receipts, like the consent surface).
    const turnCalls = transport.calls.filter((call) => call.path === "/api/conversation/turn");
    expect(turnCalls[0].multipart).toBe(true);
    const voiceReceipt = JSON.parse(turnCalls[0].headers["x-bn-consent"]);
    expect(voiceReceipt.ai).toBe(true);
    expect(voiceReceipt.voice).toBe(true);
    expect(turnCalls[1].multipart).toBe(false);
    const typedReceipt = JSON.parse(turnCalls[1].headers["x-bn-consent"]);
    expect(typedReceipt.ai).toBe(true);
    expect(typedReceipt.voice).toBe(false);
    // The income stage's tax proposal saved with tax_return provenance,
    // the typed-over row with user — and the transcript says the results
    // stage was reached with income handled.
    const transcript = walk.lines.join("\n");
    expect(transcript).toContain("income handled");
    expect(transcript).toContain("pre-filled from this session's answers");
  });

  it("the declined-consent path completes with ZERO conversation sends and no consent receipt anywhere", async () => {
    const transport = fakeTransport(sprintJourneyRoutes());
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    await expect(
      walk.runSprintJourney({
        plan: SPRINT_TALK_PLAN,
        consent: "declined",
        uploadBytes: FAKE_UPLOAD_BYTES,
      }),
    ).resolves.toBe(true);
    expect(walk.violations).toEqual([]);
    const paths = transport.calls.map((call) => `${call.method} ${call.path}`);
    // No /api/conversation/turn call at all: the deterministic wizard
    // covered every remaining question through the answer route, and the
    // income stage's routes are the app's own deterministic endpoints.
    expect(paths).toEqual([
      "GET /api/health",
      "POST /api/session",
      "POST /api/intake/answer",
      "POST /api/intake/answer",
      "POST /api/intake/answer",
      "POST /api/intake/tax-return",
      "POST /api/intake/tax-return/confirm",
      "GET /api/match",
      "GET /api/forms/dhb-5200/review",
      "GET /forms/dhb-5200.pdf",
      "GET /api/forms/dss-8207/review",
      "GET /forms/dss-8207.pdf",
      "POST /api/session/purge",
      "POST /api/session/purge",
      "GET /api/session",
      "GET /api/forms/dhb-5200/review",
      "GET /api/forms/dss-8207/review",
      "GET /api/health",
    ]);
    // And no consent receipt rode ANY call — the declined journey never
    // claims a grant the person did not give.
    for (const call of transport.calls) {
      expect(call.headers?.["x-bn-consent"], call.path).toBeUndefined();
    }
  });

  it("the declined path's transcript names the zero-send talk stage honestly", async () => {
    const transport = fakeTransport(sprintJourneyRoutes());
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    await walk.runSprintJourney({
      plan: SPRINT_TALK_PLAN,
      consent: "declined",
    });
    const transcript = walk.lines.join("\n");
    expect(transcript).toContain("zero conversation sends");
  });

  it("a post-purge resume that still carries answers is a journey error", async () => {
    const routes = sprintJourneyRoutes();
    const transport = fakeTransport(routes);
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    // The resume after the purge serves the pre-purge state instead of
    // the empty journey — the client state did not reset.
    routeOf(routes, "GET", "/api/session").respondNext = queue([
      jsonResponse(200, {
        session: { status: "draft" },
        state: {
          ...clientState(
            [v2Question("application_role")],
            { application_role: { status: "known", value: "self" } },
            null,
          ),
          income: incomeBlock(true),
        },
      }),
    ]);
    await expect(
      walk.runSprintJourney({
        plan: SPRINT_TALK_PLAN,
        audioGenerator: fakeAudioGenerator([]),
        uploadBytes: FAKE_UPLOAD_BYTES,
      }),
    ).rejects.toThrow(/did not reset the client state/);
  });

  it("a post-purge review that still pre-fills fields is a journey error", async () => {
    const routes = sprintJourneyRoutes();
    // Both post-purge reviews still carry pre-filled fields (the queue's
    // second response is another prefilled review, not the empty one).
    routeOf(routes, "GET", "/api/forms/dhb-5200/review").respondNext = queue([
      jsonResponse(200, reviewBody("dhb-5200", 2)),
      jsonResponse(200, reviewBody("dhb-5200", 2)),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(
      walk.runSprintJourney({
        plan: SPRINT_TALK_PLAN,
        audioGenerator: fakeAudioGenerator([]),
        uploadBytes: FAKE_UPLOAD_BYTES,
      }),
    ).rejects.toThrow(/did not clear/);
  });
});

describe("sprint cross-journey (VAL-SPRINT-003: purge completeness)", () => {
  it("the unconfirmed purge being accepted is a violation, never a pass", async () => {
    const routes = sprintJourneyRoutes();
    routeOf(routes, "POST", "/api/session/purge").respondNext = queue([
      jsonResponse(200, { purged: true, deleted: { answers: 6, vaultEntries: 1, turns: 4, auditNotes: 0 } }),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(
      walk.runSprintJourney({
        plan: SPRINT_TALK_PLAN,
        audioGenerator: fakeAudioGenerator([]),
        uploadBytes: FAKE_UPLOAD_BYTES,
      }),
    ).resolves.toBe(false);
    expect(walk.violations.map((violation) => violation.kind)).toEqual([
      "purge_unconfirmed_accepted",
    ]);
    expect(exitCodeForRun(false)).toBe(EXIT_VIOLATION);
  });

  it("a purge receipt short of the journey's own ledger is a violation", async () => {
    const routes = sprintJourneyRoutes();
    routeOf(routes, "POST", "/api/session/purge").respondNext = queue([
      jsonResponse(400, { error: { code: "validation_error", message: "not confirmed" } }),
      // The route claims success but deleted nothing the journey saved.
      jsonResponse(200, { purged: true, deleted: { answers: 0, vaultEntries: 0, turns: 0, auditNotes: 0 } }),
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(
      walk.runSprintJourney({
        plan: SPRINT_TALK_PLAN,
        audioGenerator: fakeAudioGenerator([]),
        uploadBytes: FAKE_UPLOAD_BYTES,
      }),
    ).resolves.toBe(false);
    // The all-zero receipt is short of every ledger bound the journey
    // holds (answers, vault rows, transcript rows) — each is named.
    const kinds = walk.violations.map((violation) => violation.kind);
    expect(kinds.length).toBe(3);
    expect(new Set(kinds)).toEqual(new Set(["purge_incomplete"]));
    const detail = JSON.stringify(walk.violations.map((violation) => violation.detail));
    expect(detail).toContain("short of the");
  });

  it("--db-verify captures before/after psql row counts against the session's uuid, and nonzero after-counts are a violation", async () => {
    const routes = sprintJourneyRoutes();
    const dbCalls = [];
    const zeroCounts = { answer: 0, vault_entry: 0, conversation_turn: 0, session_audit_note: 0 };
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes));
    await expect(
      walk.runSprintJourney({
        plan: SPRINT_TALK_PLAN,
        audioGenerator: fakeAudioGenerator([]),
        uploadBytes: FAKE_UPLOAD_BYTES,
        dbVerify: true,
        dbRunner: async (sessionId) => {
          dbCalls.push(sessionId);
          return { ...zeroCounts };
        },
      }),
    ).resolves.toBe(true);
    // The runner ran BEFORE and AFTER the purge, against the session
    // uuid the journey's own cookie carries.
    expect(dbCalls).toEqual([
      "9f0d7bd0-5b0d-4bcc-81f4-35a1cd94d310",
      "9f0d7bd0-5b0d-4bcc-81f4-35a1cd94d310",
    ]);
    const transcript = walk.lines.join("\n");
    expect(transcript).toContain("DB row counts BEFORE");
    expect(transcript).toContain("DB row counts AFTER");
    expect(transcript).toContain("zero rows in answer, vault_entry, conversation_turn, session_audit_note");

    // Now the after-counts come back nonzero: the DB kept rows the purge
    // claimed to delete — a violation, exit 1.
    const failingRoutes = sprintJourneyRoutes();
    const violatingWalk = new Walkthrough("http://fake.test", 1000, fakeTransport(failingRoutes));
    await expect(
      violatingWalk.runSprintJourney({
        plan: SPRINT_TALK_PLAN,
        audioGenerator: fakeAudioGenerator([]),
        uploadBytes: FAKE_UPLOAD_BYTES,
        dbVerify: true,
        dbRunner: async () => ({ answer: 3, vault_entry: 0, conversation_turn: 0, session_audit_note: 0 }),
      }),
    ).resolves.toBe(false);
    expect(violatingWalk.violations.map((violation) => violation.kind)).toEqual([
      "purge_incomplete",
    ]);
  });
});

describe("sprint CLI plumbing", () => {
  it("the sprint mode defaults to the 90s timeout and the voice-consented path", () => {
    const options = parseArgs(["--mode", "sprint"]);
    expect(options.mode).toBe("sprint");
    expect(options.timeoutMs).toBe(90000);
    expect(options.consent).toBe("voice");
    expect(options.dbVerify).toBe(false);
  });

  it("--consent declined and --db-verify parse on the sprint mode", () => {
    const options = parseArgs(["--mode", "sprint", "--consent", "declined", "--db-verify"]);
    expect(options.consent).toBe("declined");
    expect(options.dbVerify).toBe(true);
  });

  it("--consent and --db-verify are sprint-only options", () => {
    expect(() => parseArgs(["--consent", "declined"])).toThrow(WalkthroughError);
    expect(() => parseArgs(["--mode", "conversation", "--consent", "declined"])).toThrow(WalkthroughError);
    expect(() => parseArgs(["--db-verify"])).toThrow(WalkthroughError);
    expect(() => parseArgs(["--mode", "form", "--db-verify"])).toThrow(WalkthroughError);
  });

  it("an unknown --consent value is a journey error", () => {
    expect(() => parseArgs(["--mode", "sprint", "--consent", "bogus"])).toThrow(WalkthroughError);
  });

  it("usage documents the sprint mode and its options", () => {
    const help = usage();
    expect(help).toContain("sprint");
    expect(help).toContain("--consent");
    expect(help).toContain("--db-verify");
  });

});

describe("the scripted voice turn (VAL-SPRINT-001's voice-consented talk)", () => {
  it("renders the spoken sentence to a 16 kHz mono WAV via say + afconvert and cleans up", () => {
    let spoken;
    let aiffPath;
    const fakeExec = (command, args) => {
      if (command === "say") {
        aiffPath = args[1];
        spoken = args[2];
      }
      if (command === "afconvert") {
        writeFileSync(args[args.length - 1], Buffer.from("fake-wav-bytes"));
      }
    };
    const bytes = scriptedWavBytes("It's for myself.", fakeExec);
    expect(spoken).toBe("It's for myself.");
    expect(new TextDecoder().decode(bytes)).toBe("fake-wav-bytes");
    // The scratch directory is gone: the fixture lives only for the turn.
    expect(existsSync(aiffPath)).toBe(false);
  });

  it("a say/afconvert failure is a journey error, never a silent typed fallback", () => {
    const failing = () => {
      throw new Error("no say here");
    };
    expect(() => scriptedWavBytes("hello", failing)).toThrow(WalkthroughError);
    expect(() => scriptedWavBytes("hello", failing)).toThrow(/say \+ afconvert/);
  });
});

// ---------------------------------------------------------------------------
// JOURNEY_PLAN against the app's own intake logic (HACK-133). The journey
// tests above script every served state by hand, so none of them noticed
// when #138 (HACK-130) made the flow ask the persona job_income_seasonal:
// the suite stayed green while `pnpm walkthrough`, the pre-demo check
// docs/runbooks.md recommends, failed in the wizard and the declined
// sprint path. Here every served state is the app's own, so the flow
// engine picks each next question and each skip, and a spec change that
// asks the persona something the plan cannot answer fails this suite.
// ---------------------------------------------------------------------------

/** The app's pure intake modules the flow-backed app below runs, plus the
 * conversation engine's own next-question choice. The CLI never imports
 * app code; its tests may, like the drift tests above. */
async function intakeLogic() {
  const [serialize, answerInput, spec, honesty, conversation] = await Promise.all([
    import("../src/lib/intake/serialize"),
    import("../src/lib/intake/answer-input"),
    import("../src/lib/intake/spec"),
    import("../src/lib/honesty"),
    import("../src/lib/conversation"),
  ]);
  return {
    buildClientState: serialize.buildClientState,
    assertNoPiiValues: serialize.assertNoPiiValues,
    canonicalAnswerValue: answerInput.canonicalAnswerValue,
    QUESTIONS: spec.QUESTIONS,
    QUESTION_BY_ID: spec.QUESTION_BY_ID,
    isAnswerStatus: honesty.isAnswerStatus,
    nextUnansweredQuestion: conversation.nextUnansweredQuestion,
    talkPathSavesQuestion: conversation.talkPathSavesQuestion,
  };
}

/** The pacing waiter for the flow-backed typed journeys: a walk of every
 * question the flow can ask outruns the turn cap's real one-minute wait. */
const noPause = async () => {};

/** The persona's household names, from the plan itself. */
const ROSTER_NAMES = JOURNEY_PLAN.find((step) => step.id === "household_roster").value.map(
  (member) => member.displayName,
);

/**
 * An in-memory app whose intake routes run that logic. The answer route
 * validates with canonicalAnswerValue, the rules validateAnswerInput
 * applies, so a planned value the real route refuses is refused here too.
 * Every served state is buildClientState over the stored answers, through
 * the serializer's pii boundary, which is exactly what
 * POST /api/intake/answer and the session routes return. Only storage is
 * faked: a pii value stays in the map, the way store.ts loadAnswers hands
 * the vault's value back to the flow engine.
 *
 * The conversation turn route answers with a scripted model that hears
 * nothing it can be sure of: for the question the engine asks next (the
 * engine's own choice, nextUnansweredQuestion), the extraction saves an
 * honest "not sure". An unknown answer never satisfies a skip condition
 * (the flow is fail-open), so a typed journey walks every question the
 * flow can ask, whatever a real extraction would have heard, and its plan
 * must cover all of them. A turn that arrives while the served flow shows
 * a question the talk path never asks is refused loudly: the typed
 * journeys answer those in the step-by-step questions, so no household
 * name rides a turn to the model.
 *
 * The sprint journey's later legs never consult the plan, so they answer
 * with the canned shapes sprintJourneyRoutes uses. The one exception is
 * the confirm, which saves its rows into the same answers with the
 * confirm flow's provenances, so the income gate reads real state. The
 * history and the purge count the transcript rows the turns wrote.
 *
 * `held` plan steps are answers the session already holds when the
 * journey opens it.
 */
function flowBackedApp(logic, { held = [] } = {}) {
  let answers = {};
  let turns = [];
  const answeredIds = [];
  const talkedIds = [];
  const save = (questionId, status, value, provenance = "user_supplied") => {
    const question = Object.hasOwn(logic.QUESTION_BY_ID, questionId)
      ? logic.QUESTION_BY_ID[questionId]
      : undefined;
    if (question === undefined || !logic.isAnswerStatus(status)) {
      return false;
    }
    const stored =
      status === "unknown" ? null : logic.canonicalAnswerValue(question, value);
    if (status !== "unknown" && stored === null) {
      return false;
    }
    answers = { ...answers, [questionId]: { status, value: stored, provenance } };
    return true;
  };
  for (const step of held) {
    if (!save(step.id, step.status, step.value)) {
      throw new Error(`flowBackedApp: the answer route refuses the held ${step.id}`);
    }
  }
  const served = () => {
    const state = logic.buildClientState(answers);
    logic.assertNoPiiValues(state);
    return state;
  };
  const sessionBody = () => ({ session: { status: "draft" }, state: served() });
  const transport = async (base, path, options = {}) => {
    const route = `${options.method ?? "GET"} ${path}`;
    if (route === "GET /api/health") {
      return jsonResponse(200, { ok: true });
    }
    if (route === "POST /api/session") {
      // Without a cookie the POST creates the session; with one it saves.
      return options.cookie
        ? jsonResponse(200, sessionBody())
        : jsonResponse(201, sessionBody(), { setCookie: SPRINT_COOKIE });
    }
    if (route === "GET /api/session") {
      return jsonResponse(200, sessionBody());
    }
    if (route === "POST /api/intake/answer") {
      const { questionId, status, value } = options.body;
      if (!save(questionId, status, value)) {
        return jsonResponse(400, { error: { code: "validation_error" } });
      }
      answeredIds.push(questionId);
      return jsonResponse(200, served());
    }
    if (route === "POST /api/conversation/turn") {
      const shown = served();
      const current = shown.currentIndex === null ? null : shown.questions[shown.currentIndex];
      if (current !== null && !logic.talkPathSavesQuestion(current.id)) {
        throw new Error(
          `flowBackedApp: a conversation turn arrived while the flow shows ${current.id}, `
            + "which the talk path never asks",
        );
      }
      const asked = logic.nextUnansweredQuestion(answers);
      if (asked !== null) {
        save(asked.id, "unknown", null);
        talkedIds.push(asked.id);
      }
      const next = logic.nextUnansweredQuestion(answers);
      const reply = next === null ? "That's everything on my list." : "Thanks. Here is the next question.";
      const transcript = "[the person's words, redacted]";
      turns = [
        ...turns,
        { role: "user", transcript, createdAt: "2026-11-03T12:00:00.000Z" },
        { role: "assistant", transcript: reply, createdAt: "2026-11-03T12:00:01.000Z" },
      ];
      return jsonResponse(200, {
        sessionId: "flow-backed-session",
        fresh: false,
        assistantReply: reply,
        assistantTurnId: `turn-${turns.length / 2}`,
        redactedUserTranscript: transcript,
        nextQuestionId: next?.id ?? null,
        state: served(),
      });
    }
    if (route === "GET /api/conversation/history") {
      return jsonResponse(200, { turns, state: served() });
    }
    if (route === "POST /api/intake/tax-return") {
      return jsonResponse(200, {
        readable: true,
        findings: [
          { field: "agi_line_11", value: 12000, origin: "positional_text", confidence: "high" },
        ],
        monthlyDerived: 1000,
        message: null,
      });
    }
    if (route === "POST /api/intake/tax-return/confirm") {
      const saved = [];
      for (const { questionId, action, value } of options.body.confirmations) {
        const provenance = action === "confirm" ? "tax_return" : "user";
        if (!save(questionId, "known", value, provenance)) {
          return jsonResponse(400, { error: { code: "validation_error" } });
        }
        saved.push({ questionId, provenance });
      }
      return jsonResponse(200, { saved, state: served() });
    }
    if (route === "GET /api/match") {
      return jsonResponse(200, { hasSession: true, matches: [], toResolve: [] });
    }
    if (route === "POST /api/session/purge") {
      if (options.body?.confirmed !== true) {
        return jsonResponse(400, { error: { code: "validation_error" } });
      }
      const rows = Object.entries(answers);
      const deleted = {
        answers: rows.length,
        vaultEntries: rows.filter(
          ([id, row]) => logic.QUESTION_BY_ID[id].pii && row.status !== "unknown",
        ).length,
        turns: turns.length,
        auditNotes: 0,
      };
      answers = {};
      turns = [];
      return jsonResponse(200, { purged: true, deleted });
    }
    const review = /^GET \/api\/forms\/([^/]+)\/review$/.exec(route);
    if (review) {
      return jsonResponse(200, reviewBody(review[1], Object.keys(answers).length > 0 ? 2 : 0));
    }
    if (/^GET \/forms\/[^/]+\.pdf$/.test(route)) {
      return pdfResponse();
    }
    throw new Error(`flowBackedApp: no route for ${route}`);
  };
  return { transport, answeredIds, talkedIds, answers: () => answers };
}

/**
 * Every journey JOURNEY_PLAN answers for, run through its own entry point.
 * The wizard (the default mode) answers the whole flow from the plan. The
 * sprint journey's declined path answers the quick questions and then
 * every remaining question from it, with zero conversation sends. The
 * typed journeys (conversation, form, and the sprint journey's voice
 * path) take their quick-questions phase and every step-by-step-only
 * question from it; their talk turns follow walkthrough-plans.mjs, heard
 * by the flow-backed app's scripted model. The quick-questions phase also
 * runs alone, so a work-requirements question it leaves unanswered is
 * named as one.
 */
const PLAN_SERVED_JOURNEYS = Object.freeze({
  wizard: (walk) => walk.run(),
  "sprint --consent declined": (walk) =>
    walk.runSprintJourney({
      consent: "declined",
      uploadBytes: FAKE_UPLOAD_BYTES,
    }),
  "quick-questions phase of conversation, form and sprint voice": async (walk) => {
    await walk.startSession();
    await walk.answerWorkRequirementsLocally();
    const pending = walk.state.quickQuestions.remainingIds.filter((id) =>
      id.startsWith("wr_"),
    );
    if (pending.length > 0) {
      throw new Error(`the quick-questions phase left ${pending.join(", ")} unanswered`);
    }
    return walk.violations.length === 0;
  },
  conversation: (walk) => walk.runConversation(),
  form: (walk) => walk.runFormJourney(),
  "sprint --consent voice": (walk) =>
    walk.runSprintJourney({
      consent: "voice",
      audioGenerator: fakeAudioGenerator([]),
      uploadBytes: FAKE_UPLOAD_BYTES,
    }),
});

describe("JOURNEY_PLAN against the app's own flow engine (HACK-133)", { timeout: 30_000 }, () => {
  it("every planned answer is one the answer route accepts for its question", async () => {
    const logic = await intakeLogic();
    for (const step of JOURNEY_PLAN) {
      expect(Object.hasOwn(logic.QUESTION_BY_ID, step.id), step.id).toBe(true);
      expect(logic.isAnswerStatus(step.status), step.id).toBe(true);
      if (step.status !== "unknown") {
        expect(
          logic.canonicalAnswerValue(logic.QUESTION_BY_ID[step.id], step.value),
          step.id,
        ).not.toBeNull();
      }
    }
  });

  it("asks the persona the seasonal question, skips the 6-month total, and keeps the $580 match on the paycheck", async () => {
    const logic = await intakeLogic();
    const { matchIncome580 } = await import("../src/lib/intake/work-requirements");
    const app = flowBackedApp(logic);
    const walk = new Walkthrough("http://fake.test", 1000, app.transport);
    await expect(walk.run()).resolves.toBe(true);
    expect(app.answeredIds).toContain("job_income_seasonal");
    expect(app.answeredIds).not.toContain("job_income_seasonal_total");
    expect(walk.lines.join("\n")).toContain(
      "job_income_seasonal_total (after job_income_seasonal)",
    );
    // The persona's one year-round biweekly job: the match converts the
    // paycheck, as it did before #138, and proposes the persona's own
    // answer to the $580 screen.
    const match = matchIncome580(app.answers());
    expect(match.countedSourceIds).toEqual(["job_income_amount"]);
    expect(match.proposal).toBe(
      JOURNEY_PLAN.find((step) => step.id === "wr_income_580").value,
    );
  });

  it("the persona's household list matches its counts, and every who-and-which-months entry names a member and a situation the persona reported", async () => {
    const logic = await intakeLogic();
    const { rosterFromAnswers } = await import("../src/lib/intake/roster");
    const { applicableSituations, currentAttribution, parseAttribution } = await import(
      "../src/lib/intake/attribution"
    );
    const app = flowBackedApp(logic);
    const walk = new Walkthrough("http://fake.test", 1000, app.transport);
    await expect(walk.run()).resolves.toBe(true);
    const answers = app.answers();
    const planned = (id) => JOURNEY_PLAN.find((step) => step.id === id).value;
    // The roster the store keeps tells the same story as the counts.
    const roster = rosterFromAnswers(answers);
    expect(roster).toHaveLength(planned("household_size"));
    expect(
      roster.filter((member) => ["under_14", "14_to_17"].includes(member.ageBand)),
    ).toHaveLength(planned("household_children"));
    expect(
      roster.filter((member) => ["60_to_64", "65_plus"].includes(member.ageBand)),
    ).toHaveLength(planned("household_seniors"));
    expect(roster.filter((member) => member.relationship === "self")).toHaveLength(1);
    // Read back the way the review reads it, against the current roster
    // and the situations the persona's own answers make applicable, the
    // attribution loses nothing, and every reported situation has someone.
    const attribution = currentAttribution(answers);
    expect(attribution).toEqual(parseAttribution(planned("wr_who_months")));
    const attributed = new Set(attribution.map((entry) => entry.situationId));
    expect(applicableSituations(answers).map((situation) => situation.id).sort()).toEqual(
      [...attributed].sort(),
    );
    // The parent of a child under 18 with $580 a month: the reporting
    // section, per-person work rows included, stays hidden.
    expect(app.answeredIds).not.toContain("wr_work_rows");
    // Every name reached the store as a private value the walk tracked,
    // and none of them came back in a body (the walk passed).
    expect(walk.privateValues).toEqual(expect.arrayContaining(ROSTER_NAMES));
  });

  it("the branch-only work-reporting answers tell the same story as the household list and the per-person work rows", async () => {
    const { parseRoster } = await import("../src/lib/intake/roster");
    const { parseWorkRows, suggestedWorkRows } = await import("../src/lib/intake/work-activities");
    const planned = (id) => JOURNEY_PLAN.find((step) => step.id === id).value;
    const roster = parseRoster(planned("household_roster"));
    const rows = parseWorkRows(planned("wr_work_rows"));
    expect(rows).not.toBeNull();
    // The rows are the ones the editor offers from the persona's income
    // answers, each for someone on the household list.
    const answers = Object.fromEntries(
      JOURNEY_PLAN.map((step) => [step.id, { status: step.status, value: step.value ?? null }]),
    );
    const offered = suggestedWorkRows(answers, roster);
    expect(rows.map(({ memberId, activity }) => ({ memberId, activity }))).toEqual(
      offered.map(({ memberId, activity }) => ({ memberId, activity })),
    );
    expect(roster.map((member) => member.id)).toEqual(
      expect.arrayContaining(rows.map((row) => row.memberId)),
    );
    // The household-level reporting answers say the same: the kinds of
    // work are the rows' activities, and one person works, so the hours
    // reported are that person's own.
    expect([...new Set(rows.map((row) => row.activity))].sort()).toEqual(
      [...planned("wr_work_activity_types")].sort(),
    );
    expect(new Set(rows.map((row) => row.memberId)).size).toBe(1);
    expect(planned("wr_work_activity_hours")).toBe(
      rows.reduce((hours, row) => hours + row.hours, 0),
    );
  });

  it("PROPERTY: every plan-served journey completes on the real flow, whatever share of the persona's answers its session already holds", async () => {
    // The journeys reach the flow from different points: the wizard from
    // a fresh session, the sprint and typed journeys after their quick-
    // questions phase saved the work-requirements answers. A session that
    // already holds any subset of the persona's own answers covers both,
    // and any stage a later change runs first, so the plan's coverage can
    // never hinge on which stage saved what. The held set shrinks toward
    // the fresh session the CLI starts from. Whichever journey saved the
    // household roster, every name on it is a private value the walk
    // checked every later body for.
    const logic = await intakeLogic();
    const journeys = Object.keys(PLAN_SERVED_JOURNEYS);
    // Every journey but the conversation one draws its held set from the
    // whole plan, so a session that is already complete when it opens is
    // among them. The conversation journey rightly demands at least one
    // stored exchange in its history, so its session never holds the
    // flow's opening question and always has one question left to type.
    // No question skips on that one, so leaving it out narrows no branch.
    const opening = logic.QUESTIONS[0].id;
    expect(JOURNEY_PLAN[0].id).toBe(opening);
    expect(
      logic.QUESTIONS.flatMap((question) => question.skip_conditions).map(
        (condition) => condition.question_id,
      ),
    ).not.toContain(opening);
    const holdable = (journey) =>
      journey === "conversation" ? JOURNEY_PLAN.filter((step) => step.id !== opening) : JOURNEY_PLAN;
    // Each walk prints a full transcript; a failure reports the error
    // that stopped it, which names the question the plan does not cover.
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            ...journeys.map((journey) => fc.tuple(fc.constant(journey), fc.subarray(holdable(journey)))),
          ),
          async ([journey, held]) => {
            const app = flowBackedApp(logic, { held });
            const walk = new Walkthrough("http://fake.test", 1000, app.transport, noPause);
            await expect(PLAN_SERVED_JOURNEYS[journey](walk)).resolves.toBe(true);
            expect(walk.violations).toEqual([]);
            if (app.answeredIds.includes("household_roster")) {
              expect(walk.privateValues).toEqual(expect.arrayContaining(ROSTER_NAMES));
            }
          },
        ),
        {
          // About 33 held sets per journey, what each of the first three
          // journeys got when they alone shared the default 100 runs.
          numRuns: 200,
          // Every journey from a fresh session, the way the CLI runs it,
          // and from a session that already holds all it may hold.
          examples: journeys.flatMap((journey) => [
            [[journey, []]],
            [[journey, [...holdable(journey)]]],
          ]),
        },
      );
    } finally {
      quiet.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// The household roster's names are private values (HACK-133). Since #142
// (HACK-134) a person types the first name or nickname of everyone in the
// household, so the walkthrough tracks each name it saves, the way it
// tracks a typed text answer, and checks every later body for them.
// ---------------------------------------------------------------------------

describe("the household roster's names are private values (HACK-133)", () => {
  it("a roster name that comes back in a later body stops the walk without repeating it", async () => {
    const rosterQ = v2Question("household_roster", { pii: true, type: "roster" });
    const sourcesQ = v2Question("income_sources", { type: "multi_select" });
    const echoed = {
      ...clientState([rosterQ, sourcesQ], { household_roster: { status: "known" } }, 1),
      greeting: `Welcome back, ${ROSTER_NAMES[1]}`,
    };
    const transport = fakeTransport([
      { method: "POST", path: "/api/intake/answer", respondNext: queue([jsonResponse(200, echoed)]) },
    ]);
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    walk.state = clientState([rosterQ, sourcesQ], {}, 0);
    const { stopped } = await walk.answerFlowLocally();
    expect(stopped).toBe(true);
    expect(walk.violations.map((violation) => violation.kind)).toEqual(["pii_value_exposure"]);
    const transcript = walk.lines.join("\n");
    for (const name of ROSTER_NAMES) {
      expect(transcript).not.toContain(name);
    }
  });

  it("PROPERTY: the names a roster answer tracks are exactly the names the store keeps", async () => {
    const { parseRoster, RELATIONSHIP_VALUES, AGE_BAND_VALUES } = await import(
      "../src/lib/intake/roster"
    );
    const rosterQ = v2Question("household_roster", { pii: true, type: "roster" });
    // A name as a person types it: a letter, then anything, with stray
    // spaces around it, which the store trims away.
    const padding = fc.constantFrom("", " ", "  ", "\t");
    const name = fc
      .tuple(padding, fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"), fc.string({ maxLength: 30 }), padding)
      .map((parts) => parts.join(""));
    const others = RELATIONSHIP_VALUES.filter((relationship) => relationship !== "self");
    const member = fc.record({
      displayName: name,
      relationship: fc.constantFrom(...others),
      ageBand: fc.constantFrom(...AGE_BAND_VALUES),
    });
    // At most one member is the person themselves, as the store requires.
    const roster = fc
      .tuple(fc.array(member, { minLength: 1, maxLength: 6 }), fc.boolean())
      .map(([members, firstIsSelf]) =>
        members.map((item, index) => ({
          id: `member-${index + 1}`,
          ...item,
          ...(firstIsSelf && index === 0 ? { relationship: "self" } : {}),
        })),
      );
    fc.assert(
      fc.property(roster, fc.constantFrom("known", "unverified", "unknown"), (value, status) => {
        const stored = parseRoster(value);
        expect(stored).not.toBeNull();
        const tracked = Walkthrough.privateStringsOf(rosterQ, { id: rosterQ.id, status, value });
        expect(tracked).toEqual(status === "unknown" ? [] : stored.map((item) => item.displayName));
      }),
    );
  });

  it("attribution entries, work rows and select answers carry no names to track", () => {
    for (const id of ["wr_who_months", "wr_work_rows", "wr_exempt_situations"]) {
      const step = JOURNEY_PLAN.find((item) => item.id === id);
      const type = { wr_who_months: "attribution", wr_work_rows: "work_activity" }[id] ?? "multi_select";
      expect(Walkthrough.privateStringsOf(v2Question(id, { pii: true, type }), step), id).toEqual([]);
    }
    // Text and date answers are tracked as before; a non-private one never.
    const text = { id: "county", status: "known", value: "Contra Costa County" };
    expect(Walkthrough.privateStringsOf(v2Question("county", { pii: true, type: "text" }), text)).toEqual([
      "Contra Costa County",
    ]);
    expect(Walkthrough.privateStringsOf(v2Question("county", { type: "text" }), text)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Step-by-step-only questions on the typed journeys (HACK-133). Since #142
// (HACK-134) the served flow shows the household roster right after the
// counts, but the talk path never asks it (and #143/#144 added the
// per-person attribution and work rows on the same terms). The typed
// journeys answer those through the answer route from JOURNEY_PLAN, the
// way the person answers them in the step-by-step questions, and track
// the roster's names as private values from the save on.
// ---------------------------------------------------------------------------

describe("step-by-step-only questions on the typed journeys (HACK-133)", () => {
  it("the step-by-step-only types are exactly the questions the talk path never saves", async () => {
    const logic = await intakeLogic();
    for (const question of logic.QUESTIONS) {
      expect(logic.talkPathSavesQuestion(question.id), question.id).toBe(
        !WIZARD_ONLY_QUESTION_TYPES.includes(question.type),
      );
    }
  });

  it("the plans split the spec the way the journeys do", async () => {
    // JOURNEY_PLAN answers the quick-questions phase (every work-
    // requirements question) and every step-by-step-only question; any
    // other question can reach the talk stage, where a typed plan's turn
    // answers it.
    const logic = await intakeLogic();
    const planned = new Set(JOURNEY_PLAN.map((step) => step.id));
    const typedPlans = { CONVERSATION_PLAN, FORM_JOURNEY_PLAN };
    for (const question of logic.QUESTIONS) {
      if (question.id.startsWith("wr_") || WIZARD_ONLY_QUESTION_TYPES.includes(question.type)) {
        expect(planned.has(question.id), `JOURNEY_PLAN has no answer for ${question.id}`).toBe(true);
        continue;
      }
      for (const [name, plan] of Object.entries(typedPlans)) {
        expect(
          plan.some((step) => step.id === question.id),
          `${name} has no turn for ${question.id}`,
        ).toBe(true);
      }
    }
  });

  it("on the scripted model the conversation journey types every talk question the flow can ask, and saves the roster through the answer route", async () => {
    const logic = await intakeLogic();
    const app = flowBackedApp(logic);
    const walk = new Walkthrough("http://fake.test", 1000, app.transport, noPause);
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(walk.runConversation()).resolves.toBe(true);
    } finally {
      quiet.mockRestore();
    }
    // Fail-open: with nothing it can be sure of, the flow asks every talk
    // question it has, the branch-only ones (the seasonal pair, say)
    // included, each once and in spec order, each by a typed turn.
    const talkIds = logic.QUESTIONS.filter(
      (question) => logic.talkPathSavesQuestion(question.id) && !question.id.startsWith("wr_"),
    ).map((question) => question.id);
    expect(app.talkedIds).toEqual(talkIds);
    expect(app.talkedIds).toEqual(
      expect.arrayContaining(["job_income_seasonal", "job_income_seasonal_total"]),
    );
    // The work-requirements questions went through the quick-questions
    // phase and the roster through the step-by-step save, never a turn.
    expect(app.answeredIds).toContain("household_roster");
    expect(app.answeredIds).toContain("wr_who_months");
    expect(walk.privateValues).toEqual(expect.arrayContaining(ROSTER_NAMES));
  });

  /** A talk stage whose flow shows the roster between two talk questions.
   * `savedResponse` turns the served state after the roster save into the
   * answer route's response, so a test can break that response. */
  function rosterTalkRoutes({
    rosterSaved = true,
    savedResponse = (state) => jsonResponse(200, state),
  } = {}) {
    const seniorsQ = v2Question("household_seniors", { type: "number" });
    const rosterQ = v2Question("household_roster", { pii: true, type: "roster" });
    const sourcesQ = v2Question("income_sources", { type: "multi_select" });
    const questions = [seniorsQ, rosterQ, sourcesQ];
    const seniors = { household_seniors: { status: "known", value: 0 } };
    const withRoster = { ...seniors, household_roster: { status: "known" } };
    const S0 = talkOnlyState(clientState(questions, {}, 0));
    const S1 = talkOnlyState(clientState(questions, seniors, 1));
    const S2 = talkOnlyState(clientState(questions, withRoster, 2));
    const S3 = talkOnlyState(
      clientState(questions, { ...withRoster, income_sources: { status: "known", value: ["job"] } }, null),
    );
    const routes = [
      {
        method: "POST",
        path: "/api/conversation/turn",
        respondNext: queue([
          jsonResponse(200, turnBody({ reply: "Thanks.", transcript: "None of us is over 60.", nextQuestionId: "income_sources", state: S1 })),
          jsonResponse(200, turnBody({ reply: "That's everything on my list.", transcript: "A job.", nextQuestionId: null, state: S3 })),
        ]),
      },
      {
        method: "POST",
        path: "/api/intake/answer",
        respondNext: queue([savedResponse(rosterSaved ? S2 : S1)]),
      },
    ];
    return { routes, S0 };
  }

  const ROSTER_TALK_PLAN = [
    { id: "household_seniors", text: "None of us is over 60.", retry: "Zero", intent: "known" },
    { id: "income_sources", text: "A job.", retry: "A job", intent: "known" },
  ];

  it("answers the roster through the answer route in the talk stage, never in a typed turn", async () => {
    const { routes, S0 } = rosterTalkRoutes();
    const transport = fakeTransport(routes);
    const walk = new Walkthrough("http://fake.test", 1000, transport, noPause);
    walk.state = S0;
    await walk.runTurnLoop(ROSTER_TALK_PLAN, "conversation");
    expect(walk.violations).toEqual([]);
    expect(transport.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/conversation/turn",
      "POST /api/intake/answer",
      "POST /api/conversation/turn",
    ]);
    const saved = transport.calls.find((call) => call.path === "/api/intake/answer").body;
    expect(saved).toEqual({
      questionId: "household_roster",
      status: "known",
      value: JOURNEY_PLAN.find((step) => step.id === "household_roster").value,
    });
    expect(walk.turnsSent).toBe(2);
    // The names are private from the save on, and no typed turn carried one.
    expect(walk.privateValues).toEqual(expect.arrayContaining(ROSTER_NAMES));
    for (const call of transport.calls.filter((item) => item.path === "/api/conversation/turn")) {
      for (const name of ROSTER_NAMES) {
        expect(call.body.text).not.toContain(name);
      }
    }
    // The purge ledger counts the roster's vault row.
    expect(walk.purgeLedger().vaultEntries).toBe(1);
    const transcript = walk.lines.join("\n");
    expect(transcript).toContain("household_roster = (answer kept private)");
    expect(transcript).toContain("the talk path never asks this step-by-step question");
    expect(transcript).toContain("1 step-by-step question(s) through the answer route");
    for (const name of ROSTER_NAMES) {
      expect(transcript).not.toContain(name);
    }
  });

  it("a step-by-step-only question the journey plan does not cover is a journey error", async () => {
    const transport = fakeTransport([]);
    const walk = new Walkthrough("http://fake.test", 1000, transport, noPause);
    walk.state = talkOnlyState(
      clientState([v2Question("household_pets", { pii: true, type: "roster" })], {}, 0),
    );
    await expect(walk.runTurnLoop(ROSTER_TALK_PLAN, "conversation")).rejects.toThrow(
      /"household_pets", a step-by-step question the talk path never asks, which the journey plan does not cover/,
    );
    expect(transport.calls).toEqual([]);
  });

  it("an answer route that saves nothing for one is a journey error, never an endless loop", async () => {
    const { routes, S0 } = rosterTalkRoutes({ rosterSaved: false });
    const walk = new Walkthrough("http://fake.test", 1000, fakeTransport(routes), noPause);
    walk.state = S0;
    await expect(walk.runTurnLoop(ROSTER_TALK_PLAN, "conversation")).rejects.toThrow(
      /the answer route saved nothing for "household_roster"/,
    );
  });

  /** The talk stage's two calls up to the roster save, and no further turn. */
  const STOPPED_AT_THE_SAVE = ["POST /api/conversation/turn", "POST /api/intake/answer"];

  /**
   * The roster save's response with one check broken: a household name
   * echoed in the body, a value shipped under the roster, banned promise
   * language, or a quick-questions counter that no longer adds up.
   */
  function brokenSave(state, broken) {
    switch (broken.kind) {
      case "pii_value_exposure": {
        const echo = `${broken.before}${broken.name}${broken.after}`;
        return broken.inPrompt
          ? {
              ...state,
              questions: state.questions.map((item) =>
                item.id === "income_sources" ? { ...item, prompt: echo } : item,
              ),
            }
          : { ...state, greeting: echo };
      }
      case "pii_value_leak":
        return {
          ...state,
          answers: { ...state.answers, household_roster: { status: "known", value: broken.value } },
        };
      case "banned_claim":
        return { ...state, message: broken.claim };
      case "quick_questions_counter": {
        const { quickQuestions, ...rest } = state;
        if (broken.counter === "missing") {
          return rest;
        }
        // The roster save reopened a quick question, or left the roster
        // itself remaining: either way the count grew from the 0 before.
        const remainingIds = [broken.counter === "grown" ? "income_sources" : "household_roster"];
        return {
          ...rest,
          quickQuestions: { ...quickQuestions, remainingIds, remainingCount: 1, complete: false },
        };
      }
      default:
        throw new Error(`brokenSave: no breakage ${broken.kind}`);
    }
  }

  it("PROPERTY: a roster save whose response breaks a check stops the walk there, and never prints a name", async () => {
    // The step-by-step save scans its response the way every other body
    // is scanned, and checks the quick-questions counter. Whichever check
    // a response breaks, the walk records that violation, sends no turn
    // after the save, and neither the transcript nor the violation says a
    // household name.
    const words = fc.string({ maxLength: 12 });
    // A value shipped under the roster: the shapes the store keeps, minus
    // the names, so only the structural check can catch it.
    const nameless = fc.oneof(
      fc.constant(null),
      fc.boolean(),
      fc.integer(),
      fc.array(
        fc.record({
          id: fc.constantFrom("member-1", "member-2", "member-3"),
          relationship: fc.constantFrom("self", "child"),
          ageBand: fc.constantFrom("18_to_54", "under_14", "14_to_17"),
        }),
        { maxLength: 3 },
      ),
    );
    const breakage = fc.oneof(
      fc.record({
        kind: fc.constant("pii_value_exposure"),
        name: fc.constantFrom(...ROSTER_NAMES),
        before: words,
        after: words,
        inPrompt: fc.boolean(),
      }),
      fc.record({ kind: fc.constant("pii_value_leak"), value: nameless }),
      fc.record({
        kind: fc.constant("banned_claim"),
        claim: fc.constantFrom("You are eligible.", "You qualify for this.", "Approval is guaranteed."),
      }),
      fc.record({
        kind: fc.constant("quick_questions_counter"),
        counter: fc.constantFrom("missing", "grown", "roster_still_remaining"),
      }),
    );
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await fc.assert(
        fc.asyncProperty(breakage, async (broken) => {
          const { routes, S0 } = rosterTalkRoutes({
            savedResponse: (state) => jsonResponse(200, brokenSave(state, broken)),
          });
          const transport = fakeTransport(routes);
          const walk = new Walkthrough("http://fake.test", 1000, transport, noPause);
          walk.state = S0;
          await walk.runTurnLoop(ROSTER_TALK_PLAN, "conversation");
          expect(new Set(walk.violations.map((violation) => violation.kind))).toEqual(
            new Set([broken.kind]),
          );
          for (const violation of walk.violations) {
            expect(violation.detail.where).toBe("answer household_roster");
          }
          expect(transport.calls.map((call) => `${call.method} ${call.path}`)).toEqual(
            STOPPED_AT_THE_SAVE,
          );
          const printed = `${walk.lines.join("\n")}\n${JSON.stringify(walk.violations)}`;
          for (const name of ROSTER_NAMES) {
            expect(printed).not.toContain(name);
          }
        }),
        {
          // One of each, the first a name echoed in a greeting.
          examples: [
            [{ kind: "pii_value_exposure", name: ROSTER_NAMES[2], before: "Welcome back, ", after: "", inPrompt: false }],
            [{ kind: "pii_value_leak", value: null }],
            [{ kind: "banned_claim", claim: "You are eligible." }],
            [{ kind: "quick_questions_counter", counter: "grown" }],
          ],
        },
      );
    } finally {
      quiet.mockRestore();
    }
  });

  it("PROPERTY: an answer route that refuses the roster is a journey error, and no turn follows it", async () => {
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 400, max: 599 }),
          fc.constantFrom("validation_error", "not_found", "rate_limited", "internal"),
          async (status, code) => {
            const { routes, S0 } = rosterTalkRoutes({
              savedResponse: () => jsonResponse(status, { error: { code } }),
            });
            const transport = fakeTransport(routes);
            const walk = new Walkthrough("http://fake.test", 1000, transport, noPause);
            walk.state = S0;
            const error = await walk.runTurnLoop(ROSTER_TALK_PLAN, "conversation").then(
              () => null,
              (caught) => caught,
            );
            expect(error).toBeInstanceOf(WalkthroughError);
            expect(error.message).toContain(`step-by-step answer household_roster rejected: ${status}`);
            expect(transport.calls.map((call) => `${call.method} ${call.path}`)).toEqual(
              STOPPED_AT_THE_SAVE,
            );
            // A refused save is no saved answer: the purge ledger skips it.
            expect(walk.savedAnswerIds.has("household_roster")).toBe(false);
          },
        ),
      );
    } finally {
      quiet.mockRestore();
    }
  });
});
