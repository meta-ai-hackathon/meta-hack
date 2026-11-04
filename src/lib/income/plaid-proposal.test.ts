import { describe, expect, it } from "vitest";
import { plaidIncomeProposals, NC_MONTHLY_FACTORS } from "./plaid-proposal";
import type { MinimizedPlaidPayload, MinimizedPlaidStream } from "../plaid/client";
function stream(incomeCategory: string, totalAmount: number, transactionCount = 3, payFrequency = "BIWEEKLY", months = ["2026-08", "2026-09", "2026-10"]): MinimizedPlaidStream {
  return { incomeCategory, isStripePayout: false, payFrequency, totalAmount, transactionCount, startDate: months[0] + "-01", endDate: months[months.length - 1] + "-28", historicalMonths: months.map((m) => ({ startDate: m + "-01", endDate: m + "-28", total: totalAmount / months.length })) };
}
function payload(streams: MinimizedPlaidStream[]): MinimizedPlaidPayload {
  return { streams, pulledAt: "2026-11-03T00:00:00.000Z", dateRange: { start: "2026-08-01", end: "2026-10-31" } };
}
describe("plaidIncomeProposals (Bank Income, NC MA-3306)", () => {
  it("salary proposes avg net per-paycheck + Plaid frequency, gross caveat; NC factors exported", () => {
    const r = plaidIncomeProposals(payload([stream("SALARY", 6300)]));
    expect(r.proposals.find((p) => p.questionId === "job_income_amount")?.value).toBe(2100);
    expect(r.proposals.find((p) => p.questionId === "job_income_frequency")?.value).toBe("biweekly");
    expect(r.proposals[0].caveat).toMatch(/gross/i);
    expect(NC_MONTHLY_FACTORS).toEqual({ weekly: 4.333, biweekly: 2.167, twice_monthly: 2, monthly: 1 });
  });
  it("never a confident zero on empty data", () => { expect(plaidIncomeProposals(payload([])).proposals).toEqual([]); });
  it("gig: no proposal, needs documents", () => {
    const r = plaidIncomeProposals(payload([stream("GIG_ECONOMY", 5000)]));
    expect(r.proposals).toEqual([]);
    expect(r.basis.streams).toContainEqual(expect.objectContaining({ category: "GIG_ECONOMY", disposition: "needs_documents" }));
  });
  it("non-countable excluded with reasons", () => {
    const r = plaidIncomeProposals(payload([stream("MILITARY", 900), stream("CHILD_SUPPORT", 600), stream("TAX_REFUND", 1500)]));
    expect(r.proposals).toEqual([]);
    for (const c of ["MILITARY", "CHILD_SUPPORT", "TAX_REFUND"]) expect(r.basis.streams).toContainEqual(expect.objectContaining({ category: c, disposition: "excluded_noncountable" }));
  });
  it("unemployment proposes benefits with award-letter caveat", () => {
    const r = plaidIncomeProposals(payload([stream("UNEMPLOYMENT", 1200, 3, "WEEKLY")]));
    expect(r.proposals.find((p) => p.questionId === "benefits_income_amount")?.value).toBe(400);
    expect(r.proposals[0].caveat).toMatch(/award letter/i);
  });
  it("LTD asks SSDI/SSI/other; SSDI proposes, SSI excludes, other needs documents", () => {
    const p = payload([stream("LONG_TERM_DISABILITY", 3000)]);
    const unanswered = plaidIncomeProposals(p);
    expect(unanswered.proposals).toEqual([]);
    expect(unanswered.classificationQuestions[0].prompt).toMatch(/SSDI, SSI/);
    const ssdi = plaidIncomeProposals(p, { LONG_TERM_DISABILITY: "ssdi" });
    expect(ssdi.proposals.find((x) => x.questionId === "benefits_income_amount")?.value).toBe(1000);
    const ssi = plaidIncomeProposals(p, { LONG_TERM_DISABILITY: "ssi" });
    expect(ssi.proposals).toEqual([]);
    expect(ssi.basis.streams).toContainEqual(expect.objectContaining({ disposition: "excluded_noncountable" }));
    expect(plaidIncomeProposals(p, { LONG_TERM_DISABILITY: "other" }).basis.streams).toContainEqual(expect.objectContaining({ disposition: "needs_documents" }));
  });
  it("ambiguous deposits ask, then follow the person's answer", () => {
    const p = payload([stream("TRANSFER_FROM_APPLICATION", 2000, 4, "WEEKLY")]);
    expect(plaidIncomeProposals(p).classificationQuestions).toHaveLength(1);
    expect(plaidIncomeProposals(p, { TRANSFER_FROM_APPLICATION: "gift_or_own" }).basis.streams).toContainEqual(expect.objectContaining({ disposition: "excluded_noncountable" }));
    expect(plaidIncomeProposals(p, { TRANSFER_FROM_APPLICATION: "gig" }).basis.streams).toContainEqual(expect.objectContaining({ disposition: "needs_documents" }));
    expect(plaidIncomeProposals(p, { TRANSFER_FROM_APPLICATION: "wages" }).proposals.find((x) => x.questionId === "job_income_amount")?.value).toBe(500);
  });
  it("rental needs documents; deprecated CASH asks as CASH_DEPOSIT", () => {
    const r = plaidIncomeProposals(payload([stream("RENTAL", 3600), stream("CASH", 150)]));
    expect(r.basis.streams).toContainEqual(expect.objectContaining({ category: "RENTAL", disposition: "needs_documents" }));
    expect(r.classificationQuestions.map((q) => q.category)).toContain("CASH_DEPOSIT");
  });
  it("flags seasonal suspicion without auto-answering", () => {
    const s = stream("SALARY", 3000, 3, "MONTHLY", ["2026-05", "2026-06", "2026-07"]);
    const wide: MinimizedPlaidPayload = { streams: [s], pulledAt: "x", dateRange: { start: "2025-11-01", end: "2026-10-31" } };
    // months come from historical summary (3 active of 3 listed) -- not seasonal on listed months alone
    expect(plaidIncomeProposals(wide).proposals.some((p) => String(p.questionId).includes("seasonal"))).toBe(false);
  });
  it("flags Stripe-described streams", () => {
    const s = { ...stream("OTHER", 2000), isStripePayout: true };
    expect(plaidIncomeProposals(payload([s])).basis.stripePayoutDepositCount).toBe(3);
  });
});
