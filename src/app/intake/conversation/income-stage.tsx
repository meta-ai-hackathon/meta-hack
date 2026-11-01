"use client";

import { useRef, useState, type JSX } from "react";
import type {
  ClientQuestion,
  IntakeClientState,
} from "../../../lib/intake/serialize";
import { INCOME_STAGE_QUESTION_IDS } from "../../../lib/intake/income";
import {
  proposalsFromMonthlyDerived,
  type TaxProposal,
} from "../../../lib/income/tax-proposal";
import { toggleNoneExclusive } from "./quick-questions";

// The income stage (demo-core sprint, milestone income-capture, part 3):
// the journey's fourth stage, between the talk stage's completion and the
// results stage (VAL-INC-001). EXACTLY two real source cards (VAL-INC-002):
//
// 1. "Type it in yourself" — the manual card renders the income spec
//    questions (the ones the flow engine's skip logic leaves visible),
//    prefilled from what the session already knows, and saves through the
//    standard answer path with provenance `user` (VAL-INC-003). A rough
//    idea is okay: the copy says so, and only the official program decides.
// 2. "Upload your tax return" — the part-2 route's two-step flow: the
//    file picker POSTs to /api/intake/tax-return (parsed deterministically
//    in memory — the document is never stored), the findings render with
//    "From your tax return" origin badges (VAL-INC-010), and NOTHING saves
//    until the person confirms or corrects each proposal
//    (/api/intake/tax-return/confirm). Re-uploading replaces the findings.
//
// No bank or payment-puller cards, no promises of future integrations —
// only paths that really work. The stage is always completable: the manual
// card is always available, and an unreadable upload saves nothing and
// points back to typing (VAL-INC-012).
//
// Geometry is the literal Lovable stage frame shared with the talk and
// quick-questions stages; the parent mounts this inside STAGE_GRID_CLASS
// with the Coming Together rail. Accessibility (VAL-INC-014): the page's
// single H1 stays the page's — this stage's headings are H2/H3; the status
// line is a polite live region announcing parse results and failures; every
// control is a 44px+ target on the app's AAA-contrast tokens; there is no
// animation anywhere on the stage, so reduced-motion shows the finished
// state by construction.

/** The upload route's response shape (mirrors the route's JSON). */
interface TaxReturnUploadResponse {
  readonly readable: boolean;
  readonly findings: readonly {
    readonly field: string;
    readonly value: number | string;
    readonly origin: string;
    readonly confidence: number;
  }[];
  readonly monthlyDerived: number | null;
  readonly message: string | null;
}

/** Plain labels for the parser's finding fields (ids stay internal). */
const FINDING_LABELS: Readonly<Record<string, string>> = {
  wages_line_1a: "Wages, last year's return (line 1a)",
  agi_line_11: "Adjusted gross income, last year (line 11)",
  filing_status: "Filing status on the return",
  dependent_count: "Dependents listed on the return",
};

const FILING_STATUS_LABELS: Readonly<Record<string, string>> = {
  single: "Single",
  married_filing_jointly: "Married filing jointly",
  married_filing_separately: "Married filing separately",
  head_of_household: "Head of household",
  qualifying_surviving_spouse: "Qualifying surviving spouse",
};

function findingValueCopy(field: string, value: number | string): string {
  if (field === "filing_status") {
    return FILING_STATUS_LABELS[String(value)] ?? String(value);
  }
  if (typeof value === "number") {
    return value.toLocaleString("en-US");
  }
  return String(value);
}

const SAVE_FAILED_NOTICE =
  "We couldn't save that just now. Please try again — nothing is lost.";
const READ_FAILED_NOTICE =
  "We couldn't read that file just now. You can type your income instead — a rough idea is okay.";
const NOTHING_DECIDED_NOTICE =
  "Nothing is saved yet — confirm or correct a finding first, or type your income instead.";

