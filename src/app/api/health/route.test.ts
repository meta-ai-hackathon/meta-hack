import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";
import { setLogSink, type LogLine } from "../../../lib/telemetry";

function captureLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  setLogSink((line) => lines.push(line));
  return { lines, restore: () => setLogSink((line) => console.log(line)) };
}

let restoreSink: () => void = () => {};

afterEach(() => {
  restoreSink();
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("returns ok: true", async () => {
    const response = GET(new Request("http://localhost:3100/api/health"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});

describe("/api/health request-id wiring (BN-06)", () => {
  it("echoes a valid incoming x-request-id and logs with it", () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    const response = GET(
      new Request("http://localhost:3100/api/health", {
        headers: { "x-request-id": "req_test_123" },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req_test_123");
    const parsed = JSON.parse(captured.lines[0]) as LogLine;
    expect(parsed.requestId).toBe("req_test_123");
    expect(parsed.event).toBe("health.checked");
  });

  it("creates a clean fresh id when the header is missing or junk", async () => {
    const captured = captureLines();
    restoreSink = captured.restore;

    for (const headers of [
      new Headers(),
      new Headers({ "x-request-id": 'bad id with "quotes"' }),
    ]) {
      const response = GET(
        new Request("http://localhost:3100/api/health", { headers }),
      );
      expect(response.status).toBe(200);
      const echoed = response.headers.get("x-request-id") ?? "";
      expect(echoed).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      await expect(response.json()).resolves.toEqual({ ok: true });
      const parsed = JSON.parse(
        captured.lines[captured.lines.length - 1],
      ) as LogLine;
      expect(parsed.requestId).toBe(echoed);
    }
  });
});
