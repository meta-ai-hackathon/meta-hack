import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openPlaidUserId,
  PLAID_HANDLE_TTL_SECONDS,
  sealPlaidUserId,
} from "./user-handle";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const SECRET = "vitest-plaid-handle-secret-0123456789abcdef";
let previousSecret: string | undefined;

beforeEach(() => {
  previousSecret = process.env.PLAID_HANDLE_SECRET;
  process.env.PLAID_HANDLE_SECRET = SECRET;
});

afterEach(() => {
  if (previousSecret === undefined) {
    delete process.env.PLAID_HANDLE_SECRET;
  } else {
    process.env.PLAID_HANDLE_SECRET = previousSecret;
  }
});

describe("Plaid pull handles (HACK-140)", () => {
  it("round-trips a user id for its own session", () => {
    expect(
      openPlaidUserId(SESSION, sealPlaidUserId(SESSION, "user-sandbox-x")),
    ).toBe("user-sandbox-x");
  });

  it("refuses a handle minted for another session", () => {
    expect(
      openPlaidUserId(
        OTHER_SESSION,
        sealPlaidUserId(SESSION, "user-sandbox-x"),
      ),
    ).toBeNull();
  });

  it("refuses a handle signed with the client-known session id instead of the server secret", () => {
    // The pre-review scheme: HMAC keyed by the session id the browser
    // already holds in its cookie. A client could mint this itself.
    const signature = createHmac(
      "sha256",
      `plaid-pull-handle:${SESSION}`,
    )
      .update("user-sandbox-x")
      .digest("base64url");
    expect(
      openPlaidUserId(SESSION, `user-sandbox-x.${signature}`),
    ).toBeNull();
  });

  it("refuses an expired handle", () => {
    const issued =
      Date.now() - (PLAID_HANDLE_TTL_SECONDS + 1) * 1000;
    expect(
      openPlaidUserId(
        SESSION,
        sealPlaidUserId(SESSION, "user-sandbox-x", issued),
      ),
    ).toBeNull();
  });

  it("refuses a tampered signature and a malformed handle", () => {
    const handle = sealPlaidUserId(SESSION, "user-sandbox-x");
    const [payload, signature] = handle.split(".");
    // Flip the FIRST signature character: the final base64url character's
    // unused low bits can decode to the same bytes, so it is a poor tamper.
    const first = signature!.slice(0, 1);
    const tampered = `${payload}.${first === "A" ? "B" : "A"}${signature!.slice(1)}`;
    expect(openPlaidUserId(SESSION, tampered)).toBeNull();
    expect(openPlaidUserId(SESSION, "not-a-handle")).toBeNull();
    expect(openPlaidUserId(SESSION, "user-sandbox-x")).toBeNull();
  });

  it("fails closed when the server secret is missing or too short", () => {
    delete process.env.PLAID_HANDLE_SECRET;
    expect(() => sealPlaidUserId(SESSION, "user-sandbox-x")).toThrow(
      "Plaid is not available right now.",
    );
    expect(
      openPlaidUserId(SESSION, sealPlaidUserIdForTest(SESSION, "user-sandbox-x")),
    ).toBeNull();
    process.env.PLAID_HANDLE_SECRET = "short";
    expect(() => sealPlaidUserId(SESSION, "user-sandbox-x")).toThrow();
    expect(
      openPlaidUserId(SESSION, sealPlaidUserIdForTest(SESSION, "user-sandbox-x")),
    ).toBeNull();
  });
});

/** Mint a handle under the real secret, then leave the env in its test state. */
function sealPlaidUserIdForTest(sessionId: string, userId: string): string {
  const saved = process.env.PLAID_HANDLE_SECRET;
  process.env.PLAID_HANDLE_SECRET = SECRET;
  const handle = sealPlaidUserId(sessionId, userId);
  if (saved === undefined) {
    delete process.env.PLAID_HANDLE_SECRET;
  } else {
    process.env.PLAID_HANDLE_SECRET = saved;
  }
  return handle;
}
