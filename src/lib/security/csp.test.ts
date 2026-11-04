import { describe, expect, it } from "vitest";
import { intakeContentSecurityPolicy } from "./csp";

describe("intake Content-Security-Policy (HACK-140 review P2)", () => {
  it("allows self, Next's inline scripts, and Plaid's SDK, frames, and API", () => {
    const csp = intakeContentSecurityPolicy(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' https://cdn.plaid.com https://plaid.com https://*.plaid.com",
    );
    expect(csp).toContain(
      "connect-src 'self' https://sandbox.plaid.com https://plaid.com https://*.plaid.com",
    );
    expect(csp).toContain(
      "frame-src 'self' https://plaid.com https://*.plaid.com",
    );
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    // Production must not relax the policy for development tooling.
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("ws:");
  });

  it("relaxes only eval and websockets in development", () => {
    const csp = intakeContentSecurityPolicy(true);
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain(" ws: wss:");
  });
});
