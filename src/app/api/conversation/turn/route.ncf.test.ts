import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../../lib/db";
import { runMigrations } from "../../../../lib/migrate";
import { setLogSink } from "../../../../lib/telemetry";
import { CHAT_MODEL, setModelTransport } from "../../../../lib/model";
import {
  FLOW_MISMATCH_PREFIX,
  FOLLOWUP_BLOCKED_PREFIX,
  MAX_FOLLOWUP_LENGTH,
  PARTIAL_SAVE_FALLBACK_PREFIX,
  type ChatCallScript,
} from "../../../../lib/conversation";
import {
  PII_QUESTION_IDS_IN_SPEC,
} from "../../../../lib/intake/spec";
import { CONSENT_HEADER } from "../../../../lib/consent";
import { POST } from "./route";

// Natural-conversation route tests (HACK-106 milestone M3, VAL-NCF-001/
// 003/004): the conversation holds the full visible question set + stored
// answers + recent history so replies ACKNOWLEDGE the prior answer before
// asking the next thing; a multi-sentence turn maps to multiple persisted
// answers; and a model-PROPOSED follow-up question is gated by the
// deterministic engine (banned-claims scan, spec-decided flow, tri-state
// honesty) before it is ever asked. Every model call is scripted — no live
// network calls; the scratch Postgres proves persistence exactly as the
// running app would write it.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_conversation_ncf";

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
  setLogSink(() => undefined);
});

// ---------------------------------------------------------------------------
// Scripted model transports
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly systemPrompt: string;
  readonly messages: { role: string; content: string }[];
}

function chatCallBody(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-ncf-test",
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
  });
}

/** Wrap a script step into the combined envelope JSON the model returns. */
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
    ...(step.nextQuestionId
      ? { next_question_id: step.nextQuestionId }
      : {}),
    ...(step.followup ? { followup: step.followup } : {}),
  });
}

