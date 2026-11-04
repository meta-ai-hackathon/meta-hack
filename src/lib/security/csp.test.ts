import { describe, expect, it } from "vitest";
import { intakeContentSecurityPolicy } from "./csp";

describe("intake Content-Security-Policy (HACK-140 review P2)", () => {
  it("allows self, Next's inline scripts, and Plaid's SDK, frames, and API", () => {
    const csp = intakeContentSecurityPolicy(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.plaid.com https://plaid.com https://*.plaid.com https://cdn.jsdelivr.net",
    );
    expect(csp).toContain(
      "connect-src 'self' https://sandbox.plaid.com https://plaid.com https://*.plaid.com https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn.jsdelivr.net",
    );
    expect(csp).toContain(
      "frame-src 'self' https://plaid.com https://*.plaid.com",
    );
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("media-src 'self' blob:");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    // Production must not relax the policy for development tooling.
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("ws:");
  });

  it("allows only the audited external origins", () => {
    const csp = intakeContentSecurityPolicy(false);
    const hosts = [...csp.matchAll(/https:\/\/[^\s;]+/g)].map((match) => match[0]);
    expect(new Set(hosts)).toEqual(
      new Set([
        "https://cdn.plaid.com",
        "https://plaid.com",
        "https://*.plaid.com",
        "https://sandbox.plaid.com",
        "https://huggingface.co",
        "https://*.huggingface.co",
        "https://*.hf.co",
        "https://cdn.jsdelivr.net",
      ]),
    );
  });

  it("relaxes only eval and websockets in development", () => {
    const csp = intakeContentSecurityPolicy(true);
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain(" ws: wss:");
  });
});
