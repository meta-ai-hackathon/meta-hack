import type { MinimizedPlaidPayload } from "../plaid/client";
// Deterministic Plaid Bank Income -> Medicaid proposals (HACK-140, HACK-86:
// no LLM computes or classifies any number). Pure and browser-safe.
// Data comes from Plaid Bank Income streams (income_category per stream),
// NOT from raw Transactions.
//
// NC policy: NC Medicaid MA-3306 (MAGI). Wages gross (VII.A.1 conversions
// weekly x4.333 / biweekly x2.167 / semimonthly x2 / monthly as-is);
// self-employment = NET profit over 12 months or months in operation
// (VII.A.2) -- deposit totals are gross receipts, never countable alone;
// veterans benefits, child support received, federal refunds, SSI are
// non-countable (VI.B). Bank wage deposits are net-of-withholding while
// NC counts gross, so salary proposals are confirm-or-correct only.
// Where automated discernment is infeasible, we ASK the person (see
// classificationQuestions) instead of guessing -- e.g. long-term
// disability could be SSDI (countable), SSI (non-countable), or private.
export type BankIncomeCategory =
  | "SALARY" | "UNEMPLOYMENT" | "GIG_ECONOMY" | "RENTAL" | "CHILD_SUPPORT"
  | "MILITARY" | "RETIREMENT" | "LONG_TERM_DISABILITY" | "BANK_INTEREST"
  | "CASH_DEPOSIT" | "TRANSFER_FROM_APPLICATION" | "TAX_REFUND"
  | "BENEFIT_OTHER" | "OTHER";
