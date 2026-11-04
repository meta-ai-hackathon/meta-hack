// plaidConfig is the Sandbox-only gate for the HACK-140 bank pull (review P2
// on PR #172). These tests pin the fail-closed behavior: only the exact
// string "sandbox" with both server credentials may produce a config, and no
// browser-exposed variable is ever read.
import { describe, expect, it } from "vitest";
import { plaidConfig } from "./config";

const UNAVAILABLE = "Plaid is not available right now.";

describe("plaidConfig (HACK-140 Sandbox-only gate)", () => {
  it("accepts exactly the Sandbox environment with both credentials", () => {
    expect(
      plaidConfig({
        PLAID_ENV: "sandbox",
        PLAID_CLIENT_ID: "client-id",
        PLAID_SECRET: "server-secret",
      }),
    ).toEqual({
      clientId: "client-id",
      secret: "server-secret",
      env: "sandbox",
      baseUrl: "https://sandbox.plaid.com",
    });
  });

  it("fails closed for every other environment, including case and padding", () => {
    for (const PLAID_ENV of [
      undefined,
      "",
      "production",
      "development",
      "Sandbox",
      "sandbox ",
    ]) {
      expect(() =>
        plaidConfig({
          PLAID_ENV,
          PLAID_CLIENT_ID: "client-id",
          PLAID_SECRET: "server-secret",
        }),
      ).toThrow(UNAVAILABLE);
    }
  });

  it("fails closed without both server credentials", () => {
    for (const env of [
      { PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "client-id" },
      { PLAID_ENV: "sandbox", PLAID_SECRET: "server-secret" },
      { PLAID_ENV: "sandbox", PLAID_CLIENT_ID: " ", PLAID_SECRET: " " },
    ]) {
      expect(() => plaidConfig(env)).toThrow(UNAVAILABLE);
    }
  });

  it("never reads a browser-exposed NEXT_PUBLIC_ variable", () => {
    expect(() =>
      plaidConfig({
        PLAID_ENV: "sandbox",
        NEXT_PUBLIC_PLAID_CLIENT_ID: "client-id",
        NEXT_PUBLIC_PLAID_SECRET: "server-secret",
      }),
    ).toThrow(UNAVAILABLE);
  });
});
