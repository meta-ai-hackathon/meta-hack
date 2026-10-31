// @vitest-environment jsdom
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBannedClaims } from "../../lib/honesty";
import { SERVER_ANSWERS_COPY, serverAnswerCount } from "./server-answers-notice";

// The notice for answers this browser has saved on the app's server, which
// /intake no longer reads (HACK-99). It checks with a cookie-only read,
// shows only when answers are really there, says the delete also takes any
// chat without guessing where the answers came from (HACK-113), deletes
// only through the HACK-80 purge behind a confirming step, and says exactly
// what the server reported. No request it makes ever carries an answer.

type Call = { readonly url: string; readonly method: string; readonly body: string | undefined };

function stateResponse(answered: number) {
  return new Response(
    JSON.stringify({ questions: [], answers: {}, progress: { answered, remaining: 0, total: answered }, currentIndex: null, complete: true }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function routeNotFound() {
  return new Response(JSON.stringify({ error: { code: "not_found", message: "We couldn't find that page or session." } }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

let calls: Call[];

/** A fetch that answers the state check and the purge from the given plan, recording every call. */
function stubFetch(plan: { state: () => Promise<Response>; purge?: () => Promise<Response> }) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : String(init.body) });
      if (url === "/api/intake/state") {
        return plan.state();
      }
      if (url === "/api/session/purge" && plan.purge) {
        return plan.purge();
      }
      throw new Error(`unexpected request to ${url}`);
    }),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

async function render() {
  vi.resetModules();
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ServerAnswersNotice } = await import("./server-answers-notice");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const { act } = React;
  const settle = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) {
        await new Promise((done) => setTimeout(done, 0));
      }
    });
  };
  await act(async () => {
    root.render(React.createElement(ServerAnswersNotice));
  });
  await settle();
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  const click = async (label: string) => {
    const target = button(label);
    if (!target) {
      throw new Error(`no button "${label}" in: ${container.textContent}`);
    }
    await act(async () => target.click());
    await settle();
  };
  const status = () => container.querySelector('[role="status"]')?.textContent ?? "";
  return { container, button, click, status, unmount: () => act(async () => root.unmount()) };
}

/** No request may carry an answer: only the cookie-only check and the purge's own confirmation. */
function expectNoAnswerSent() {
  for (const call of calls) {
    if (call.url === "/api/intake/state") {
      expect(call).toEqual({ url: "/api/intake/state", method: "GET", body: undefined });
    } else {
      expect(call).toEqual({ url: "/api/session/purge", method: "POST", body: JSON.stringify({ confirmed: true }) });
    }
  }
}