/** A fixed queue of scripted turns; returns the recorded calls. */
function installScript(steps: readonly ChatCallScript[]): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const queue = steps.map(envelopeContent);
  setModelTransport(async (_url, init) => {
    const parsed = JSON.parse(String(init.body)) as {
      messages: { role: string; content: string }[];
    };
    calls.push({
      systemPrompt: parsed.messages[0]?.content ?? "",
      messages: parsed.messages,
    });
    const content = queue.shift();
    if (content === undefined) {
      return new Response(JSON.stringify({ error: { message: "exhausted" } }), {
        status: 500,
      });
    }
    return new Response(chatCallBody(content), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

/**
 * A prompt-REACTIVE transport: each turn's scripted envelope is derived
 * from the request the server actually built (the system prompt + the
 * wrapped user message), so a fixture can prove the prompt carried the
 * prior answer and echo exactly that content back.
 */
function installReactive(
  react: (
    systemPrompt: string,
    userMessage: string,
    callIndex: number,
  ) => ChatCallScript,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  setModelTransport(async (_url, init) => {
    const parsed = JSON.parse(String(init.body)) as {
      messages: { role: string; content: string }[];
    };
    const systemPrompt = parsed.messages[0]?.content ?? "";
    const lastUser = [...parsed.messages]
      .reverse()
      .find((message) => message.role === "user");
    calls.push({ systemPrompt, messages: parsed.messages });
    const step = react(
      systemPrompt,
      lastUser?.content ?? "",
      calls.length - 1,
    );
    return new Response(chatCallBody(envelopeContent(step)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const CONSENTED_AI = JSON.stringify({
  v: 2,
  providerId: "meta-model-api",
  ai: true,
  voice: false,
  at: "2026-10-30T12:00:00.000Z",
});

function turnRequest(
  text: string,
  cookie?: string,
  consent: string | null = CONSENTED_AI,
): Request {
  return new Request("http://localhost:3100/api/conversation/turn", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(consent === null ? {} : { [CONSENT_HEADER]: consent }),
    },
    body: JSON.stringify({ text }),
  });
}

interface TurnResponse {
  assistantReply: string;
  assistantTurnId: string;
  redactedUserTranscript: string;
  nextQuestionId: string | null;
  state: {
    answers: Record<string, { status?: string; value?: unknown }>;
    complete: boolean;
  };
}

async function answerRows(questionId: string): Promise<
  { value: unknown; status: string; provenance: string }[]
> {
  const rows = await testDb`
    SELECT value, status, provenance FROM answer
    WHERE question_id = ${questionId}
  `;
  return rows.map((row) => ({
    value: row.value,
    status: String(row.status),
    provenance: String(row.provenance),
  }));
}

async function assistantTranscripts(): Promise<string[]> {
  const rows = await testDb`
    SELECT redacted_transcript FROM conversation_turn WHERE role = 'assistant'
    ORDER BY created_at ASC, id ASC
  `;
  return rows.map((row) => String(row.redacted_transcript));
}

// The spec flow for the fixtures below (verified against the question
// spec): application_role → main_goal → goal_detail (visible unless
// main_goal is a KNOWN "other"-skipping value; unknown keeps it — fail-
// open) → state → county → household_size → household_children →
// household_seniors → ...

const GOAL_WORDS = ["healthcare", "food"] as const;

/**
 * The reactive script shape for the acknowledgment fixtures: turn 1 opens
 * (application_role), turn 2 answers main_goal from the spoken words, and
 * turn 3 adds detail while the prompt shows main_goal answered STATUS-ONLY.
 * Every declared next question matches the server's spec-decided flow, so
 * the replies (not the mismatch fallback) reach the client.
 */
const ACK_REACTIVE = (
  systemPrompt: string,
  userMessage: string,
  callIndex: number,
): ChatCallScript => {
  if (callIndex === 0) {
    return {
      extraction: JSON.stringify({
        answers: [
          {
            question_id: "application_role",
            status: "known",
            value: "self",
            verbatim: "It's for me",
          },
        ],
      }),
      reply: "Got it. What kind of help are you looking for right now?",
      nextQuestionId: "main_goal",
    };
  }
  if (callIndex === 1) {
    const spoken = GOAL_WORDS.find((word) => userMessage.includes(word));
    return {
      extraction: JSON.stringify({
        answers: [
          {
            question_id: "main_goal",
            status: "known",
            value: spoken ?? "healthcare",
          },
        ],
      }),
      // The acknowledgment reflects the person's OWN WORDS from this
      // turn's message (the consented channel — the extraction input),
      // not a re-injected stored value.
      reply: `Got it — ${spoken ?? "that"} is what you need most. Which state do you live in?`,
      nextQuestionId: "state",
    };
  }
  const prior = systemPrompt.match(
    /\(id: main_goal\) "[^"]*" \(already answered\)/,
  );
  expect(prior).not.toBeNull();
  return {
    extraction: JSON.stringify({
      answers: [
        {
          question_id: "state",
          status: "known",
          value: "NC",
        },
      ],
    }),
    // The flow's next question is county (state answered); the scripted
    // acknowledgment names the answered TOPIC the status mark carried.
    reply: `Thanks for sharing where you live. Which county or city area do you live in?`,
    nextQuestionId: "county",
  };
};

/** Drive the three-turn acknowledgment session; return turn 2's reply. */
async function runAckSession(spokenGoal: "healthcare" | "food"): Promise<string> {
  installReactive(ACK_REACTIVE);
  return (await postAckTurns(spokenGoal)) as string;
}

/** The shared POSTs for the acknowledgment session (transport pre-installed). */
async function postAckTurns(spokenGoal: "healthcare" | "food"): Promise<unknown> {
  const first = await POST(turnRequest("Hi — it's for me."));
  expect(first.status).toBe(200);
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0].trim();
  const second = await POST(
    turnRequest(`I need ${spokenGoal}.`, cookie),
  );
  expect(second.status).toBe(200);
  const acknowledged = (await second.json() as TurnResponse).assistantReply;
  const third = await POST(turnRequest("North Carolina.", cookie));
  expect(third.status).toBe(200);
  return acknowledged;
}

// ---------------------------------------------------------------------------
// VAL-NCF-003 — contextual acknowledgment in assistant replies
// ---------------------------------------------------------------------------

describe("contextual replies grounded on stored answers (VAL-NCF-003)", () => {
  it("grounds the reply on the person's own words and marks prior answers status-only", async () => {
    const calls = installReactive(ACK_REACTIVE);
    const turnTwoReply = (await postAckTurns("healthcare")) as string;
    // Turn 2's reply acknowledged the person's own words from that turn's
    // message (the consented channel), and the engine let it through to
    // the client unchanged.
    expect(turnTwoReply).toBe(
      "Got it — healthcare is what you need most. Which state do you live in?",
    );
    // The turn-2 model call carried the person's words as the extraction
    // input — the grounding for the acknowledgment.
    expect(
      (calls[1]?.messages ?? []).some((message) =>
        message.content.includes("I need healthcare."),
      ),
    ).toBe(true);
    // The stored-answer mark for the prior answer carries the answered
    // STATUS only — never the value or its label (claude-review P1: the
    // vault crossing allowlist is empty and only a person may extend it).
    expect(calls[2]?.systemPrompt).toContain("(id: main_goal)");
    expect(calls[2]?.systemPrompt).toMatch(
      /\(id: main_goal\) "[^"]*" \(already answered\)/,
    );
    expect(calls[2]?.systemPrompt).not.toContain("(already answered: Healthcare)");
    expect(calls[2]?.systemPrompt).not.toContain("(already answered: healthcare)");
  });

  it("writes different acknowledgments for different spoken answers", async () => {
    const replyHealthcare = await runAckSession("healthcare");
    const replyFood = await runAckSession("food");
    // The turn-2 replies differ exactly because the person's words
    // differed — the acknowledgment is grounded on what they said, never
    // a generic re-ask.
    expect(replyHealthcare).not.toBe(replyFood);
  });

  it("hides stored pii values from the reply prompt behind the shared marker", async () => {
    const calls = installScript([
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "date_of_birth",
              status: "known",
              value: "1980-02-03",
              verbatim: "1980-02-03",
            },
          ],
        }),
        reply: "Thanks for sharing that. Who is this application for?",
        nextQuestionId: "application_role",
      },
      {
        extraction: JSON.stringify({ answers: [] }),
        reply: "Take your time.",
        nextQuestionId: "application_role",
      },
    ]);
    const response = await POST(turnRequest("I was born in 1980-02-03."));
    expect(response.status).toBe(200);
    const data = (await response.json()) as TurnResponse;
    expect(data.assistantReply).toBe(
      "Thanks for sharing that. Who is this application for?",
    );
    // The next call's prompt grounds the acknowledgment WITHOUT the value:
    // the pii question reads as the hidden marker.
    const cookie = (response.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();
    await POST(turnRequest("Thanks.", cookie));
    const prompt = calls[1]?.systemPrompt ?? "";
    expect(prompt).toMatch(
      /\(id: date_of_birth\) "[^"]*" \(already answered: \[the answer they shared/,
    );
    expect(prompt).not.toContain("1980-02-03");
  });
});

