import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHAT_MODEL,
  CHAT_URL,
  MIN_CHAT_MAX_TOKENS,
  chatCompletion,
  resetModelTransport,
  setModelTransport,
  type ChatMessage,
  type ModelTransport,
} from "./model";
import { AppError, setLogSink, type LogLine } from "./telemetry";

// Model client unit tests (Mission v2 M1): a scripted transport proves the
// request shape (pinned model, bearer auth from MODEL_API_KEY only, the
// >= 1024 completion budget), the retry/failure taxonomy, and the per-call
// usage logging contract (VAL-CONV-009) — with zero live network calls.

const SENTINEL_KEY = "sentinel-model-key-abc123";

interface RecordedCall {
  readonly url: string;
  readonly init: { method: string; headers: Record<string, string>; body: string };
}

interface ScriptStep {
  readonly status?: number;
  readonly body?: unknown;
  readonly fail?: Error;
}

function completionBody(
  content: string | null,
  finishReason: string,
): unknown {
  return {
    id: "chatcmpl-test",
    model: CHAT_MODEL,
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: { role: "assistant", content },
      },
    ],
    usage: {
      prompt_tokens: 13,
      completion_tokens: 148,
      total_tokens: 161,
      completion_tokens_details: { reasoning_tokens: 138 },
      prompt_tokens_details: { cached_tokens: 0 },
    },
  };
}

function scriptedTransport(
  steps: readonly ScriptStep[],
): { transport: ModelTransport; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const transport: ModelTransport = async (url, init) => {
    calls.push({
      url,
      init: {
        method: init.method,
        headers: init.headers,
        body: init.body,
      },
    });
    const step = steps[calls.length - 1];
    if (!step) {
      throw new Error("scripted transport queue exhausted");
    }
    if (step.fail) {
      throw step.fail;
    }
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { transport, calls };
}

function collectLogs(): LogLine[] {
  const lines: LogLine[] = [];
  setLogSink((line) => {
    lines.push(JSON.parse(line) as LogLine);
  });
  return lines;
}

const MESSAGES: readonly ChatMessage[] = [
  { role: "system", content: "You are a test assistant." },
  { role: "user", content: "Reply with exactly: OK" },
];

beforeEach(() => {
  process.env.MODEL_API_KEY = SENTINEL_KEY;
});

afterEach(() => {
  resetModelTransport();
  setLogSink(() => undefined);
  delete process.env.MODEL_API_KEY;
  delete process.env.META_API_KEY;
});

describe("chatCompletion request shape", () => {
  it("sends the pinned model, bearer auth, and a completion budget at or above the floor", async () => {
    const { transport, calls } = scriptedTransport([
      { body: completionBody("OK", "stop") },
    ]);
    setModelTransport(transport);

    const result = await chatCompletion(MESSAGES);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CHAT_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
    const requestBody = JSON.parse(calls[0].init.body) as {
      model: string;
      max_tokens: number;
      messages: unknown;
    };
    expect(requestBody.model).toBe(CHAT_MODEL);
    expect(requestBody.max_tokens).toBeGreaterThanOrEqual(MIN_CHAT_MAX_TOKENS);
    expect(requestBody.messages).toEqual(MESSAGES);
    expect(result.content).toBe("OK");
    expect(result.finishReason).toBe("stop");
  });

  it("never sends META_API_KEY material: a missing MODEL_API_KEY fails before any call", async () => {
    delete process.env.MODEL_API_KEY;
    process.env.META_API_KEY = "decoy-key-value";

    const { transport, calls } = scriptedTransport([
      { body: completionBody("OK", "stop") },
    ]);
    setModelTransport(transport);

    await expect(chatCompletion(MESSAGES)).rejects.toMatchObject({
      name: "AppError",
      code: "model_unavailable",
    });
    expect(calls).toHaveLength(0);
  });

  it("rejects a sub-floor completion budget with validation_error before any call", async () => {
    const { transport, calls } = scriptedTransport([]);
    setModelTransport(transport);

    await expect(chatCompletion(MESSAGES, { maxTokens: 512 })).rejects.toMatchObject(
      { name: "AppError", code: "validation_error" },
    );
    expect(calls).toHaveLength(0);
  });
});

describe("chatCompletion usage logging (VAL-CONV-009)", () => {
  it("logs one model_chat_call line with usage and latency and never the key", async () => {
    const { transport, calls } = scriptedTransport([
      { body: completionBody("OK", "stop") },
    ]);
    setModelTransport(transport);
    const logs = collectLogs();

    await chatCompletion(MESSAGES);

    const callLines = logs.filter((line) => line.event === "model_chat_call");
    expect(callLines).toHaveLength(1);
    expect(callLines[0].level).toBe("info");
    expect(callLines[0].promptTokens).toBe(13);
    expect(callLines[0].completionTokens).toBe(148);
    expect(callLines[0].reasoningTokens).toBe(138);
    expect(callLines[0].totalTokens).toBe(161);
    expect(typeof callLines[0].latencyMs).toBe("number");
    expect(callLines[0].latencyMs).toBeGreaterThanOrEqual(0);
    // No key material in ANY log line, and no prompt or completion content.
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SENTINEL_KEY);
    expect(serialized).not.toContain("test assistant");
    expect(calls).toHaveLength(1);
  });
});