/** The income questions this state renders, in payload (spec) order. */
export function incomeQuestionsOf(
  state: IntakeClientState,
): readonly ClientQuestion[] {
  const incomeIds = new Set<string>(INCOME_STAGE_QUESTION_IDS);
  return state.questions.filter((question) => incomeIds.has(question.id));
}

/** The manual card's per-row draft: a typed value or an explicit not-sure. */
type IncomeDraft =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "not-sure" };

function draftFromAnswer(answer: { status: string; value?: unknown } | undefined): IncomeDraft {
  if (!answer || answer.status === "unknown" || answer.value === null || answer.value === undefined) {
    return { kind: "not-sure" };
  }
  return { kind: "value", value: answer.value };
}

/** True when a value-kind draft is effectively empty (cleared by the person). */
function isEmptyValue(draft: IncomeDraft | undefined): boolean {
  if (draft === undefined || draft.kind !== "value") {
    return false;
  }
  if (draft.value === undefined || draft.value === null) {
    return true;
  }
  if (typeof draft.value === "string") {
    return draft.value.trim() === "";
  }
  if (Array.isArray(draft.value)) {
    return draft.value.length === 0;
  }
  return false;
}

/** One labeled control row of the manual card. */
function IncomeRow(props: {
  question: ClientQuestion;
  draft: IncomeDraft;
  onDraft: (draft: IncomeDraft) => void;
  disabled: boolean;
}): JSX.Element {
  const { question, draft, onDraft, disabled } = props;
  const errorId = `income-${question.id}-error`;

  const legend = (
    <legend className="mb-1 text-base font-medium">
      {question.prompt}
      {question.required ? (
        <span className="ml-1">
          <span aria-hidden="true">*</span>
          <span className="sr-only">(required)</span>
        </span>
      ) : null}
    </legend>
  );

  const rows = (children: JSX.Element) => (
    <fieldset aria-describedby={errorId} className="flex flex-col gap-2">
      {legend}
      {children}
    </fieldset>
  );

  if (question.type === "multi_select" || question.type === "single_select") {
    const control = question.type === "multi_select" ? "checkbox" : "radio";
    const selected: string[] =
      draft.kind === "value" && Array.isArray(draft.value)
        ? draft.value.map(String)
        : draft.kind === "value" && draft.value !== undefined
          ? [String(draft.value)]
          : [];
    return rows(
      <>
        {(question.options ?? []).map((option) => (
          <label
            key={option.value}
            htmlFor={`income-${question.id}-${option.value}`}
            className="flex min-h-11 items-center gap-2 rounded-xl border border-surface-border bg-background px-3 py-2 text-base hover:border-teal has-[:checked]:border-teal has-[:checked]:bg-teal-soft"
          >
            <input
              type={control}
              id={`income-${question.id}-${option.value}`}
              name={question.id}
              value={option.value}
              checked={
                question.type === "multi_select"
                  ? selected.includes(option.value)
                  : selected[0] === option.value
              }
              onChange={() => {
                if (question.type === "multi_select") {
                  onDraft({
                    kind: "value",
                    value: toggleNoneExclusive(selected, option.value),
                  });
                } else {
                  onDraft({ kind: "value", value: option.value });
                }
              }}
              disabled={disabled}
              className="h-5 w-5 shrink-0 accent-teal"
            />
            <span>{option.label}</span>
          </label>
        ))}
      </>,
    );
  }

  // Scalars: number and text (the income set has no date/boolean rows, but
  // the row renders either honestly).
  const inputType = question.type === "number" ? "number" : "text";
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`income-${question.id}`} className="text-base font-medium">
        {question.prompt}
      </label>
      {question.help ? (
        <p id={`income-${question.id}-help`} className="text-sm text-muted">
          {question.help}
        </p>
      ) : null}
      <input
        id={`income-${question.id}`}
        type={inputType}
        value={
          draft.kind === "value" &&
          (typeof draft.value === "string" || typeof draft.value === "number")
            ? String(draft.value)
            : ""
        }
        onChange={(event) =>
          onDraft({
            kind: "value",
            value: event.target.value === "" ? undefined : event.target.value,
          })
        }
        disabled={disabled}
        aria-describedby={
          [question.help ? `income-${question.id}-help` : undefined, errorId]
            .filter(Boolean)
            .join(" ") || undefined
        }
        className="min-h-11 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
      />
    </div>
  );
}

