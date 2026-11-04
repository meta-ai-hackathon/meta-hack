import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../../../lib/intake/store", () => ({
  readSessionCookie: (h: string | null) => h,
  loadSession: async (cookie: string | null) =>
    cookie === "good-cookie"
      ? "11111111-1111-4111-8111-111111111111"
      : cookie === "other-cookie"
        ? "22222222-2222-4222-8222-222222222222"
        : null,
}));
const removeUser = vi.fn(async () => undefined);
vi.mock("../../../../../lib/plaid/client", () => {
  class PlaidApiError extends Error {
    constructor(readonly code: string) {
      super("Plaid request failed.");
    }
  }
  return {
    PlaidClient: class {
      removeUser = removeUser;
    },
    PlaidApiError,
  };
});
import { PlaidApiError } from "../../../../../lib/plaid/client";
import { POST as remove } from "./route";
import { sealPlaidUserId } from "../../../../../lib/plaid/user-handle";

const SESSION = "11111111-1111-4111-8111-111111111111";
const SECRET = "vitest-plaid-handle-secret-0123456789abcdef";

function request(body?: unknown, cookie = "good-cookie"): Request {
  return new Request("http://x/api/intake/plaid/remove", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("plaid user cleanup route", () => {
  beforeEach(() => {
    process.env.PLAID_HANDLE_SECRET = SECRET;
    removeUser.mockClear();
  });

  it("removes the Plaid user named by a valid handle for this session", async () => {
    const res = await remove(
      request({ pullHandle: sealPlaidUserId(SESSION, "user-sandbox-x") }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
    expect(removeUser).toHaveBeenCalledWith("user-sandbox-x");
  });

  it("requires a session and refuses another session's handle", async () => {
    const handle = sealPlaidUserId(SESSION, "user-sandbox-x");
    expect((await remove(request({ pullHandle: handle }, "other-cookie"))).status).toBe(400);
    expect((await remove(request({ pullHandle: handle }, "no-cookie"))).status).toBe(400);
    expect(removeUser).not.toHaveBeenCalled();
  });

  it("refuses a forged or missing handle", async () => {
    expect((await remove(request({ pullHandle: "user-sandbox-x.forged" }))).status).toBe(400);
    expect((await remove(request({}))).status).toBe(400);
    expect(removeUser).not.toHaveBeenCalled();
  });

  it("stays idempotent when Plaid already removed the user", async () => {
    removeUser.mockRejectedValueOnce(new PlaidApiError("USER_NOT_FOUND"));
    const res = await remove(
      request({ pullHandle: sealPlaidUserId(SESSION, "user-sandbox-x") }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: true });
  });

  it("reports a real removal failure instead of claiming success", async () => {
    removeUser.mockRejectedValueOnce(new Error("network down"));
    const res = await remove(
      request({ pullHandle: sealPlaidUserId(SESSION, "user-sandbox-x") }),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal");
  });
});