describe("chatCompletion retries and failure taxonomy", () => {
  it("retries a transient 429 and succeeds on a later attempt", async () => {
    const { transport, calls } = scriptedTransport([
      { status: 429, body: { error: { message: "slow down" } } },
      { body: completionBody("OK", "stop") },
    ]);
    setModelTransport(transport);

    const result = await chatCompletion(MESSAGES);

    expect(result.content).toBe("OK");
    expect(calls).toHaveLength(2);
  });

  it("retries a length-exhausted null-content response (the reasoning-budget gotcha)", async () => {
    const { transport, calls } = scriptedTransport([
      { body: completionBody(null, "length") },
      { body: completionBody("Recovered", "stop") },
    ]);
    setModelTransport(transport);

    const result = await chatCompletion(MESSAGES);

    expect(result.content).toBe("Recovered");
    expect(calls).toHaveLength(2);
  });

  it("maps exhausted 429s to the rate_limited taxonomy error", async () => {
    const { transport, calls } = scriptedTransport([
      { status: 429, body: {} },
      { status: 429, body: {} },
      { status: 429, body: {} },
    ]);
    setModelTransport(transport);

    const error = await chatCompletion(MESSAGES).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ name: "AppError", code: "rate_limited" });
    expect(calls).toHaveLength(3);
  });

  it("maps exhausted server errors to model_unavailable", async () => {
    const { transport, calls } = scriptedTransport([
      { status: 503, body: {} },
      { status: 503, body: {} },
      { status: 503, body: {} },
    ]);
    setModelTransport(transport);

    const error = await chatCompletion(MESSAGES).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "model_unavailable" });
    expect(calls).toHaveLength(3);
  });

  it("maps exhausted network failures to model_unavailable", async () => {
    const { transport, calls } = scriptedTransport([
      { fail: new Error("socket hung up") },
      { fail: new Error("socket hung up") },
      { fail: new Error("socket hung up") },
    ]);
    setModelTransport(transport);

    const error = await chatCompletion(MESSAGES).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "model_unavailable" });
    expect(calls).toHaveLength(3);
  });

  it("maps persistently null-content responses to model_unavailable", async () => {
    const { transport, calls } = scriptedTransport([
      { body: completionBody(null, "length") },
      { body: completionBody(null, "length") },
      { body: completionBody(null, "length") },
    ]);
    setModelTransport(transport);

    const error = await chatCompletion(MESSAGES).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: "model_unavailable" });
    expect(calls).toHaveLength(3);
  });
});
