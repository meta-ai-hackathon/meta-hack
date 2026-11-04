// plaidConfig is the fail-closed gate for the HACK-140 bank pull (review P2
// on PR #172). These tests pin every gate: the explicit demo switch must be
// exactly "true", the deployment must be exactly marked "synthetic", AND
// PLAID_ENV must be exactly "sandbox" with both server credentials. They also
// pin the response every route returns while off.
import { describe, expect, it } from "vitest";
import {
  plaidConfig,
  plaidDemoAvailable,
  plaidDemoDisabledResponse,
  plaidDemoEnabled,
} from "./config";

const UNAVAILABLE = "Plaid is not available right now.";
const SANDBOX = {
  PLAID_ENV: "sandbox",
  PLAID_CLIENT_ID: "client-id",
  PLAID_SECRET: "server-secret",
};
const DEMO_ON = {
  ...SANDBOX,
  NEXT_PUBLIC_PLAID_DEMO_ENABLED: "true",
  NEXT_PUBLIC_PLAID_DEMO_DEPLOYMENT: "synthetic",
} as const;

describe("the explicit demo switch", () => {
  it("is off unless the public switch is exactly the string true", () => {
    for (const flag of [
      undefined,
      "",
      "false",
      "TRUE",
      "1",
      "true ",
      "yes",
    ]) {
      expect(
        plaidDemoEnabled({
          NEXT_PUBLIC_PLAID_DEMO_ENABLED: flag,
          NEXT_PUBLIC_PLAID_DEMO_DEPLOYMENT: "synthetic",
        }),
      ).toBe(false);
    }
    expect(
      plaidDemoEnabled({
        NEXT_PUBLIC_PLAID_DEMO_ENABLED: "true",
        NEXT_PUBLIC_PLAID_DEMO_DEPLOYMENT: "synthetic",
      }),
    ).toBe(true);
  });

  it("is off unless the deployment is explicitly marked synthetic", () => {
    for (const marker of [
      undefined,
      "",
      "demo",
      "applicant",
      "production",
      "true",
      "SYNTHETIC",
      "synthetic ",
    ]) {
      expect(
        plaidDemoEnabled({
          NEXT_PUBLIC_PLAID_DEMO_ENABLED: "true",
          NEXT_PUBLIC_PLAID_DEMO_DEPLOYMENT: marker,
        }),
      ).toBe(false);
    }
  });

  it("keeps plaidConfig closed while the demo switch is off", () => {
    for (const flag of [undefined, "", "false", "TRUE"]) {
      expect(() =>
        plaidConfig({
          ...SANDBOX,
          NEXT_PUBLIC_PLAID_DEMO_ENABLED: flag,
          NEXT_PUBLIC_PLAID_DEMO_DEPLOYMENT: "synthetic",
        }),
      ).toThrow(UNAVAILABLE);
    }
  });

  it("answers 404 with no-store and no credential detail while off", async () => {
    const response = plaidDemoDisabledResponse();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Not found." },
    });
  });
});

describe("plaidDemoAvailable (server-rendered card gate)", () => {
  it("offers the card only for an explicitly synthetic, fully configured Sandbox environment", () => {
    expect(plaidDemoAvailable(DEMO_ON)).toBe(true);
  });

  it("never offers the card when PLAID_ENV is not exactly sandbox", () => {
    for (const PLAID_ENV of [
      undefined,
      "",
      "production",
      "development",
      "Sandbox",
      "sandbox ",
    ]) {
      expect(plaidDemoAvailable({ ...DEMO_ON, PLAID_ENV })).toBe(false);
    }
  });

  it("stays closed while either public flag or a credential is missing", () => {
    for (const env of [
      { ...DEMO_ON, NEXT_PUBLIC_PLAID_DEMO_ENABLED: undefined },
      { ...DEMO_ON, NEXT_PUBLIC_PLAID_DEMO_DEPLOYMENT: undefined },
      { ...DEMO_ON, PLAID_CLIENT_ID: undefined },
      { ...DEMO_ON, PLAID_SECRET: undefined },
      { ...DEMO_ON, PLAID_SECRET: " " },
    ]) {
      expect(plaidDemoAvailable(env)).toBe(false);
    }
  });
});

describe("plaidConfig (HACK-140 Sandbox-only gate)", () => {
  it("accepts exactly the Sandbox environment with both credentials and the demo on", () => {
    expect(plaidConfig(DEMO_ON)).toEqual({
      clientId: "client-id",
      secret: "server-secret",
      env: "sandbox",
      baseUrl: "https://sandbox.plaid.com",
    });
  });

  it("pins the broker to the Sandbox base URL, so no route can be pointed elsewhere", () => {
    const config = plaidConfig(DEMO_ON);
    expect(config.env).toBe("sandbox");
    expect(config.baseUrl).toBe("https://sandbox.plaid.com");
  });

  it("never returns a non-Sandbox base URL under any environment", () => {
    for (const override of [
      { PLAID_BASE_URL: "https://production.plaid.com" },
      { PLAID_API_HOST: "https://production.plaid.com" },
      { PLAID_ENV: "production" },
      { PLAID_ENV: "development" },
      { NEXT_PUBLIC_PLAID_BASE_URL: "https://production.plaid.com" },
    ]) {
      try {
        expect(plaidConfig({ ...DEMO_ON, ...override }).baseUrl).toBe(
          "https://sandbox.plaid.com",
        );
      } catch (error) {
        expect(String(error)).toContain(UNAVAILABLE);
      }
    }
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
      expect(() => plaidConfig({ ...DEMO_ON, PLAID_ENV })).toThrow(UNAVAILABLE);
    }
  });

  it("fails closed without both server credentials", () => {
    for (const env of [
      { ...DEMO_ON, PLAID_CLIENT_ID: undefined },
      { ...DEMO_ON, PLAID_SECRET: undefined },
      { ...DEMO_ON, PLAID_CLIENT_ID: " ", PLAID_SECRET: " " },
    ]) {
      expect(() => plaidConfig(env)).toThrow(UNAVAILABLE);
    }
  });

  it("never reads a browser-exposed variable for credentials", () => {
    expect(() =>
      plaidConfig({
        PLAID_ENV: "sandbox",
        NEXT_PUBLIC_PLAID_DEMO_ENABLED: "true",
        NEXT_PUBLIC_PLAID_DEMO_DEPLOYMENT: "synthetic",
        NEXT_PUBLIC_PLAID_CLIENT_ID: "client-id",
        NEXT_PUBLIC_PLAID_SECRET: "server-secret",
      }),
    ).toThrow(UNAVAILABLE);
  });
});
