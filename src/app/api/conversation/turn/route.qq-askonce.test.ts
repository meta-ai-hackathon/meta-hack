import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../lib/db";
import { runMigrations } from "../../../../lib/migrate";
import { CHAT_MODEL, setModelTransport } from "../../../../lib/model";
import {
  FLOW_MISMATCH_PREFIX,
  type ChatCallScript,
} from "../../../../lib/conversation";
import { firstUnansweredIndex, visibleQuestions, type AnswerMap } from "../../../../lib/intake/flow";
import {
  DEFAULT_PROGRAM_IDS,
  requiredForPrograms,
} from "../../../../lib/intake/requirements";
import {
  QUESTION_BY_ID,
  QUESTIONS,
} from "../../../../lib/intake/spec";
import { SESSION_COOKIE } from "../../../../lib/intake/store";
import type { IntakeClientState } from "../../../../lib/intake/serialize";
import { CONSENT_HEADER } from "../../../../lib/consent";
import { specValueFor } from "../../intake/spec-value-fixture";
import { POST as postAnswer } from "../../intake/answer/route";
import { GET as historyGet } from "../history/route";
import { POST } from "./route";

// The ask-once loop end to end (VAL-QQ-009): questions the QUICK-QUESTIONS
// stage captured never come back in the voice conversation. The quick
// answers save through the real answer route (the stage's own path), then
// the talk stage runs on a scripted transport — no live model calls. What
// the tests pin:
//   - the deterministic next question (firstUnanswered over the visible
//     set) starts at, and proceeds through, genuinely-unanswered questions
//     only — the engine sees the quick answers because they are ordinary
//     saved answers;
//   - the opener's prompt carries the prior answers as answered marks (both
//     the plain and the private mark), which is how the opener can
//     acknowledge them — and never carries their private values;
//   - a model that tries to re-ask a captured quick question is overridden:
//     the deterministic engine replaces the reply, so ask-once holds even
//     against a disagreeing model;
//   - once every required-for-programs question is captured, the talk
//     opener hands off to the first leftover talk-stage question.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_qq_askonce";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const adminUrl = databaseFrom(databaseUrl, "postgres");
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

let admin: postgres.Sql;
let testDb: postgres.Sql;

beforeAll(async () => {
  admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  testDb = postgres(testUrl, { max: 1 });
  process.env.DATABASE_URL = testUrl;
  process.env.MODEL_API_KEY = "sentinel-test-key-never-log";
  await runMigrations(testDb);
});

beforeEach(async () => {
  await testDb`TRUNCATE person, session, answer, vault_entry, conversation_turn CASCADE`;
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await Promise.all([admin.end({ timeout: 1 }), testDb.end({ timeout: 1 })]);
  await closeDb();
});

afterEach(() => {
  setModelTransport(undefined);
});

// ---------------------------------------------------------------------------
// Scripted combined transport (one call per turn), mirroring route.test.ts.
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly body: {
    messages: { role: string; content: string }[];
  };
}

function chatCallBody(content: string): unknown {
  return {
    id: "chatcmpl-test",
    model: CHAT_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content },
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 30,
      total_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 10 },
    },
  };
}

function envelopeContent(step: ChatCallScript): string {
  let answers: unknown = [];
  try {
    const parsed = JSON.parse(step.extraction) as { answers?: unknown };
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.answers)) {
      answers = parsed.answers;
    }
  } catch {
    answers = [];
  }
  return JSON.stringify({
    answers,
    reply: step.reply,
    ...(step.nextQuestionId ? { next_question_id: step.nextQuestionId } : {}),
  });
}

