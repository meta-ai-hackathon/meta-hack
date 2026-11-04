import { describe, expect, it, vi, beforeEach } from "vitest";
vi.mock("../../../../../lib/intake/store", () => ({
  readSessionCookie: (h: string | null) => h,
  loadSession: async (cookie: string | null) =>
    cookie === "good-cookie"
      ? "11111111-1111-4111-8111-111111111111"
      : cookie === "other-cookie"
        ? "22222222-2222-4222-8222-222222222222"
        : null,
}));
const samplePayload = {
  streams: [{ incomeCategory: "SALARY", isStripePayout: false, payFrequency: "BIWEEKLY", totalAmount: 6300, transactionCount: 3, startDate: "2026-08-01", endDate: "2026-10-31", historicalMonths: [] }],
  pulledAt: "2026-11-03T00:00:00.000Z", dateRange: { start: "2026-08-01", end: "2026-10-31" },
};
const pullBankIncome = vi.fn(async () => ({ payload: samplePayload, removed: true }));
vi.mock("../../../../../lib/plaid/client", () => ({ PlaidClient: class { pullBankIncome = pullBankIncome; createLinkToken = async () => ({ linkToken: "link-sandbox-SENTINEL", userId: "user-sandbox-x" }); } }));
import { POST as pull } from "./route";
import { POST as linkToken } from "../link-token/route";
import { generateEphemeralBrowserKey } from "../../../../../lib/plaid/envelope-client";
function request(url: string, body?: unknown, cookie = "good-cookie"): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function mintHandle(cookie = "good-cookie"): Promise<string> {
  const res = await linkToken(request("http://x/api/intake/plaid/link-token", undefined, cookie));
  return ((await res.json()) as { pullHandle: string }).pullHandle;
}
describe("plaid broker routes", () => {
  beforeEach(() => {
    process.env.PLAID_HANDLE_SECRET = "vitest-plaid-handle-secret-0123456789abcdef";
    pullBankIncome.mockClear();
  });
  it("link-token requires a session and returns a sealed handle, never the raw user id", async () => {
    expect((await linkToken(request("http://x/api/intake/plaid/link-token", undefined, "bad"))).status).toBe(400);
    const res = await linkToken(request("http://x/api/intake/plaid/link-token"));
    const body = (await res.json()) as { linkToken: string; pullHandle?: string; userId?: string };
    expect(body.linkToken).toBe("link-sandbox-SENTINEL");
    expect(body.userId).toBeUndefined();
    expect(body.pullHandle).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  });
  it("pull returns ciphertext only -- no plaintext sentinel in the response", async () => {
    const key = await generateEphemeralBrowserKey();
    const res = await pull(request("http://x/api/intake/plaid/pull", { pullHandle: await mintHandle(), clientPublicKey: key.publicKeySpki }));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("PAYROLL-SENTINEL");
    expect(text).toContain("envelope");
    expect((JSON.parse(text) as { removed: boolean }).removed).toBe(true);
    expect(pullBankIncome).toHaveBeenCalledTimes(1);
    expect(pullBankIncome).toHaveBeenCalledWith("user-sandbox-x");
  });
  it("reports when the Plaid user could not be removed", async () => {
    pullBankIncome.mockResolvedValueOnce({ payload: samplePayload, removed: false });
    const key = await generateEphemeralBrowserKey();
    const res = await pull(request("http://x/api/intake/plaid/pull", { pullHandle: await mintHandle(), clientPublicKey: key.publicKeySpki }));
    const body = (await res.json()) as { removed: boolean; envelope: unknown };
    expect(res.status).toBe(200);
    expect(body.removed).toBe(false);
    expect(body.envelope).toBeTruthy();
  });
  it("rejects a handle minted for another session", async () => {
    const key = await generateEphemeralBrowserKey();
    const res = await pull(request("http://x/api/intake/plaid/pull", { pullHandle: await mintHandle("good-cookie"), clientPublicKey: key.publicKeySpki }, "other-cookie"));
    expect(res.status).toBe(400);
    expect(pullBankIncome).not.toHaveBeenCalled();
  });
  it("rejects a tampered handle and a raw user id", async () => {
    const key = await generateEphemeralBrowserKey();
    const handle = await mintHandle();
    const [payload, sig] = handle.split(".");
    const first = sig?.slice(0, 1);
    const tampered = `${payload}.${first === "A" ? "B" : "A"}${sig?.slice(1)}`;
    expect((await pull(request("http://x/api/intake/plaid/pull", { pullHandle: tampered, clientPublicKey: key.publicKeySpki }))).status).toBe(400);
    expect((await pull(request("http://x/api/intake/plaid/pull", { userId: "user-sandbox-x", clientPublicKey: key.publicKeySpki }))).status).toBe(400);
    expect(pullBankIncome).not.toHaveBeenCalled();
  });
});