export type StreamDisposition = "proposed" | "excluded_noncountable" | "needs_classification" | "needs_documents";
export interface PlaidIncomeProposal {
  readonly questionId: "job_income_amount" | "job_income_frequency" | "benefits_income_amount" | "benefits_income_frequency" | "other_income_amount";
  readonly value: number | string; readonly caveat: string;
}
export interface PlaidStreamSummary {
  readonly category: BankIncomeCategory; readonly count: number; readonly total: number;
  readonly disposition: StreamDisposition; readonly reason: string;
}
export interface PlaidClassificationQuestion {
  readonly category: BankIncomeCategory;
  readonly prompt: string;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
}
export type PlaidClassifications = Readonly<Record<string, string>>;
export interface PlaidProposalBasis {
  readonly dateRange: { readonly start: string; readonly end: string };
  readonly depositCount: number; readonly streamCount: number;
  readonly stripePayoutDepositCount: number;
  readonly months: readonly { readonly month: string; readonly total: number; readonly count: number }[];
  readonly streams: readonly PlaidStreamSummary[];
  readonly seasonalSuspected: boolean; readonly seasonalNote: string | null;
}
export interface PlaidProposalResult {
  readonly proposals: readonly PlaidIncomeProposal[];
  readonly basis: PlaidProposalBasis;
  readonly classificationQuestions: readonly PlaidClassificationQuestion[];
}
export const NC_MONTHLY_FACTORS: Readonly<Record<string, number>> = { weekly: 4.333, biweekly: 2.167, twice_monthly: 2, monthly: 1 };
export const CLASSIFICATION_QUESTIONS: Readonly<Partial<Record<BankIncomeCategory, PlaidClassificationQuestion>>> = {
  MILITARY: { category: "MILITARY", prompt: "We found deposits Plaid labels as military. Are these veterans benefits or pay from military service?", choices: [{ value: "veterans_benefit", label: "Veterans benefits (VA payments)" }, { value: "military_pay", label: "Military pay from service" }, { value: "not_sure", label: "I'm not sure" }] },
  LONG_TERM_DISABILITY: { category: "LONG_TERM_DISABILITY", prompt: "We found long-term disability deposits, and we cannot tell what kind they are. Is this SSDI, SSI, or something else?", choices: [{ value: "ssdi", label: "SSDI (Social Security Disability Insurance)" }, { value: "ssi", label: "SSI (Supplemental Security Income)" }, { value: "other", label: "Something else (for example private or employer disability)" }] },
  BENEFIT_OTHER: { category: "BENEFIT_OTHER", prompt: "We found a benefit we could not identify. What is it?", choices: [{ value: "snap_or_assistance", label: "SNAP, TANF, or similar assistance" }, { value: "countable_benefit", label: "Another government benefit that pays me regularly" }, { value: "not_sure", label: "I'm not sure" }] },
  CASH_DEPOSIT: { category: "CASH_DEPOSIT", prompt: "We found cash or check deposits with no identified source. Where does this money come from?", choices: [{ value: "wages", label: "Pay from a job" }, { value: "gig", label: "Gig or self-employment work" }, { value: "gift_or_own", label: "Gifts, repayments, or my own money moved" }, { value: "benefits", label: "A benefit payment" }, { value: "something_else", label: "Something else" }] },
  TRANSFER_FROM_APPLICATION: { category: "TRANSFER_FROM_APPLICATION", prompt: "We found Venmo, Cash App, or Zelle deposits. Where does this money come from?", choices: [{ value: "wages", label: "Pay from a job" }, { value: "gig", label: "Gig or self-employment work" }, { value: "gift_or_own", label: "Gifts, repayments, or my own money moved" }, { value: "benefits", label: "A benefit payment" }, { value: "something_else", label: "Something else" }] },
  OTHER: { category: "OTHER", prompt: "We found deposits we could not classify. Where does this money come from?", choices: [{ value: "wages", label: "Pay from a job" }, { value: "gig", label: "Gig or self-employment work" }, { value: "gift_or_own", label: "Gifts, repayments, or my own money moved" }, { value: "benefits", label: "A benefit payment" }, { value: "something_else", label: "Something else" }] },
};
function cents(v: number): number { return Math.round(v * 100) / 100; }
function mapFrequency(payFrequency: string): string {
  switch (payFrequency) { case "WEEKLY": return "weekly"; case "BIWEEKLY": return "biweekly"; case "SEMI_MONTHLY": return "twice_monthly"; case "MONTHLY": return "monthly"; default: return "varies"; }
}
interface Agg { total: number; count: number; frequencies: Set<string>; months: Map<string, number>; }
export function plaidIncomeProposals(payload: MinimizedPlaidPayload, classifications: PlaidClassifications = {}): PlaidProposalResult {
  const byCategory = new Map<BankIncomeCategory, Agg>();
  let stripePayoutDepositCount = 0;
  for (const s of payload.streams) {
    const category = (s.incomeCategory === "CASH" ? "CASH_DEPOSIT" : s.incomeCategory) as BankIncomeCategory;
    if (s.isStripePayout) stripePayoutDepositCount += s.transactionCount;
    const agg = byCategory.get(category) ?? { total: 0, count: 0, frequencies: new Set<string>(), months: new Map<string, number>() };
    agg.total = cents(agg.total + s.totalAmount); agg.count += s.transactionCount;
    agg.frequencies.add(mapFrequency(s.payFrequency));
    // The raw description never reaches this module; only the Stripe marker does.
    for (const h of s.historicalMonths) { const m = h.startDate.slice(0, 7); if (m) agg.months.set(m, cents((agg.months.get(m) ?? 0) + h.total)); }
    byCategory.set(category, agg);
  }
  const monthTotals = new Map<string, number>();
  for (const agg of byCategory.values()) for (const [m, t] of agg.months) monthTotals.set(m, cents((monthTotals.get(m) ?? 0) + t));
  const months = [...monthTotals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, total]) => ({ month, total, count: 0 }));
  const depositCount = [...byCategory.values()].reduce((n, a) => n + a.count, 0);
  const proposals: PlaidIncomeProposal[] = [];
  const streams: PlaidStreamSummary[] = [];
  const questions: PlaidClassificationQuestion[] = [];
  const add = (c: BankIncomeCategory, d: StreamDisposition, reason: string) => { const a = byCategory.get(c); if (a) streams.push({ category: c, count: a.count, total: a.total, disposition: d, reason }); };
  const freqOf = (a: Agg) => (a.frequencies.size === 1 ? [...a.frequencies][0] : "varies");
  // One proposal per question: if two streams target the same question
  // (e.g. unemployment and an SSDI answer), first wins and the person
  // edits the single field -- never duplicate question IDs.
  const already = (id: string) => proposals.some((x) => x.questionId === id);
  const proposeWages = (a: Agg): boolean => { if (already("job_income_amount")) return false; proposals.push({ questionId: "job_income_amount", value: cents(a.total / Math.max(a.count, 1)), caveat: "This is the average deposit, after withholding. NC Medicaid counts gross pay before withholding, so correct it from a pay stub if you can." }, { questionId: "job_income_frequency", value: freqOf(a), caveat: "How often Plaid says this pay arrives." }); return true; };
  const proposeBenefits = (a: Agg, label: string): boolean => { if (already("benefits_income_amount")) return false; proposals.push({ questionId: "benefits_income_amount", value: cents(a.total / Math.max(a.count, 1)), caveat: label + ": NC usually wants the award letter, not a bank statement, as proof. Confirm from your letter if you have one." }, { questionId: "benefits_income_frequency", value: freqOf(a), caveat: "How often Plaid says this benefit arrives." }); return true; };

  const salary = byCategory.get("SALARY");
  if (salary) { if (salary.count >= 2) { const added = proposeWages(salary); add("SALARY", added ? "proposed" : "needs_documents", added ? "Wages: NC counts gross pay (MA-3306 VII.A.1); deposits show net, so confirm or correct from a pay stub." : "Another category already filled the job-income amount, so these wages were NOT included. Check both with a pay stub before relying on the number."); } else add("SALARY", "needs_documents", "Only one wage deposit seen -- a pay stub or employer statement works better."); }
  for (const [cat, label] of [["UNEMPLOYMENT", "Unemployment"], ["RETIREMENT", "Retirement / Social Security"]] as const) {
    const a = byCategory.get(cat); if (!a) continue;
    if (a.count >= 2) { const added = proposeBenefits(a, label); add(cat, added ? "proposed" : "needs_documents", added ? label + " is countable; NC proof is the award letter, not the bank statement." : "Another benefit stream already filled the benefits amount, so " + label + " was NOT included. Check both award letters before relying on the number."); } else add(cat, "needs_documents", label + ": only one deposit seen. Your award letter has the countable amount.");
  }
  const interest = byCategory.get("BANK_INTEREST");
  if (interest) { if (interest.months.size >= 2) { proposals.push({ questionId: "other_income_amount", value: cents(interest.total / interest.months.size), caveat: "Average monthly bank interest. Taxable and tax-exempt interest both count toward MAGI (MA-3306 VI.A)." }); add("BANK_INTEREST", "proposed", "Interest counts toward MAGI (MA-3306 VI.A)."); } else add("BANK_INTEREST", "needs_classification", "Interest seen in one month only -- tell us if it repeats."); }

  // Ask-the-person handling for everything automated discernment cannot settle.
  const handleAmbiguous = (cat: BankIncomeCategory, defaultReason: string) => {
    const a = byCategory.get(cat); if (!a) return;
    const answer = classifications[cat];
    if (!answer) { const q = CLASSIFICATION_QUESTIONS[cat]; if (q) questions.push(q); add(cat, "needs_classification", defaultReason); return; }
    if (cat === "MILITARY") {
      if (answer === "veterans_benefit") { add(cat, "excluded_noncountable", "You told us these are veterans benefits, which do not count for NC Medicaid (MA-3306 VI.B), so they were left out."); return; }
      if (answer === "military_pay") { const added = proposeWages(a); add(cat, added ? "proposed" : "needs_documents", added ? "You told us this is military pay, which counts as wages. NC counts gross pay, so correct from a leave-and-earnings statement if you can." : "Another category already filled the job-income amount, so this military pay was NOT included. Check both with a pay statement."); return; }
      add(cat, "needs_classification", "We could not tell whether these deposits are veterans benefits (not countable) or military pay (countable).");
      return;
    }
    if (cat === "LONG_TERM_DISABILITY") {
      if (answer === "ssdi") { const added = proposeBenefits(a, "SSDI"); add(cat, added ? "proposed" : "needs_documents", added ? "You told us this is SSDI, which counts. NC proof is the award letter." : "Another benefit stream already filled the benefits amount, so this SSDI was NOT included. Check both award letters."); }
      else if (answer === "ssi") add(cat, "excluded_noncountable", "You told us this is SSI, which does not count for NC Medicaid (MA-3306 VI.B), so it was left out.");
      else add(cat, "needs_documents", "Private or employer disability can count differently depending on how it is taxed. Your award letter or plan statement has the details -- nothing was counted automatically.");
      return;
    }
    if (answer === "snap_or_assistance") { add(cat, "excluded_noncountable", "You told us this is SNAP/TANF-type assistance, which does not count as MAGI income, so it was left out."); return; }
    if (answer === "countable_benefit" || answer === "benefits") { const added = proposeBenefits(a, "Benefit"); add(cat, added ? "proposed" : "needs_documents", added ? "You told us this is a regular benefit payment. Confirm the amount from your award letter if you have one." : "Another benefit stream already filled the benefits amount, so this was NOT included. Check both award letters."); return; }
    if (answer === "wages") { const added = proposeWages(a); add(cat, added ? "proposed" : "needs_documents", added ? "You told us this is pay from a job. NC counts gross pay, so correct from a pay stub if you can." : "Another category already filled the job-income amount, so this was NOT included. Check both with a pay stub."); return; }
    if (answer === "gig") { add(cat, "needs_documents", "You told us this is gig/self-employment work. NC counts net profit over 12 months (MA-3306 VII.A.2), so we need expenses, a tax return, or business records -- deposits alone are gross receipts."); return; }
    if (answer === "gift_or_own") { add(cat, "excluded_noncountable", "You told us this is gifts, repayments, or your own money moved, so it was not counted as income."); return; }
    const q = CLASSIFICATION_QUESTIONS[cat]; if (q) questions.push(q);
    add(cat, "needs_classification", defaultReason + "");
  };
  handleAmbiguous("MILITARY", "We could not tell whether these deposits are veterans benefits (not countable) or military pay (countable) -- please tell us which.");
  handleAmbiguous("LONG_TERM_DISABILITY", "Disability deposits could be SSDI (countable) or SSI (not countable, MA-3306 VI.B) -- please tell us which.");
  handleAmbiguous("BENEFIT_OTHER", "A benefit we could not identify -- please tell us what it is.");
  handleAmbiguous("CASH_DEPOSIT", "Cash or check deposits with no identified source -- please tell us where they come from.");
  handleAmbiguous("TRANSFER_FROM_APPLICATION", "Venmo/Cash App/Zelle deposits could be gig pay, repayments, gifts, or your own money -- please tell us, so nothing is counted twice.");
  handleAmbiguous("OTHER", "Deposits we could not classify -- please tell us what they are.");

  if (byCategory.has("GIG_ECONOMY")) add("GIG_ECONOMY", "needs_documents", "Gig/self-employment: NC counts NET profit over 12 months (or months in operation), divided by that many months (MA-3306 VII.A.2). Deposits are gross receipts -- we need expenses, a tax return, or business records before any number counts.");
  if (byCategory.has("RENTAL")) add("RENTAL", "needs_documents", "Rent received is gross; NC counts net rental income after expenses. We need expense records before any number counts.");

  if (byCategory.has("CHILD_SUPPORT")) add("CHILD_SUPPORT", "excluded_noncountable", "Child support you receive does not count for NC Medicaid (MA-3306 VI.B), so it was left out.");
  if (byCategory.has("TAX_REFUND")) add("TAX_REFUND", "excluded_noncountable", "Tax refunds do not count for NC Medicaid (MA-3306 VI.B), so these were left out.");

  const earnedMonths = new Set<string>();
  for (const c of ["SALARY", "GIG_ECONOMY"] as const) byCategory.get(c)?.months.forEach((_t, m) => earnedMonths.add(m));
  let seasonalSuspected = false;
  if (months.length >= 6 && earnedMonths.size >= 2) seasonalSuspected = earnedMonths.size <= Math.ceil(months.length / 2);
  const seasonalNote = seasonalSuspected ? "This income looks seasonal -- it arrives in only part of the year. We did not answer the seasonal-work question for you; please answer it. (For work requirements, seasonal income is averaged over 6 months; for NC Medicaid eligibility, seasonal wages are counted like other wages.)" : null;
  return { proposals, classificationQuestions: questions, basis: { dateRange: payload.dateRange, depositCount, streamCount: payload.streams.length, stripePayoutDepositCount, months, streams, seasonalSuspected, seasonalNote } };
}
