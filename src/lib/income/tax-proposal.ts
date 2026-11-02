// The income stage's tax-return proposal mapping (milestone income-capture
// part 3; VAL-INC-007/010). The upload route returns the parser's typed
// findings plus the one derived figure, monthlyDerived — the PRIOR-YEAR
// annual AGI divided by 12 by the documented deterministic rule (see
// tax-parse.ts). This module turns that into the stage UI's confirm-or-
// correct proposals, and is the single source of WHICH question ids the UI
// proposes from parser findings — the confirm route admits action:"confirm"
// (provenance tax_return) ONLY for these ids, closing the client-asserted-
// provenance gap the part-2 review flagged.
//
// HONESTY FRAMING (the part-1 handoff note, binding here): monthlyDerived
// is a PRIOR-YEAR AGI proposal — it is presented for the person to confirm
// or correct, NEVER as a computed claim about their current monthly
// income. When no monthly figure was derived (negative or non-finite AGI —
// null, never a confident 0), there are NO proposals: the findings stay
// reference-only and the person types their own values.
//
// Browser-safe and pure: no store import, no network, no side effects —
// the stage component and the server's confirm validator both read this
// module so the proposal set can never drift between them.

/** The question ids the stage UI proposes from parser findings. */
export const TAX_RETURN_PROPOSED_QUESTION_IDS = [
  "job_income_amount",
  "job_income_frequency",
] as const;

export type TaxProposalOrigin = "tax_return";

export interface TaxProposal {
  /** The income spec question this proposal would answer. */
  readonly questionId: string;
  /** The proposed value (status `known` on confirm). */
  readonly value: unknown;
  /** Where the proposal came from — always the tax return here. */
  readonly origin: TaxProposalOrigin;
}

/**
 * The confirm-or-correct proposals for a parsed return: the prior-year
 * monthly figure proposed onto job_income_amount, with the matching
 * monthly frequency. Empty when monthlyDerived is null — never a guessed
 * or confident-zero proposal.
 */
export function proposalsFromMonthlyDerived(
  monthlyDerived: number | null,
): readonly TaxProposal[] {
  if (monthlyDerived === null) {
    return [];
  }
  return [
    {
      questionId: "job_income_amount",
      value: monthlyDerived,
      origin: "tax_return",
    },
    {
      questionId: "job_income_frequency",
      value: "monthly",
      origin: "tax_return",
    },
  ];
}
