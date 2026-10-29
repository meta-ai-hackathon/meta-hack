import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EXIT_JOURNEY_ERROR,
  EXIT_OK,
  EXIT_VIOLATION,
  JOURNEY_PLAN,
  Walkthrough,
  WalkthroughError,
  deepEqual,
  exitCodeForRun,
  parseArgs,
  usage,
} from "./walkthrough-core.mjs";

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
  it("defaults to the local dev server and a 30s timeout", () => {
    expect(parseArgs([])).toEqual({ url: "http://localhost:3100", timeoutMs: 30000 });
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