describe("the server answers notice", () => {
  it("shows nothing when this browser has no answers on the server, or the check fails", async () => {
    for (const state of [
      () => Promise.resolve(stateResponse(0)),
      () => Promise.resolve(new Response("oops", { status: 500 })),
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve(new Response("<html>proxy</html>", { status: 200 })),
    ]) {
      stubFetch({ state });
      const page = await render();
      expect(page.container.innerHTML).toBe("");
      expect(calls).toHaveLength(1);
      expectNoAnswerSent();
      await page.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("says how many answers are there, deletes them behind one confirming step, and confirms only what the server did", async () => {
    stubFetch({
      state: () => Promise.resolve(stateResponse(3)),
      purge: () => Promise.resolve(Response.json({ purged: true, deleted: { answers: 3, vaultEntries: 1, turns: 0, auditNotes: 0 } })),
    });
    const page = await render();
    expect(page.container.textContent).toContain(SERVER_ANSWERS_COPY.heading);
    expect(page.container.textContent).toContain("This browser has 3 answers saved on the app's server.");

    // The first click only asks; it sends nothing and moves focus to the safe choice.
    await page.click(SERVER_ANSWERS_COPY.deleteButton);
    expect(calls.filter((call) => call.url === "/api/session/purge")).toHaveLength(0);
    expect(page.container.textContent).toContain(SERVER_ANSWERS_COPY.confirm);
    expect(document.activeElement?.textContent).toBe(SERVER_ANSWERS_COPY.confirmNo);

    // Keep them returns focus to the delete button.
    await page.click(SERVER_ANSWERS_COPY.confirmNo);
    expect(document.activeElement?.textContent).toBe(SERVER_ANSWERS_COPY.deleteButton);

    await page.click(SERVER_ANSWERS_COPY.deleteButton);
    await page.click(SERVER_ANSWERS_COPY.confirmYes);
    expect(page.status()).toBe(SERVER_ANSWERS_COPY.purged);
    expect(page.button(SERVER_ANSWERS_COPY.deleteButton)).toBeUndefined();
    expect(page.container.textContent).not.toContain(SERVER_ANSWERS_COPY.body(3));
    expect(document.activeElement?.id).toBe("server-answers-heading");
    expectNoAnswerSent();
    await page.unmount();
  });

  it("never claims a deletion the server didn't confirm", async () => {
    const cases: { purge: () => Promise<Response>; copy: string }[] = [
      { purge: () => Promise.resolve(routeNotFound()), copy: SERVER_ANSWERS_COPY.noSession },
      { purge: () => Promise.resolve(new Response(JSON.stringify({ error: { code: "validation_error" } }), { status: 400 })), copy: SERVER_ANSWERS_COPY.refused },
      { purge: () => Promise.resolve(new Response("", { status: 502 })), copy: SERVER_ANSWERS_COPY.unknown },
      { purge: () => Promise.reject(new Error("offline")), copy: SERVER_ANSWERS_COPY.unknown },
      // A 404 that isn't the route's own answer (a proxy page) is not proof of anything.
      { purge: () => Promise.resolve(new Response("<html>not found</html>", { status: 404 })), copy: SERVER_ANSWERS_COPY.unknown },
    ];
    for (const { purge, copy } of cases) {
      stubFetch({ state: () => Promise.resolve(stateResponse(2)), purge });
      const page = await render();
      await page.click(SERVER_ANSWERS_COPY.deleteButton);
      await page.click(SERVER_ANSWERS_COPY.confirmYes);
      expect(page.status()).toBe(copy);
      if (copy === SERVER_ANSWERS_COPY.refused || copy === SERVER_ANSWERS_COPY.unknown) {
        // Nothing is known to be removed, so the page still says the answers are there.
        expect(page.container.textContent).toContain(SERVER_ANSWERS_COPY.body(2));
      }
      expectNoAnswerSent();
      await page.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("after an unknown outcome, Check again reads the server and says what it found", async () => {
    let answered = 2;
    stubFetch({
      state: () => Promise.resolve(stateResponse(answered)),
      purge: () => Promise.resolve(new Response("", { status: 504 })),
    });
    const page = await render();
    await page.click(SERVER_ANSWERS_COPY.deleteButton);
    await page.click(SERVER_ANSWERS_COPY.confirmYes);
    expect(page.status()).toBe(SERVER_ANSWERS_COPY.unknown);
    expect(document.activeElement?.textContent).toBe(SERVER_ANSWERS_COPY.checkAgain);

    // The purge did go through behind the timeout.
    answered = 0;
    await page.click(SERVER_ANSWERS_COPY.checkAgain);
    expect(page.status()).toBe(SERVER_ANSWERS_COPY.goneAfterCheck);
    expectNoAnswerSent();
    await page.unmount();
  });

  it("after an unknown outcome, Check again offers the delete again when the answers are still there", async () => {
    stubFetch({
      state: () => Promise.resolve(stateResponse(2)),
      purge: () => Promise.reject(new Error("offline")),
    });
    const page = await render();
    await page.click(SERVER_ANSWERS_COPY.deleteButton);
    await page.click(SERVER_ANSWERS_COPY.confirmYes);
    await page.click(SERVER_ANSWERS_COPY.checkAgain);
    expect(page.button(SERVER_ANSWERS_COPY.deleteButton)).toBeDefined();
    expect(document.activeElement?.textContent).toBe(SERVER_ANSWERS_COPY.deleteButton);
    await page.unmount();
  });
});

describe("serverAnswerCount", () => {
  it("reads the state route's answered count and nothing else", () => {
    expect(serverAnswerCount({ progress: { answered: 4 } })).toBe(4);
    expect(serverAnswerCount({ progress: { answered: 0 } })).toBe(0);
    for (const payload of [null, "x", {}, { progress: {} }, { progress: { answered: -1 } }, { progress: { answered: 1.5 } }, { progress: { answered: "3" } }]) {
      expect(serverAnswerCount(payload)).toBeNull();
    }
  });
});

describe("the notice's copy", () => {
  it("names the count, says the delete also takes the chat, and never guesses where the answers came from", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), (count) => {
        const body = SERVER_ANSWERS_COPY.body(count);
        expect(body).toContain(count === 1 ? "has 1 answer saved" : `has ${count} answers saved`);
        // The server session may be a chat the person is still using
        // (HACK-113), so the body says what the delete takes with it...
        expect(body).toContain("Deleting them also deletes any chat you had with the assistant.");
        // ...and claims neither where the answers came from nor that nothing uses them.
        expect(body).not.toMatch(
          /no longer use|unused|not used|doesn't use|before this page|came from|from this page|from the chat/i,
        );
        expect(findBannedClaims(body)).toEqual([]);
      }),
    );
  });

  it("carries no promise language", () => {
    const lines = Object.values(SERVER_ANSWERS_COPY).map((line) =>
      typeof line === "function" ? line(2) : line,
    );
    for (const line of lines) {
      expect(findBannedClaims(line)).toEqual([]);
    }
  });
});