function installScript(steps: readonly ChatCallScript[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const queue = steps.map(envelopeContent);
  setModelTransport(async (_url, init) => {
    calls.push({
      body: JSON.parse(String(init?.body)) as RecordedCall["body"],
    });
    const content = queue.shift();
    if (content === undefined) {
      return new Response(JSON.stringify({ error: { message: "exhausted" } }), {
        status: 500,
      });
    }
    return new Response(JSON.stringify(chatCallBody(content)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

const CONSENTED_AI = JSON.stringify({
  v: 2,
  providerId: "meta-model-api",
  ai: true,
  voice: false,
  at: "2026-10-30T12:00:00.000Z",
});

function turnRequest(text: string, cookie?: string): Request {
  return new Request("http://localhost:3100/api/conversation/turn", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      [CONSENT_HEADER]: CONSENTED_AI,
    },
    body: JSON.stringify({ text }),
  });
}

interface TurnResponse {
  assistantReply: string;
  redactedUserTranscript: string;
  nextQuestionId: string | null;
  state: IntakeClientState;
}

async function cookieOf(response: Response): Promise<string> {
  const header = response.headers.get("set-cookie") ?? "";
  const pair = header.split(";")[0]?.trim() ?? "";
  expect(pair).toContain(`${SESSION_COOKIE}=`);
  return pair;
}

/**
 * Capture quick-question answers through the stage's own route: two plain
 * answers (one the multi-select group), three private ones — a required
 * choice, the required date (whose free-form value is the full-text
 * absence probe), and the optional sensitive citizenship question.
 */
const QUICK_SEED = [
  { questionId: "application_role", status: "known", value: "self" },
  { questionId: "income_sources", status: "known", value: ["job", "benefits"] },
  { questionId: "housing_status", status: "known", value: "rental_or_own" },
  { questionId: "date_of_birth", status: "known", value: "1980-01-31" },
  { questionId: "citizenship_status", status: "known", value: "us_citizen" },
] as const;

async function seedQuickQuestions(): Promise<string> {
  let cookie: string | null = null;
  for (const body of QUICK_SEED) {
    const response = await postAnswer(
      new Request("http://localhost:3100/api/intake/answer", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status, body.questionId).toBe(200);
    if (cookie === null) {
      cookie = await cookieOf(response);
    }
  }
  return cookie as string;
}

/** The deterministic next question for an answer map (the engine's rule). */
function expectedNextQuestionId(answers: AnswerMap): string | null {
  const visible = visibleQuestions(QUESTIONS, answers);
  const index = firstUnansweredIndex(visible, answers);
  return index === -1 ? null : visible[index]!.id;
}

/** The quick answers as the engine (and the server) see them. */
const QUICK_ANSWER_MAP: AnswerMap = Object.fromEntries(
  QUICK_SEED.map((step) => [step.questionId, { status: "known", value: step.value }]),
);

describe("POST /api/conversation/turn — the talk stage after quick questions (VAL-QQ-009)", () => {
  it("the opener asks the first genuinely-unanswered question, with the captured answers marked answered in its grounding", async () => {
    const cookie = await seedQuickQuestions();
    const scripted = "Thanks for those quick answers — what kind of help are you looking for right now?";
    const calls = installScript([
      {
        extraction: JSON.stringify({ answers: [] }),
        reply: scripted,
        nextQuestionId: "main_goal",
      },
    ]);

    const response = await POST(turnRequest("Hi — I did the short list already.", cookie));
    expect(response.status).toBe(200);
    const data = (await response.json()) as TurnResponse;

    // Ask-once: the opener's question is the first UNANSWERED visible
    // question — never a captured quick question.
    expect(data.nextQuestionId).toBe(expectedNextQuestionId(QUICK_ANSWER_MAP));
    expect(data.nextQuestionId).toBe("main_goal");
    for (const step of QUICK_SEED) {
      expect(data.nextQuestionId, step.questionId).not.toBe(step.questionId);
    }
    expect(data.assistantReply).toBe(scripted);
    expect(data.state.quickQuestions.remainingIds).not.toContain("application_role");
    expect(data.state.quickQuestions.remainingIds).not.toContain("housing_status");
    expect(data.state.quickQuestions.remainingIds).toContain("main_goal");

    // The opener's grounding saw the full answer map: every captured
    // question is marked answered (the acknowledgment hook), the private
    // ones with the private mark — and no private VALUE rode the prompt.
    const prompt = calls[0]!.body.messages.find((message) => message.role === "system")!
      .content;
    for (const step of QUICK_SEED) {
      const line = prompt
        .split("\n")
        .find((candidate) => candidate.startsWith(`- (id: ${step.questionId})`));
      expect(line, step.questionId).toBeDefined();
      expect(line!).toContain("already answered");
      expect(line!).not.toContain("not yet answered");
    }
    const privateLine = prompt
      .split("\n")
      .find((candidate) => candidate.startsWith("- (id: housing_status)"));
    expect(privateLine).toContain(
      "[the answer they shared — private, never repeat it]",
    );
    expect(prompt).not.toContain("1980-01-31");
  });

  it("overrides a scripted reply that tries to re-ask a captured quick question (ask-once is engine-enforced)", async () => {
    const cookie = await seedQuickQuestions();
    installScript([
      {
        extraction: JSON.stringify({ answers: [] }),
        // The model disagrees with the server's flow state: it re-asks
        // application_role, already captured on the quick-questions stage.
        reply: "Let me ask again — who is this application for?",
        nextQuestionId: "application_role",
      },
    ]);

    const response = await POST(turnRequest("Hello?", cookie));
    expect(response.status).toBe(200);
    const data = (await response.json()) as TurnResponse;

    // The deterministic engine owns flow control: the re-ask is replaced
    // with the server's next question, and the response's id is the
    // genuinely-unanswered one.
    expect(data.nextQuestionId).toBe("main_goal");
    expect(data.assistantReply).toBe(
      `${FLOW_MISMATCH_PREFIX} ${QUESTION_BY_ID["main_goal"]!.prompt}`,
    );

    // The re-ask never persisted either: the stored assistant turn is the
    // replaced reply.
    const turns = await testDb`
      SELECT redacted_transcript FROM conversation_turn
      WHERE role = 'assistant' ORDER BY created_at ASC, id ASC
    `;
    expect(turns).toHaveLength(1);
    expect(String(turns[0]!.redacted_transcript)).toBe(data.assistantReply);
  });

  it("proceeds across turns through genuinely-unanswered questions only, and the private quick values never appear in any body", async () => {
    const cookie = await seedQuickQuestions();
    installScript([
      {
        extraction: JSON.stringify({
          answers: [
            { question_id: "main_goal", status: "known", value: "food" },
          ],
        }),
        reply: "Got it — help with food. Which state do you live in?",
        nextQuestionId: "state",
      },
      {
        extraction: JSON.stringify({
          answers: [
            { question_id: "state", status: "known", value: "NC" },
          ],
        }),
        reply: "Got it. Which county do you live in?",
        nextQuestionId: "county",
      },
    ]);

    const first = await POST(turnRequest("I need help with food.", cookie));
    expect(first.status).toBe(200);
    const firstBody = await first.text();
    const firstData = JSON.parse(firstBody) as TurnResponse;
    // main_goal=food also SKIPS goal_detail (fail-open no longer applies —
    // the answer is known), so the next question is state.
    expect(firstData.nextQuestionId).toBe("state");

    const second = await POST(turnRequest("North Carolina.", cookie));
    expect(second.status).toBe(200);
    const secondBody = await second.text();
    const secondData = JSON.parse(secondBody) as TurnResponse;
    expect(secondData.nextQuestionId).toBe("county");
    for (const step of QUICK_SEED) {
      expect(secondData.nextQuestionId, step.questionId).not.toBe(step.questionId);
    }
    expect(secondData.nextQuestionId).toBe(
      expectedNextQuestionId({
        ...QUICK_ANSWER_MAP,
        main_goal: { status: "known", value: "food" },
        state: { status: "known", value: "NC" },
      }),
    );

    // The private quick-question values — the date of birth typed on the
    // stage among them — appear in NO client-visible body (turn responses
    // and the history a reload would render) and no stored transcript.
    const history = await historyGet(
      new Request("http://localhost:3100/api/conversation/history", {
        headers: { cookie },
      }),
    );
    expect(history.status).toBe(200);
    const historyBody = await history.text();
    const turnBodies = [firstBody, secondBody];
    for (const body of [...turnBodies, historyBody]) {
      expect(body).not.toContain("1980-01-31");
    }
    const stored = await testDb`
      SELECT redacted_transcript FROM conversation_turn
    `;
    for (const row of stored) {
      expect(String(row.redacted_transcript)).not.toContain("1980-01-31");
    }
  });

  it("hands off to the leftover talk-stage questions once every required-for-programs question is captured", async () => {
    // Capture the ENTIRE required universe through the stage's route,
    // then open the talk stage: the opener asks the first question the
    // quick-questions stage does not cover (the talk stage still covers
    // every spec question), never a captured one.
    let cookie: string | null = null;
    for (const id of requiredForPrograms(DEFAULT_PROGRAM_IDS)) {
      const question = QUESTION_BY_ID[id]!;
      const value = specValueFor(question);
      const response = await postAnswer(
        new Request("http://localhost:3100/api/intake/answer", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(cookie ? { cookie } : {}),
          },
          body: JSON.stringify({ questionId: id, status: "known", value }),
        }),
      );
      expect(response.status, id).toBe(200);
      if (cookie === null) {
        cookie = await cookieOf(response);
      }
    }
    installScript([
      {
        extraction: JSON.stringify({ answers: [] }),
        reply: "That was the short list — are you a student?",
        nextQuestionId: "student_status",
      },
    ]);

    const response = await POST(turnRequest("Done with the short list.", cookie as string));
    expect(response.status).toBe(200);
    const data = (await response.json()) as TurnResponse;
    // The quick-questions stage is complete; the talk continues with the
    // spec questions it never captured (goal_detail is skipped by
    // main_goal=food; student_status is the first leftover).
    expect(data.state.quickQuestions.complete).toBe(true);
    expect(data.nextQuestionId).toBe("student_status");
    for (const id of requiredForPrograms(DEFAULT_PROGRAM_IDS)) {
      expect(data.nextQuestionId, id).not.toBe(id);
    }
  });
});
