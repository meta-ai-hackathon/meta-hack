import { describe, expect, it } from "vitest";
import { plaidConfig } from "./config";
import { assertBrowserPublicKey, encryptForBrowser } from "./envelope";
import { decryptEnvelope, generateEphemeralBrowserKey } from "./envelope-client";
describe("plaidConfig (fail closed)", () => {
  it("accepts sandbox with both credentials", () => {
    expect(plaidConfig({ PLAID_ENV: "sandbox", PLAID_CLIENT_ID: "id", PLAID_SECRET: "s", NEXT_PUBLIC_PLAID_DEMO_ENABLED: "true" }).baseUrl).toBe("https://sandbox.plaid.com");
  });
  it("rejects production and never echoes the secret", () => {
    expect(() => plaidConfig({ PLAID_ENV: "production", PLAID_CLIENT_ID: "id", PLAID_SECRET: "do-not-leak" })).toThrowError(/^Plaid is not available/);
    try { plaidConfig({ PLAID_ENV: "production", PLAID_CLIENT_ID: "id", PLAID_SECRET: "do-not-leak" }); } catch (e) { expect(String(e)).not.toContain("do-not-leak"); }
  });
  it("rejects missing credentials", () => {
    expect(() => plaidConfig({ PLAID_ENV: "sandbox" })).toThrowError(/^Plaid is not available/);
  });
});
describe("browser key validation before the Plaid fetch", () => {
  it("accepts a generated P-256 SPKI key", async () => {
    const key = await generateEphemeralBrowserKey();
    expect(() => assertBrowserPublicKey(key.publicKeySpki)).not.toThrow();
  });
  it("rejects wrong length, wrong SPKI prefix, and an off-curve point", async () => {
    expect(() => assertBrowserPublicKey("A".repeat(122))).toThrow(/Invalid browser key/);
    const key = await generateEphemeralBrowserKey();
    const bytes = Buffer.from(key.publicKeySpki, "base64url");
    const badPrefix = Buffer.from(bytes);
    badPrefix[0] ^= 0xff;
    expect(() => assertBrowserPublicKey(badPrefix.toString("base64url"))).toThrow(/Invalid browser key/);
    const offCurve = Buffer.from(bytes);
    offCurve[offCurve.length - 1] ^= 0xff;
    offCurve[offCurve.length - 2] ^= 0xff;
    expect(() => assertBrowserPublicKey(offCurve.toString("base64url"))).toThrow();
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
