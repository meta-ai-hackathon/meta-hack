import { createHash, randomUUID } from "node:crypto";
import { plaidConfig, type PlaidConfig } from "./config";
// Minimal Plaid Sandbox Bank Income client (HACK-140). Uses fetch against
// the Sandbox host only -- config fails closed for any other environment.
// We use Plaid Bank Income (not Transactions): Plaid classifies deposit
// streams into income_category values server-side. Bodies, tokens, and
// account data are never logged here or by callers. Fetch is injectable.
export type PlaidFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface MinimizedPlaidStream {
  readonly incomeCategory: string; readonly incomeDescription: string;
  readonly payFrequency: string; readonly totalAmount: number; readonly transactionCount: number;
  readonly startDate: string; readonly endDate: string;
  readonly historicalMonths: readonly { readonly startDate: string; readonly endDate: string; readonly total: number }[];
}
export interface MinimizedPlaidPayload {
  readonly accounts: readonly { readonly name: string; readonly officialName: string | null; readonly mask: string | null; readonly type: string; readonly subtype: string | null }[];
  readonly streams: readonly MinimizedPlaidStream[];
  /** Account-owner names Plaid reports for the linked accounts (the account holder's name, for matching to a household member). */
  readonly accountOwnerNames: readonly string[];
  readonly pulledAt: string;
  readonly dateRange: { readonly start: string; readonly end: string };
}
interface BankIncomeSourceRaw {
  income_category?: string; income_description?: string; pay_frequency?: string;
  total_amount?: number; transaction_count?: number; start_date?: string; end_date?: string;
  historical_summary?: { start_date?: string; end_date?: string; total_amount?: number; total_amounts?: { amount?: number }[] }[];
}
interface BankIncomeReportRaw {
  days_requested?: number; generated_time?: string;
  items?: { bank_income_accounts?: { name?: string; official_name?: string | null; mask?: string | null; type?: string; subtype?: string | null; owners?: { names?: string[] }[] }[]; bank_income_sources?: BankIncomeSourceRaw[] }[];
}
export class PlaidApiError extends Error {
  constructor(readonly code: string) { super("Plaid request failed."); }
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
const BANK_INCOME_READY_ATTEMPTS = 6;
const DAYS_REQUESTED = 730; // NC self-employment base is 12 months; Bank Income offers up to 731.
export class PlaidClient {
  constructor(private readonly config: PlaidConfig = plaidConfig(), private readonly fetchFn: PlaidFetch = fetch) {}
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchFn(`${this.config.baseUrl}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: this.config.clientId, secret: this.config.secret, ...body }),
    });
    if (!response.ok) {
      const b = (await response.json().catch(() => null)) as { error_code?: unknown } | null;
      throw new PlaidApiError(typeof b?.error_code === "string" ? b.error_code : "UNKNOWN");
    }
    return (await response.json()) as T;
  }
  /** Create a fresh Plaid user (user-token flow, required for Bank Income), then a Link token for Bank Income only. Returns the user_id for the later pull; the browser only ever holds it sealed in a session-bound handle. */
  async createLinkToken(sessionId: string): Promise<{ linkToken: string; userId: string }> {
    // /user/create is idempotent per client_user_id, so a stable id would
    // make every pull in one session reuse the same Plaid user (and its
    // linked Items). Mix in a nonce: each pull gets its own Plaid user,
    // deleted right after that pull.
    const clientUserId = createHash("sha256").update(`${sessionId}:${randomUUID()}`).digest("hex").slice(0, 32);
    const user = await this.post<{ user_id: string }>("/user/create", { client_user_id: clientUserId });
    if (!user.user_id) throw new Error("Plaid request failed.");
    const data = await this.post<{ link_token: string }>("/link/token/create", {
      client_name: "Benefits Navigator (Plaid Sandbox demo)", language: "en", country_codes: ["US"],
      user_id: user.user_id,
      products: ["income_verification"],
      income_verification: { income_source_types: ["bank"], bank_income: { days_requested: DAYS_REQUESTED } },
    });
    if (!data.link_token) throw new Error("Plaid request failed.");
    return { linkToken: data.link_token, userId: user.user_id };
  }
  async fetchBankIncome(userId: string, now = new Date()): Promise<MinimizedPlaidPayload> {
    let report: BankIncomeReportRaw | undefined;
    for (let attempt = 0; attempt < BANK_INCOME_READY_ATTEMPTS; attempt++) {
      try {
        const data = await this.post<{ bank_income?: BankIncomeReportRaw[] }>("/credit/bank_income/get", { user_id: userId });
        report = data.bank_income?.[0];
        if (report) break;
      } catch (error) {
        if (!(error instanceof PlaidApiError && error.code === "PRODUCT_NOT_READY") || attempt === BANK_INCOME_READY_ATTEMPTS - 1) throw error;
      }
      await sleep(2000);
    }
    if (!report) throw new PlaidApiError("PRODUCT_NOT_READY");
    const items = report.items ?? [];
    const accounts = items.flatMap((i) => i.bank_income_accounts ?? []).map((a) => ({ name: a.name ?? "Account", officialName: a.official_name ?? null, mask: a.mask ?? null, type: a.type ?? "", subtype: a.subtype ?? null }));
    const streams: MinimizedPlaidStream[] = items.flatMap((i) => i.bank_income_sources ?? []).map((s) => ({
      incomeCategory: s.income_category ?? "OTHER",
      incomeDescription: s.income_description ?? "",
      payFrequency: s.pay_frequency ?? "UNKNOWN",
      totalAmount: s.total_amount ?? 0,
      transactionCount: s.transaction_count ?? 0,
      startDate: s.start_date ?? "", endDate: s.end_date ?? "",
      historicalMonths: (s.historical_summary ?? []).map((h) => ({ startDate: h.start_date ?? "", endDate: h.end_date ?? "", total: h.total_amounts?.[0]?.amount ?? h.total_amount ?? 0 })),
    }));
    const accountOwnerNames = [...new Set(items.flatMap((i) => (i.bank_income_accounts ?? []).flatMap((a) => (a.owners ?? []).flatMap((o) => o.names ?? []))))];
    const starts = streams.map((s) => s.startDate).filter(Boolean).sort();
    const ends = streams.map((s) => s.endDate).filter(Boolean).sort();
    return { accounts, streams, accountOwnerNames, pulledAt: now.toISOString(), dateRange: { start: starts[0] ?? "", end: ends[ends.length - 1] ?? "" } };
  }
  async removeUser(userId: string): Promise<void> { await this.post("/user/remove", { user_id: userId }); }
  /** Fetch Bank Income once for this user, then delete the Plaid user so no grant lingers on Plaid's side beyond the demo fetch. */
  async pullBankIncome(userId: string): Promise<MinimizedPlaidPayload> {
    try { return await this.fetchBankIncome(userId); }
    finally { await this.removeUser(userId).catch(() => undefined); }
  }
}
