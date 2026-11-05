import { describe, expect, it, vi } from "vitest";
import { PlaidClient, type PlaidFetch } from "./client";
const config = { clientId: "cid", secret: "SANDBOX-SECRET-SENTINEL", env: "sandbox" as const, baseUrl: "https://sandbox.plaid.com" as const };
function jsonResponse(body: unknown, ok = true): Response { return { ok, json: async () => body } as Response; }
const report = { bank_income: [{ days_requested: 730, items: [{ bank_income_accounts: [{ account_id: "ACC-SENTINEL", name: "Checking", mask: "1234", type: "depository", subtype: "checking", owners: [{ names: ["OWNER-NAME-SENTINEL"] }] }], bank_income_sources: [{ income_source_id: "SRC-SENTINEL", account_id: "ACC-SENTINEL", income_category: "SALARY", income_description: "ACME PAYROLL", pay_frequency: "BIWEEKLY", total_amount: 6300, transaction_count: 3, start_date: "2026-08-01", end_date: "2026-10-31", historical_summary: [{ start_date: "2026-08-01", end_date: "2026-08-31", total_amounts: [{ amount: 2100 }] }] }] }] }] };
describe("PlaidClient Bank Income", () => {
  it("creates user + Bank Income link token (730 days, bank only)", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn: PlaidFetch = async (url, init) => { bodies.push(JSON.parse(String(init.body))); if (url.endsWith("/user/create")) return jsonResponse({ user_id: "user-sandbox-x" }); if (url.endsWith("/link/token/create")) return jsonResponse({ link_token: "link-x" }); throw new Error(url); };
    const out = await new PlaidClient(config, fetchFn).createLinkToken("session-1");
    expect(out).toEqual({ linkToken: "link-x", userId: "user-sandbox-x" });
    expect(bodies[1]).toMatchObject({ user_id: "user-sandbox-x", products: ["income_verification"], income_verification: { income_source_types: ["bank"], bank_income: { days_requested: 730 } } });
    expect(JSON.stringify(bodies)).not.toContain("transactions");
  });
  it("removes the Plaid user if link-token creation fails", async () => {
    const calls: string[] = [];
    const fetchFn: PlaidFetch = async (url) => {
      calls.push(url);
      if (url.endsWith("/user/create")) return jsonResponse({ user_id: "user-orphan" });
      if (url.endsWith("/link/token/create")) return { ok: false, json: async () => ({ error_code: "INVALID_REQUEST" }) } as Response;
      if (url.endsWith("/user/remove")) return jsonResponse({});
      throw new Error(url);
    };
    await expect(new PlaidClient(config, fetchFn).createLinkToken("session-1")).rejects.toThrow();
    expect(calls.map((u) => u.replace("https://sandbox.plaid.com/", ""))).toEqual([
      "user/create",
      "link/token/create",
      "user/remove",
    ]);
  });
  it("mints a fresh client_user_id for every pull, so two pulls never share a Plaid user", async () => {
    const clientUserIds: unknown[] = [];
    const fetchFn: PlaidFetch = async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url.endsWith("/user/create")) { clientUserIds.push(body.client_user_id); return jsonResponse({ user_id: `user-${clientUserIds.length}` }); }
      if (url.endsWith("/link/token/create")) return jsonResponse({ link_token: "link-x" });
      throw new Error(url);
    };
    const client = new PlaidClient(config, fetchFn);
    await client.createLinkToken("session-1");
    await client.createLinkToken("session-1");
    expect(clientUserIds).toHaveLength(2);
    expect(clientUserIds[0]).not.toEqual(clientUserIds[1]);
    for (const id of clientUserIds) {
      expect(typeof id).toBe("string");
      expect(String(id).length).toBeLessThanOrEqual(128);
      expect(String(id)).not.toContain("session-1");
    }
  });
  it("fetches Bank Income, drops accounts/owners/descriptions, deletes user after", async () => {
    const calls: string[] = [];
    const fetchFn: PlaidFetch = async (url) => { calls.push(url); if (url.endsWith("/credit/bank_income/get")) return jsonResponse(report); if (url.endsWith("/user/remove")) return jsonResponse({}); throw new Error(url); };
    const { payload, removed } = await new PlaidClient(config, fetchFn).pullBankIncome("user-sandbox-x");
    expect(removed).toBe(true);
    const s = JSON.stringify(payload);
    for (const sentinel of ["ACC-SENTINEL", "SRC-SENTINEL", "SANDBOX-SECRET-SENTINEL"]) expect(s).not.toContain(sentinel);
    // Account names, masks, and owner names are absent from the payload
    // entirely (review P1 on PR #172) -- not merely id-scrubbed.
    expect(payload).not.toHaveProperty("accounts");
    expect(payload).not.toHaveProperty("accountOwnerNames");
    expect(s).not.toContain("OWNER-NAME-SENTINEL");
    expect(s).not.toContain("ACME PAYROLL");
    expect(s).not.toContain("Checking");
    expect(payload.streams[0]).toMatchObject({ incomeCategory: "SALARY", totalAmount: 6300, transactionCount: 3, isStripePayout: false });
    expect(calls.map((u) => u.split("/").slice(-2).join("/"))).toEqual(["bank_income/get", "user/remove"]);
  });
  it("reports a failed user removal without losing the report", async () => {
    const fetchFn: PlaidFetch = async (url) => {
      if (url.endsWith("/credit/bank_income/get")) return jsonResponse(report);
      if (url.endsWith("/user/remove")) return { ok: false, json: async () => ({}) } as Response;
      throw new Error(url);
    };
    const { payload, removed } = await new PlaidClient(config, fetchFn).pullBankIncome("u");
    expect(removed).toBe(false);
    expect(payload.streams[0]).toMatchObject({ totalAmount: 6300 });
  });
  it("retries while Bank Income is PRODUCT_NOT_READY, still deletes user on failure", async () => {
    let n = 0; const removed = vi.fn(async () => jsonResponse({}));
    const fetchFn: PlaidFetch = async (url) => { if (url.endsWith("/user/remove")) return removed(); n += 1; return { ok: false, json: async () => ({ error_code: "PRODUCT_NOT_READY" }) } as Response; };
    await expect(new PlaidClient(config, fetchFn).pullBankIncome("u")).rejects.toThrow("Plaid request failed.");
    expect(n).toBe(6); expect(removed).toHaveBeenCalledTimes(1);
  }, 20000);
  it("marks only Stripe descriptions, never forwarding the text", async () => {
    const stripeReport = { bank_income: [{ items: [{ bank_income_sources: [{ income_category: "OTHER", income_description: "STRIPE TRANSFER", pay_frequency: "WEEKLY", total_amount: 500, transaction_count: 2, start_date: "2026-08-01", end_date: "2026-10-31", historical_summary: [] }] }] }] };
    const payload = await new PlaidClient(config, async () => jsonResponse(stripeReport)).fetchBankIncome("u");
    expect(payload.streams[0]?.isStripePayout).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("STRIPE TRANSFER");
  });
});
