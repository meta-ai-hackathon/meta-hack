import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BN25_SESSION_STATUSES,
  EXIT_JOURNEY_ERROR,
  EXIT_OK,
  EXIT_VIOLATION,
  JOURNEY_PLAN,
  SAMPLE_FORM_ID,
  Walkthrough,
  WalkthroughError,
  deepEqual,
  exitCodeForRun,
  parseArgs,
  usage,
} from "./walkthrough-core.mjs";
import {
  CONVERSATION_PLAN,
  FORM_JOURNEY_PLAN,
  SAMPLE_FORM_UNMAPPED_ANSWERS,
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
  return {
    questions,
    answers,
    progress: { answered: questions.length, remaining: 0, total: questions.length },
    currentIndex: complete ? null : currentIndex,
    complete,
  };
}

/** A scripted transport: each route matches (method, path) and answers
 * from a queue of canned responses. */
function fakeTransport(routes) {
  const calls = [];
  const transport = async (base, path, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ method, path });
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
    expect(parseArgs([])).toEqual({ url: "http://localhost:3100", timeoutMs: 30000, mode: "wizard" });
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

/** A two-question scripted conversation: one plain question, one pii
 * free-form one whose redacted transcript carries the app's marker. */
function v2JourneyRoutes({ formId = "form-x", historyTurns, finalState } = {}) {
  const appRoleQ = v2Question("application_role");
  const countyQ = v2Question("county", { pii: true, type: "text" });
  const initialState = clientState([appRoleQ, countyQ], {}, 0);
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
      method: "POST",
      path: `/api/forms/${formId}/fill`,
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

const MINI_UNMAPPED = { name_field: "Jamie Watts" };

describe("v2 conversational journey (VAL-WALK2-001 / VAL-X2-001 contract)", () => {
  it("walks every leg cleanly: turns, match, review, save, resume, history, PDF", async () => {
    const transport = fakeTransport(v2JourneyRoutes());
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    await expect(
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x", unmappedAnswers: MINI_UNMAPPED }),
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
      "POST /api/forms/form-x/fill",
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
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x", unmappedAnswers: MINI_UNMAPPED }),
    ).resolves.toBe(false);
    expect(walk.violations.map((violation) => violation.kind)).toContain("assistant_banned_claim");
    expect(exitCodeForRun(false)).toBe(EXIT_VIOLATION);
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
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x", unmappedAnswers: MINI_UNMAPPED }),
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
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x", unmappedAnswers: MINI_UNMAPPED }),
    ).resolves.toBe(false);
    expect(walk.violations.map((violation) => violation.kind)).toContain("pii_echo");
  });

  it("a turn that saves nothing for the asked question twice is a journey error", async () => {
    const routes = v2JourneyRoutes();
    const stuckState = clientState(
      [v2Question("application_role"), v2Question("county", { pii: true, type: "text" })],
      {},
      0,
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
      walk.runConversation({ plan: MINI_PLAN, formId: "form-x", unmappedAnswers: MINI_UNMAPPED }),
    ).rejects.toBeInstanceOf(WalkthroughError);
  });
});

describe("v2 form-driven journey (VAL-WALK2-003 contract)", () => {
  it("walks turns, review, and the fill round-trip cleanly", async () => {
    const transport = fakeTransport(v2JourneyRoutes());
    const walk = new Walkthrough("http://fake.test", 1000, transport);
    await expect(
      walk.runFormJourney({ plan: MINI_PLAN, formId: "form-x", unmappedAnswers: MINI_UNMAPPED }),
    ).resolves.toBe(true);
    expect(walk.violations).toEqual([]);
    const paths = transport.calls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toEqual([
      "GET /api/health",
      "POST /api/session",
      "POST /api/conversation/turn",
      "POST /api/conversation/turn",
      "GET /api/forms/form-x/review",
      "POST /api/forms/form-x/fill",
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
      walk.runFormJourney({ plan: MINI_PLAN, formId: "form-x", unmappedAnswers: MINI_UNMAPPED }),
    ).rejects.toThrow(/still needs/);
  });

  it("a fill that returns a non-PDF body is a journey error", async () => {
    const routes = v2JourneyRoutes();
    routeOf(routes, "POST", "/api/forms/form-x/fill").respondNext = queue([
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
      walk.runFormJourney({ plan: MINI_PLAN, formId: "form-x", unmappedAnswers: MINI_UNMAPPED }),
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

  it("the sample form's unmapped answers stay off the mapped fields", () => {
    expect(Object.keys(SAMPLE_FORM_UNMAPPED_ANSWERS).sort()).toEqual(["applicant_name", "case_number"]);
  });
});

describe("v2 CLI argument parsing", () => {
  it("defaults to the wizard mode and its 30s timeout", () => {
    expect(parseArgs([])).toEqual({ url: "http://localhost:3100", timeoutMs: 30000, mode: "wizard" });
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
});