// ---------------------------------------------------------------------------
// VAL-NCF-001 (server half) — one multi-sentence turn, multiple answers
// ---------------------------------------------------------------------------

describe("multi-answer turns (VAL-NCF-001 server half)", () => {
  it("persists two answers from one multi-sentence turn with tri-state and provenance intact", async () => {
    installScript([
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "application_role",
              status: "known",
              value: "self",
              verbatim: "it's for me",
            },
            {
              question_id: "household_size",
              status: "known",
              value: 3,
            },
          ],
        }),
        reply: "Got it — next question coming up.",
        nextQuestionId: "main_goal",
      },
    ]);
    const response = await POST(
      turnRequest("It's for me, and there are three of us in the household."),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as TurnResponse;
    expect(data.nextQuestionId).toBe("main_goal");
    const roleRows = await answerRows("application_role");
    expect(roleRows).toEqual([
      { value: "self", status: "known", provenance: "user_supplied" },
    ]);
    const sizeRows = await answerRows("household_size");
    expect(sizeRows).toEqual([
      { value: 3, status: "known", provenance: "user_supplied" },
    ]);
  });

  it("keeps an unknown in the same multi-answer turn honest (no value inferred)", async () => {
    installScript([
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "application_role",
              status: "known",
              value: "self",
            },
            {
              question_id: "household_size",
              status: "known",
              value: 3,
            },
            { question_id: "household_children", status: "unknown" },
          ],
        }),
        reply: "No problem — we'll come back to that if needed.",
        nextQuestionId: "main_goal",
      },
    ]);
    const response = await POST(
      turnRequest("It's for me; three of us; the kids' count I'm not sure about."),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as TurnResponse;
    expect(data.nextQuestionId).toBe("main_goal");
    const sizeRows = await answerRows("household_size");
    expect(sizeRows).toEqual([
      { value: 3, status: "known", provenance: "user_supplied" },
    ]);
    const childrenRows = await answerRows("household_children");
    expect(childrenRows).toEqual([
      { value: null, status: "unknown", provenance: "user_supplied" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// VAL-NCF-004 — AI-suggested follow-up is engine-gated
// ---------------------------------------------------------------------------

describe("engine-gated model follow-ups (VAL-NCF-004)", () => {
  it("asks a clean proposed follow-up and keeps the next question spec-decided", async () => {
    installScript([
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "application_role",
              status: "known",
              value: "self",
              verbatim: "It's for me",
            },
          ],
        }),
        reply: "Got it. What kind of help are you looking for right now?",
        nextQuestionId: "main_goal",
      },
      {
        // An unclear answer for main_goal: the model proposes a follow-up
        // while the flow's next question (post-unknown-save, fail-open
        // dependents) stays the server's decision.
        extraction: JSON.stringify({
          answers: [{ question_id: "main_goal", status: "unknown" }],
        }),
        reply:
          "That's alright. When you have a moment, could you tell me in your own words what kind of help you're looking for?",
        followup:
          "When you have a moment, could you tell me in your own words what kind of help you're looking for?",
        nextQuestionId: "goal_detail",
      },
    ]);

    const first = await POST(turnRequest("Hi — it's for me."));
    expect(first.status).toBe(200);
    const cookie = (first.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();

    const second = await POST(turnRequest("I'm not sure, honestly.", cookie));
    expect(second.status).toBe(200);
    const data = (await second.json()) as TurnResponse;
    // The gated follow-up stands — the engine let it through.
    expect(data.assistantReply).toBe(
      "That's alright. When you have a moment, could you tell me in your own words what kind of help you're looking for?",
    );
    // The next question id is the DETERMINISTIC engine's, never the
    // model's choice: with main_goal unknown, dependent questions stay
    // visible (fail-open), so the spec's next unanswered question follows.
    expect(data.nextQuestionId).toBe("goal_detail");
    // The follow-up reply is persisted as the assistant turn.
    const transcripts = await assistantTranscripts();
    expect(transcripts[1]).toBe(data.assistantReply);
    // Tri-state honesty: the unclear answer stayed unknown.
    const goalRows = await answerRows("main_goal");
    expect(goalRows).toEqual([
      { value: null, status: "unknown", provenance: "user_supplied" },
    ]);
  });

  it("replaces a banned follow-up with honest fallback copy before render or persist", async () => {
    installScript([
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "application_role",
              status: "known",
              value: "self",
              verbatim: "It's for me",
            },
          ],
        }),
        reply: "Got it. What kind of help are you looking for right now?",
        nextQuestionId: "main_goal",
      },
      {
        extraction: JSON.stringify({
          answers: [{ question_id: "main_goal", status: "unknown" }],
        }),
        reply: "You're not sure — but you're not eligible for much, so let's move on.",
        followup:
          "You're not sure — but you're not eligible for much, so let's move on.",
        nextQuestionId: "goal_detail",
      },
    ]);

    const first = await POST(turnRequest("Hi — it's for me."));
    const cookie = (first.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();

    const second = await POST(turnRequest("I'm not sure, honestly.", cookie));
    expect(second.status).toBe(200);
    const data = (await second.json()) as TurnResponse;
    // Honest fallback copy replaced the banned follow-up: the engine's
    // keep-going prefix plus the server-decided next question's prompt.
    expect(data.assistantReply).toBe(
      `${FOLLOWUP_BLOCKED_PREFIX} In your own words, what would help the most?`,
    );
    // The banned phrasing appears NOWHERE: not in the response body and
    // not in any persisted turn.
    expect(JSON.stringify(data)).not.toContain("eligible");
    const transcripts = await assistantTranscripts();
    expect(transcripts.every((t) => !t.includes("eligible"))).toBe(true);
    // Skip authority never moved: the response's next question is the
    // spec-decided one.
    expect(data.nextQuestionId).toBe("goal_detail");
  });

  it("replaces an over-long follow-up with honest fallback copy", async () => {
    installScript([
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "application_role",
              status: "known",
              value: "self",
              verbatim: "It's for me",
            },
          ],
        }),
        reply: "Got it. What kind of help are you looking for right now?",
        nextQuestionId: "main_goal",
      },
      {
        extraction: JSON.stringify({ answers: [] }),
        reply: `Let me think. ${"Could you tell me more about your situation? ".repeat(6)}`,
        followup: `Could you tell me more about your situation? ${"Why? ".repeat(MAX_FOLLOWUP_LENGTH)}`,
        nextQuestionId: "main_goal",
      },
    ]);
    const first = await POST(turnRequest("Hi — it's for me."));
    const cookie = (first.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();
    const second = await POST(turnRequest("Thanks.", cookie));
    expect(second.status).toBe(200);
    const data = (await second.json()) as TurnResponse;
    expect(data.assistantReply.startsWith(FOLLOWUP_BLOCKED_PREFIX)).toBe(true);
    expect(data.assistantReply).toContain("What kind of help are you looking for right now?");
  });

  it("keeps the loss disclosure when a blocked follow-up replaces a lossy reply (claude-review P2)", async () => {
    // The extraction had loss (an unmappable answer was dropped) AND the
    // proposed follow-up is banned: the fallback must keep BOTH honest
    // copies — the part-not-saved disclosure ahead of the replaced
    // follow-up — never the disclosure alone, never the follow-up alone.
    installScript([
      {
        extraction: JSON.stringify({
          answers: [
            { question_id: "application_role", status: "known", value: "self" },
          ],
        }),
        reply: "Got it. What kind of help are you looking for right now?",
        nextQuestionId: "main_goal",
      },
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "application_role",
              status: "known",
              value: "construction work",
            },
            { question_id: "main_goal", status: "known", value: "food" },
          ],
        }),
        reply: "You're not sure — but you're not eligible for much, so let's move on.",
        followup:
          "You're not sure — but you're not eligible for much, so let's move on.",
        nextQuestionId: "state",
      },
    ]);
    const first = await POST(turnRequest("Hi, applying for myself."));
    const cookie = (first.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();
    const second = await POST(turnRequest("I need food.", cookie));
    expect(second.status).toBe(200);
    const data = (await second.json()) as TurnResponse;
    expect(data.assistantReply.startsWith(PARTIAL_SAVE_FALLBACK_PREFIX)).toBe(
      true,
    );
    expect(
      data.assistantReply.includes(
        `${PARTIAL_SAVE_FALLBACK_PREFIX} ${FOLLOWUP_BLOCKED_PREFIX}`,
      ),
    ).toBe(true);
    expect(data.assistantReply).toContain("Which state do you live in?");
    // The flow never moved: the model's proposal did not touch it.
    expect(data.nextQuestionId).toBe("state");
  });

  it("never lets a follow-up proposal override the fail-closed flow declaration", async () => {
    installScript([
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "application_role",
              status: "known",
              value: "self",
              verbatim: "It's for me",
            },
          ],
        }),
        reply: "Got it. What kind of help are you looking for right now?",
        nextQuestionId: "main_goal",
      },
      {
        extraction: JSON.stringify({
          answers: [{ question_id: "main_goal", status: "unknown" }],
        }),
        reply: "Sure — tell me about your housing situation instead.",
        followup: "Tell me about your housing situation instead.",
        // The model DECLARES a different next question than the server's
        // spec-decided flow (goal_detail, fail-open dependent of the
        // unknown) — the mismatch replacement must win.
        nextQuestionId: "housing_status",
      },
    ]);

    const first = await POST(turnRequest("Hi — it's for me."));
    const cookie = (first.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();

    const second = await POST(turnRequest("I'm not sure, honestly.", cookie));
    expect(second.status).toBe(200);
    const data = (await second.json()) as TurnResponse;
    // The mismatch branch replaces the reply before the follow-up is even
    // considered: the spoken question is the server's, and the model's
    // proposed redirect never renders.
    expect(data.assistantReply.startsWith(FLOW_MISMATCH_PREFIX)).toBe(true);
    expect(data.assistantReply).toContain(
      "In your own words, what would help the most?",
    );
    expect(data.assistantReply).not.toContain(
      "Tell me about your housing situation instead",
    );
    expect(data.nextQuestionId).toBe("goal_detail");
  });
});