/**
 * The income stage. The parent (ConversationChat) mounts it when the talk
 * stage's conversation is complete and income is not yet handled, inside
 * the shared stage grid; `onStateChange` applies the save routes' fresh
 * client state (the gate re-renders from it, and a handled set hands the
 * journey to the results stage), `onNotice` feeds the page's StatusRegion.
 */
export function IncomeStage(props: {
  state: IntakeClientState;
  onStateChange: (state: IntakeClientState) => void;
  onNotice: (message: string) => void;
}): JSX.Element {
  const { state, onStateChange, onNotice } = props;
  const questions = incomeQuestionsOf(state);

  // The manual card's drafts, initialized once from the state the stage
  // arrived with (prefills — the person confirms or corrects from here).
  const [drafts, setDrafts] = useState<Record<string, IncomeDraft>>(() =>
    Object.fromEntries(
      questions.map((question) => [
        question.id,
        draftFromAnswer(state.answers[question.id]),
      ]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);

  // The upload card's findings state: null until a parse returns. A
  // re-upload REPLACES it (old proposals discarded, never duplicated).
  const [upload, setUpload] = useState<TaxReturnUploadResponse | null>(null);
  const [reading, setReading] = useState(false);
  const [readStatus, setReadStatus] = useState("");
  const readInFlight = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // The chosen file's name, in state — a ref read during render would not
  // re-render when the picker changes.
  const [fileName, setFileName] = useState("");
  // Per-proposal decision: confirm (as parsed) or correct (typed value).
  const [corrections, setCorrections] = useState<Record<string, string>>({});

  const proposals = proposalsFromMonthlyDerived(upload?.monthlyDerived ?? null);

  async function applyAnswerPost(questionId: string): Promise<boolean> {
    const response = await fetch("/api/intake/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId, status: "unknown", value: null }),
    });
    if (!response.ok) {
      onNotice(SAVE_FAILED_NOTICE);
      return false;
    }
    return true;
  }

  async function saveManual(): Promise<void> {
    if (saveInFlight.current) {
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      // Not-sure rows save through the standard tri-state path (an "I'm
      // not sure" is an honest answer); value rows save as the person's
      // own entries through the confirm route's correct action (provenance
      // user) — the manual card IS the person typing their own values. A
      // value row the person cleared saves as not-sure, never as junk.
      const notSure = questions.filter(
        (question) =>
          drafts[question.id]?.kind === "not-sure" || isEmptyValue(drafts[question.id]),
      );
      for (const question of notSure) {
        const ok = await applyAnswerPost(question.id);
        if (!ok) {
          return;
        }
      }
      const confirmations = questions
        .filter(
          (question) =>
            drafts[question.id]?.kind === "value" &&
            !isEmptyValue(drafts[question.id]),
        )
        .map((question) => {
          const raw = (drafts[question.id] as { kind: "value"; value: unknown }).value;
          const value =
            question.type === "number" && typeof raw === "string"
              ? Number(raw)
              : raw;
          return { questionId: question.id, action: "correct" as const, value };
        });
      if (confirmations.length > 0) {
        const response = await fetch("/api/intake/tax-return/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmations }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          onNotice(data?.error?.message ?? SAVE_FAILED_NOTICE);
          return;
        }
        const fresh = (await response.json()) as { state: IntakeClientState };
        onStateChange(fresh.state);
      } else if (notSure.length > 0) {
        // Only not-sure rows saved: refetch the state the way the zero-send
        // wizard does (a GET of the caller's own session — no provider).
        const response = await fetch("/api/intake/state");
        if (!response.ok) {
          onNotice(SAVE_FAILED_NOTICE);
          return;
        }
        onStateChange((await response.json()) as IntakeClientState);
      }
      onNotice(
        "Saved — your income details are in. Nothing was submitted; the official program decides.",
      );
    } catch {
      onNotice(SAVE_FAILED_NOTICE);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  async function readReturn(): Promise<void> {
    if (readInFlight.current) {
      return;
    }
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setReadStatus("Choose your tax return PDF first — then we'll read it.");
      return;
    }
    readInFlight.current = true;
    setReading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/intake/tax-return", {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        setReadStatus(READ_FAILED_NOTICE);
        return;
      }
      const data = (await response.json()) as TaxReturnUploadResponse;
      // Re-upload semantics: the new parse REPLACES the old findings —
      // the prior proposals are discarded, not duplicated.
      setUpload(data);
      setCorrections({});
      setReadStatus(
        data.readable
          ? "We read your tax return. Check each finding — confirm or correct before anything is saved."
          : (data.message ?? READ_FAILED_NOTICE),
      );
    } catch {
      setReadStatus(READ_FAILED_NOTICE);
    } finally {
      readInFlight.current = false;
      setReading(false);
    }
  }

  async function saveTaxFindings(): Promise<void> {
    if (saveInFlight.current) {
      return;
    }
    const decided = proposals.map((proposal) => {
      const corrected = corrections[proposal.questionId];
      if (corrected !== undefined && corrected !== "") {
        const question = questions.find(
          (candidate) => candidate.id === proposal.questionId,
        );
        return {
          questionId: proposal.questionId,
          action: "correct" as const,
          value:
            question?.type === "number" ? Number(corrected) : corrected,
        };
      }
      return {
        questionId: proposal.questionId,
        action: "confirm" as const,
        value: proposal.value,
      };
    });
    if (upload === null || !upload.readable || decided.length === 0) {
      onNotice(NOTHING_DECIDED_NOTICE);
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      const response = await fetch("/api/intake/tax-return/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmations: decided }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        onNotice(data?.error?.message ?? SAVE_FAILED_NOTICE);
        return;
      }
      const fresh = (await response.json()) as { state: IntakeClientState };
      onStateChange(fresh.state);
      onNotice(
        "Saved — your tax return's figures are in as you confirmed them. Nothing was submitted.",
      );
    } catch {
      onNotice(SAVE_FAILED_NOTICE);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <section
      data-income-stage
      aria-labelledby="income-stage-heading"
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <h2 id="income-stage-heading" data-income-heading className="font-display text-2xl font-bold">
          Income
        </h2>
        <p
          data-income-status
          aria-live="polite"
          className="font-mono text-sm text-muted"
        >
          {state.income.answeredCount} of {state.income.totalCount} income
          details are in
          {state.income.confirmedCount > 0
            ? ` — ${state.income.confirmedCount} confirmed on this stage`
            : " — nothing is confirmed yet"}
        </p>
        <p className="max-w-xl text-muted">
          Two ways to add what money comes in. A rough idea is okay — and
          only the official program decides, not this app.
        </p>
      </div>

      {/* Card 1 — the manual path (always available; the stage never
      dead-ends). The questions are the spec's, prefilled from the session;
      the save is the person vouching for their own values (provenance
      user). */}
      <section
        data-income-manual-card
        aria-labelledby="income-manual-heading"
        className="flex flex-col gap-4 rounded-2xl border border-surface-border bg-surface p-4"
      >
        <div className="flex flex-col gap-1">
          <h3 id="income-manual-heading" className="text-lg font-semibold">
            Type it in yourself
          </h3>
          <p className="text-sm text-muted">
            A rough idea is okay. Type what you know — you can correct the
            details later, and private details stay private.
          </p>
        </div>
        <ul className="flex flex-col gap-4">
          {questions.map((question) => {
            const draft = drafts[question.id] ?? { kind: "not-sure" as const };
            return (
              <li
                key={question.id}
                data-income-row={question.id}
                className="flex flex-col gap-2"
              >
                <IncomeRow
                  question={question}
                  draft={draft}
                  onDraft={(next) =>
                    setDrafts((previous) => ({
                      ...previous,
                      [question.id]: next,
                    }))
                  }
                  disabled={saving}
                />
                <div className="flex flex-wrap items-center gap-2">
                  {draft.kind === "not-sure" ? (
                    <p data-income-not-sure={question.id} className="text-sm text-muted">
                      You&apos;re not sure yet — a rough idea is okay, or leave
                      this one for the conversation to pick up.
                    </p>
                  ) : null}
                  {draft.kind === "value" ? (
                    <button
                      type="button"
                      data-income-not-sure-button={question.id}
                      onClick={() =>
                        setDrafts((previous) => ({
                          ...previous,
                          [question.id]: { kind: "not-sure" },
                        }))
                      }
                      className="min-h-11 text-sm text-muted underline hover:text-foreground disabled:opacity-50"
                      disabled={saving}
                    >
                      I&apos;m not sure
                    </button>
                  ) : null}
                  {state.answers[question.id]?.provenance ? (
                    <span
                      data-origin-badge={state.answers[question.id]?.provenance}
                      className="rounded-full border border-teal/40 bg-teal-soft px-2.5 py-0.5 text-xs font-medium text-teal"
                    >
                      {state.answers[question.id]?.provenance === "tax_return"
                        ? "From your tax return"
                        : "You corrected this"}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          data-income-save-manual
          onClick={() => void saveManual()}
          disabled={saving}
          className="min-h-12 self-start rounded-full bg-teal-deep px-6 py-2.5 text-base font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save these answers"}
        </button>
      </section>

      {/* Card 2 — the tax-return upload (the part-2 route's two-step
      flow). The document is read in memory and never stored; nothing saves
      until the person confirms or corrects. */}
      <section
        data-income-upload-card
        aria-labelledby="income-upload-heading"
        className="flex flex-col gap-4 rounded-2xl border border-surface-border bg-surface p-4"
      >
        <div className="flex flex-col gap-1">
          <h3 id="income-upload-heading" className="text-lg font-semibold">
            Upload your tax return
          </h3>
          <p className="text-sm text-muted">
            Use the IRS Form 1040 PDF you filed last year. We read it on the
            spot and never store the document — and you confirm or correct
            every number before anything is saved.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label
            htmlFor="income-tax-return-file"
            className="min-h-11 flex cursor-pointer items-center rounded-full border border-teal bg-background px-5 py-2 text-base font-medium text-teal hover:bg-teal-soft"
          >
            Choose your PDF
          </label>
          <input
            ref={fileRef}
            id="income-tax-return-file"
            type="file"
            accept="application/pdf,.pdf"
            data-income-file
            className="sr-only"
            onChange={(event) => {
              setFileName(event.target.files?.[0]?.name ?? "");
              setReadStatus("");
            }}
          />
          <span data-income-file-name className="text-sm text-muted">
            {fileName === "" ? "No file chosen yet" : fileName}
          </span>
          <button
            type="button"
            data-income-read
            onClick={() => void readReturn()}
            disabled={reading}
            className="min-h-12 rounded-full bg-teal-deep px-6 py-2.5 text-base font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
          >
            {reading ? "Reading…" : "Read your tax return"}
          </button>
        </div>
        <p
          data-income-read-status
          aria-live="polite"
          className={
            readStatus === ""
              ? "hidden"
              : "rounded-xl border border-teal/25 bg-teal-soft p-3 text-sm text-muted"
          }
        >
          {readStatus}
        </p>
        {upload !== null && upload.readable ? (
          <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2" data-income-findings>
              {upload.findings.map((finding) => (
                <li
                  key={finding.field}
                  data-income-finding={finding.field}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
                >
                  <span>{FINDING_LABELS[finding.field] ?? finding.field}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono">
                      {findingValueCopy(finding.field, finding.value)}
                    </span>
                    <span
                      data-origin-badge="tax_return"
                      className="rounded-full border border-teal/40 bg-teal-soft px-2.5 py-0.5 text-xs font-medium text-teal"
                    >
                      From your tax return
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {proposals.length > 0 ? (
              <div className="flex flex-col gap-2" data-income-proposals>
                <h4 className="text-base font-semibold">
                  From your tax return — confirm or correct each one
                </h4>
                <p className="text-sm text-muted">
                  The monthly figure is a proposal from LAST year&apos;s
                  return (the return&apos;s adjusted gross income divided by
                  12) — not a fact about what you make today. Confirm it or
                  type your own.
                </p>
                <ul className="flex flex-col gap-2">
                  {proposals.map((proposal) => (
                    <TaxProposalRow
                      key={proposal.questionId}
                      proposal={proposal}
                      correction={corrections[proposal.questionId] ?? ""}
                      onCorrect={(value) =>
                        setCorrections((previous) => ({
                          ...previous,
                          [proposal.questionId]: value,
                        }))
                      }
                      disabled={saving}
                    />
                  ))}
                </ul>
              </div>
            ) : (
              <p data-income-no-proposals className="text-sm text-muted">
                No usable monthly figure came out of this return, so nothing
                is proposed — you can type your income instead. A rough idea
                is okay.
              </p>
            )}
            <button
              type="button"
              data-income-save-tax
              onClick={() => void saveTaxFindings()}
              disabled={saving}
              className="min-h-12 self-start rounded-full bg-teal-deep px-6 py-2.5 text-base font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save what I've decided"}
            </button>
          </div>
        ) : null}
        {upload !== null && !upload.readable ? (
          <p data-income-unreadable className="rounded-xl border border-amber-line bg-amber-soft p-3 text-sm text-foreground">
            {upload.message ?? READ_FAILED_NOTICE}
          </p>
        ) : null}
      </section>
    </section>
  );
}

/** One confirm-or-correct row for a tax-derived proposal. */
function TaxProposalRow(props: {
  proposal: TaxProposal;
  correction: string;
  onCorrect: (value: string) => void;
  disabled: boolean;
}): JSX.Element {
  const { proposal, correction, onCorrect, disabled } = props;
  const corrected = correction !== "";
  const inputId = `income-proposal-${proposal.questionId}`;
  return (
    <li
      data-income-proposal={proposal.questionId}
      className="flex flex-wrap items-center gap-2 rounded-xl border border-surface-border bg-background px-3 py-2"
    >
      <span
        data-income-proposed-value={proposal.questionId}
        className="font-mono text-sm"
      >
        {proposal.questionId === "job_income_frequency"
          ? "Once a month"
          : Number(proposal.value).toLocaleString("en-US")}
      </span>
      <label htmlFor={inputId} className="sr-only">
        Correct the proposed value for {proposal.questionId.replaceAll("_", " ")}
      </label>
      <input
        id={inputId}
        type="text"
        inputMode="numeric"
        value={correction}
        placeholder="Or type your own"
        onChange={(event) => onCorrect(event.target.value)}
        disabled={disabled}
        data-income-correct={proposal.questionId}
        className="min-h-11 w-36 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
      />
      <span className="text-sm text-muted">
        {corrected
          ? "You'll save your own value instead"
          : "Blank means confirm the proposal"}
      </span>
      <span
        data-origin-badge="tax_return"
        className="rounded-full border border-teal/40 bg-teal-soft px-2.5 py-0.5 text-xs font-medium text-teal"
      >
        From your tax return
      </span>
    </li>
  );
}
