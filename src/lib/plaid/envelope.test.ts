import { describe, expect, it } from "vitest";
import { plaidConfig } from "./config";
import { encryptForBrowser } from "./envelope";
import { decryptEnvelope, generateEphemeralBrowserKey } from "./envelope-client";
describe("plaidConfig (fail closed)", () => {
  it("accepts sandbox with both credentials", () => {
    expect(plaidConfig({ PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "id", PLAID_SECRET: "s" }).baseUrl).toBe("https://sandbox.plaid.com");
  });
  it("rejects production and never echoes the secret", () => {
    expect(() => plaidConfig({ PLAID_ENV: "production", PLAID_CLIENT_ID: "id", PLAID_SECRET: "do-not-leak" })).toThrowError(/^Plaid is not available/);
    try { plaidConfig({ PLAID_ENV: "production", PLAID_CLIENT_ID: "id", PLAID_SECRET: "do-not-leak" }); } catch (e) { expect(String(e)).not.toContain("do-not-leak"); }
  });
  it("rejects missing credentials", () => {
    expect(() => plaidConfig({ PLAID_ENV: "sandbox" })).toThrowError(/^Plaid is not available/);
  });
});
describe("blind-broker envelope round trip", () => {
  it("decrypts in the browser what the server encrypted", async () => {
    const key = await generateEphemeralBrowserKey();
    const envelope = encryptForBrowser(key.publicKeySpki, JSON.stringify({ hello: "SENTINEL-1" }));
    expect(JSON.stringify(envelope)).not.toContain("SENTINEL-1");
    await expect(decryptEnvelope(envelope, key.privateKey)).resolves.toEqual({ hello: "SENTINEL-1" });
  });
  it("tampered ciphertext fails", async () => {
    const key = await generateEphemeralBrowserKey();
    const envelope = encryptForBrowser(key.publicKeySpki, JSON.stringify({ a: 1 }));
    const tampered = { ...envelope, ciphertext: (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1) };
    await expect(decryptEnvelope(tampered, key.privateKey)).rejects.toThrow();
  });
  it("a different browser key cannot decrypt", async () => {
    const key = await generateEphemeralBrowserKey(); const other = await generateEphemeralBrowserKey();
    const envelope = encryptForBrowser(key.publicKeySpki, JSON.stringify({ a: 1 }));
    await expect(decryptEnvelope(envelope, other.privateKey)).rejects.toThrow();
  });
});