// ---------------------------------------------------------------------------
// Prompt grounding — the follow-up rule and the stored-answer marks
// ---------------------------------------------------------------------------

describe("the combined turn prompt grounds acknowledgment and follow-ups", () => {
  it("marks stored answers status-only and states the follow-up rule", async () => {
    const calls = installScript([
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "application_role",
              status: "known",
              value: "self",
              verbatim: "It's for me",
            },
          ],
        }),
        reply: "Got it. What kind of help are you looking for right now?",
        nextQuestionId: "main_goal",
      },
      {
        extraction: JSON.stringify({ answers: [] }),
        reply: "Take your time.",
        nextQuestionId: "main_goal",
      },
    ]);
    const first = await POST(turnRequest("It's for me."));
    const cookie = (first.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();
    await POST(turnRequest("Thanks.", cookie));

    const prompt = calls[1]?.systemPrompt ?? "";
    // The stored-answer mark carries the answered STATUS only (claude-review
    // P1): what was answered and how settled it is — never the value or the
    // option label the answer maps to.
    expect(prompt).toMatch(
      /\(id: application_role\) "[^"]*" \(already answered\)/,
    );
    expect(prompt).not.toContain("(already answered: Me)");
    expect(prompt).not.toContain("(already answered: self)");
    // The follow-up rule is stated: proposals are allowed, the engine
    // keeps the flow.
    expect(prompt).toContain("followup");
    expect(prompt).toContain("never a determination");
  });

  it("never places any pii question's value in the prompt (full population)", async () => {
    const calls = installScript([
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "application_role",
              status: "known",
              value: "self",
            },
          ],
        }),
        reply: "Got it.",
        nextQuestionId: "main_goal",
      },
      {
        extraction: JSON.stringify({
          answers: [
            {
              question_id: "date_of_birth",
              status: "known",
              value: "1980-02-03",
              verbatim: "1980-02-03",
            },
            {
              question_id: "phone_contact",
              status: "known",
              value: "555-0143",
              verbatim: "555-0143",
            },
          ],
        }),
        reply: "Thanks for sharing.",
        nextQuestionId: "main_goal",
      },
      {
        extraction: JSON.stringify({ answers: [] }),
        reply: "Take your time.",
        nextQuestionId: "main_goal",
      },
    ]);
    const first = await POST(turnRequest("It's for me."));
    const cookie = (first.headers.get("set-cookie") ?? "")
      .split(";")[0]
      .trim();
    await POST(
      turnRequest(
        "My birthday is 1980-02-03 and my phone is 555-0143.",
        cookie,
      ),
    );
    await POST(turnRequest("Thanks.", cookie));
    // The third call's prompt is the grounding surface: assert no raw
    // private value rides in it, and every pii question reads as the
    // marker.
    const prompt = calls[2]?.systemPrompt ?? "";
    expect(prompt).not.toContain("1980-02-03");
    expect(prompt).not.toContain("555-0143");
    for (const piiId of PII_QUESTION_IDS_IN_SPEC) {
      if (piiId === "date_of_birth" || piiId === "phone_contact") {
        expect(prompt).toMatch(
          new RegExp(
            `\\(id: ${piiId}\\)[^\\n]*already answered: \\[the answer they shared`,
          ),
        );
      }
    }
  });
});
