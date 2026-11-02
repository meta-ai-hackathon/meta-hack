"use client";

import { useRef, useState, type JSX } from "react";
import type {
  ClientQuestion,
  IntakeClientState,
} from "../../../lib/intake/serialize";
import type { AnswerStatus } from "../../../lib/honesty";

// The quick-questions stage (demo-core sprint, milestone quick-questions,
// part 2): the requirements engine's computed still-to-ask set rendered
// as grouped question cards, BETWEEN the entry stage and the talk stage.
//
// What this stage is, precisely:
//
// - The cards are the ENGINE's set (state.quickQuestions.remainingIds —
//   program requirements minus answered minus skippable). This component
//   renders them grouped and sensitive-last; it never widens or narrows
//   the set, and the question spec stays the single source of truth for
//   definitions (prompts, options, types, required) — read-only.
// - The counter is the engine's honest live math: "N questions instead
//   of M", N and M never hardcoded, decremented by real saves.
// - Answers submit through the EXISTING tri-state path —
//   POST /api/intake/answer → validateAnswerInput → saveAnswer (pii:true
//   values to the encrypted vault, plain values with provenance). This
//   stage adds no storage route, table, or semantics.
// - A saved card leaves the stage (ask-once: any stored answer counts as
//   asked); the counter decrements live via aria-live. A skipped card
//   stays, marked, unanswered — the talk-stage conversation picks skipped
//   questions up; nothing here ever blocks progress: the calm CTA to the
//   talk stage is always available.
// - Geometry is the literal Lovable stage frame (VAL-FIX-006): the shared
//   35px/32px/20px stage grid with the Coming Together rail — the parent
//   mounts this component inside STAGE_GRID_CLASS. The 84px header region
//   is the app shell's. No animation anywhere on the stage, so the
//   reduced-motion preference shows the finished state by construction.
// - Accessibility (VAL-QQ-012): the page's single H1 stays the page's —
//   stage headings are H2 + H3 groups; the counter is a polite live
//   region; every option row and button is a 44px+ target; copy uses the
//   app's AAA-contrast tokens; states are text, never animation-only.

/**
 * The multi-select option value that means "none of these" (VAL-QQ-005).
 * The question spec's own option carries the semantics — where a
 * multi_select question offers a `none` choice, this stage makes it
 * mutually exclusive with the rest (selecting it deselects the others,
 * and vice versa) before submission.
 */
export const NONE_OPTION_VALUE = "none";

/**
 * Pure toggle for a multi-select draft with the None-of-these exclusion
 * (VAL-QQ-005). Exported for tests; the UI applies it before submission.
 */
export function toggleNoneExclusive(
  value: unknown,
  optionValue: string,
): string[] {
  // Deduplicated first — the same canonical rule the store applies to
  // multi-select values — so a toggle can never manufacture duplicates.
  const current = [
    ...new Set(Array.isArray(value) ? value.map(String) : []),
  ];
  if (optionValue === NONE_OPTION_VALUE) {
    return current.includes(optionValue) ? [] : [NONE_OPTION_VALUE];
  }
  // Either way a real pick lands, none is out: the exclusion holds for
  // any draft the toggle could ever see, not just UI-produced ones.
  const withoutNone = current.filter((item) => item !== NONE_OPTION_VALUE);
  if (current.includes(optionValue)) {
    return withoutNone.filter((item) => item !== optionValue);
  }
  return [...withoutNone, optionValue];
}

/**
 * The honest counter line (VAL-QQ-004): "N questions instead of M", both
 * numbers straight from the requirements engine — singular handled.
 */
export function counterCopy(remaining: number, total: number): string {
  const left = remaining === 1 ? "1 question" : `${remaining} questions`;
  return `${left} instead of ${total}`;
}

/**
 * The owner-named sensitive set (feature direction: "sensitive questions
 * (citizenship/immigration, disability) LAST and optional with a
 * why-we-ask note"). Ids ONLY — the prompts and options stay in the
 * question spec, consumed read-only, the same discipline as the sidebar
 * theme mapping. Extensible by editing this list; the stage renders
 * whatever the engine's remaining set contains.
 */
export const SENSITIVE_QUESTION_IDS: readonly string[] = [
  "citizenship_status",
  "disability_status",
];

interface GroupSpec {
  readonly id: string;
  readonly heading: string;
  readonly questionIds: readonly string[];
}

/**
 * The topical groups (ids ONLY — prompts/options stay in the spec, the
 * same mapping discipline as the Coming Together themes). A remaining id
 * this list doesn't know about falls into the trailing "Other questions"
 * group before the sensitive group — a spec addition can never silently
 * drop off the stage.
 */
const GROUP_SPECS: readonly GroupSpec[] = [
  {
    id: "application",
    heading: "About this application",
    questionIds: ["application_role", "main_goal", "state", "county"],
  },
  {
    id: "about-you",
    heading: "About you",
    questionIds: ["date_of_birth", "veteran_status", "id_status", "id_issue_detail"],
  },
  {
    id: "household",
    heading: "Your household",
    questionIds: ["household_size", "household_children", "household_seniors"],
  },
  {
    id: "income",
    heading: "Money coming in",
    questionIds: [
      "income_sources",
      "income_kind",
      "self_employment_statements_offer",
      "prior_employer_current",
      "prior_employer_last_month",
      "job_income_amount",
      "job_income_frequency",
      "benefits_income_amount",
      "benefits_income_frequency",
      "other_income_amount",
    ],
  },
  {
    id: "home",
    heading: "Where you live and what it costs",
    questionIds: ["housing_status", "housing_cost", "utilities_cost", "childcare_cost", "medical_cost"],
  },
  {
    id: "contact",
    heading: "Reaching you",
    questionIds: [
      "mailing_situation",
      "shelter_mail_consent",
      "phone_contact",
      "email_contact",
      "contact_preference",
      "best_time_to_reach",
    ],
  },
];

const SENSITIVE_GROUP: GroupSpec = {
  id: "sensitive",
  heading: "A few private questions",
  questionIds: SENSITIVE_QUESTION_IDS,
};

const OTHER_GROUP: GroupSpec = {
  id: "other",
  heading: "Other questions",
  questionIds: [],
};

export interface QuickQuestionGroup {
  readonly id: string;
  readonly heading: string;
  readonly sensitive: boolean;
  /** The remaining, still-unanswered questions of this group, spec order. */
  readonly questions: readonly ClientQuestion[];
}

/**
 * Bucket the engine's remaining set into the stage's groups. Pure and
 * exported for tests: sensitive questions render after all non-sensitive
 * ones (VAL-QQ-006); unknown ids land in the "Other questions" bucket;
 * ids without a client-safe definition in the state are never fabricated.
 */
export function groupRemainingQuestions(
  state: IntakeClientState,
): readonly QuickQuestionGroup[] {
  const byId = new Map(state.questions.map((q) => [q.id, q]));
  const remainingIds = new Set(state.quickQuestions.remainingIds);
  const claimed = new Set<string>();
  const groups: QuickQuestionGroup[] = [];
  const push = (spec: GroupSpec, ids: readonly string[]): void => {
    const questions = ids
      .filter((id) => remainingIds.has(id))
      .map((id) => byId.get(id))
      .filter((q): q is ClientQuestion => q !== undefined);
    if (questions.length === 0) {
      return;
    }
    for (const q of questions) {
      claimed.add(q.id);
    }
    groups.push({
      id: spec.id,
      heading: spec.heading,
      sensitive: spec.id === SENSITIVE_GROUP.id,
      questions,
    });
  };
  for (const spec of GROUP_SPECS) {
    push(spec, spec.questionIds);
  }
  push(
    OTHER_GROUP,
    state.quickQuestions.remainingIds.filter(
      (id) => !claimed.has(id) && !SENSITIVE_QUESTION_IDS.includes(id),
    ),
  );
  push(
    SENSITIVE_GROUP,
    state.quickQuestions.remainingIds.filter((id) =>
      SENSITIVE_QUESTION_IDS.includes(id),
    ),
  );
  return groups;
}

/** Why-we-ask notes for the sensitive cards (VAL-QQ-006) — calm, honest,
 * skippable. New product copy: it must pass the banned-claims gate like
 * every user-visible string (it does — the UI-string scan covers it). */
const WHY_WE_ASK: Readonly<Record<string, string>> = {
  citizenship_status:
    "Why we ask: the official application includes a citizenship and immigration status section. This one is optional — skip it now and the conversation can come back to it.",
  disability_status:
    "Why we ask: disability and health conditions can matter for program rules and services. This one is optional — skip it, for example, if this part of the application is for a child.",
};

const EMPTY_REQUIRED_ERROR =
  "This one is needed to continue. Pick an option or choose I'm not sure.";
const EMPTY_OPTIONAL_ERROR =
  "Pick an option to save it, or skip below — the conversation can come back to it.";
const SAVE_FAILED_NOTICE =
  "We couldn't save that just now. Please try again — nothing is lost.";
const SAVED_NOTICE = "Saved — thank you.";
const SKIPPED_NOTICE =
  "Skipped for now. The conversation can pick it up — nothing is blocked.";

function hasDraft(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  return value !== undefined && value !== null;
}

/** The draft row for one option of a choice card. */
function optionRow(
  questionId: string,
  option: { value: string; label: string },
  control: "checkbox" | "radio",
  checked: boolean,
  onPick: () => void,
): JSX.Element {
  return (
    <label
      key={option.value}
      htmlFor={`${questionId}-${option.value}`}
      className="flex min-h-11 items-center gap-2 rounded-xl border border-surface-border bg-background px-3 py-2 text-base hover:border-teal has-[:checked]:border-teal has-[:checked]:bg-teal-soft"
    >
      <input
        type={control}
        id={`${questionId}-${option.value}`}
        name={questionId}
        value={option.value}
        checked={checked}
        onChange={onPick}
        className="h-5 w-5 shrink-0 accent-teal"
      />
      <span>{option.label}</span>
    </label>
  );
}

/**
 * One question card. A grouped multi-select renders a checkbox group with
 * the None-of-these exclusion; single-select renders radios; scalars
 * render inputs; every card saves through the existing tri-state path.
 */
function QuestionCard(props: {
  question: ClientQuestion;
  sensitive: boolean;
  onNotice: (message: string) => void;
  onSaved: (state: IntakeClientState) => void;
}) {
  const { question, sensitive, onNotice, onSaved } = props;
  const [draft, setDraft] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [saving, setSaving] = useState(false);
  // The in-flight ref mirrors `saving` for the async re-entrancy guard:
  // a double click during the await must never double-POST an answer.
  const saveInFlight = useRef(false);

  async function save(status: AnswerStatus): Promise<void> {
    if (saveInFlight.current) {
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      // A number question's draft is the typed string; the canonical
      // number conversion happens at the store boundary (the same
      // numeric-string rule the wizard and the API share).
      const value =
        question.type === "number" && typeof draft === "string"
          ? Number(draft)
          : draft;
      const response = await fetch("/api/intake/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          questionId: question.id,
          status,
          value: status === "unknown" ? null : value,
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        onNotice(data?.error?.message ?? SAVE_FAILED_NOTICE);
        return;
      }
      const fresh = (await response.json()) as IntakeClientState;
      // The parent applies the route's fresh state; a saved card leaves
      // the stage (ask-once), so this card's post-save setState calls
      // are no-ops on an unmounted component by design.
      onSaved(fresh);
      onNotice(SAVED_NOTICE);
    } catch {
      onNotice(SAVE_FAILED_NOTICE);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  function submitKnown(): void {
    if (!hasDraft(draft)) {
      setError(question.required ? EMPTY_REQUIRED_ERROR : EMPTY_OPTIONAL_ERROR);
      return;
    }
    setError(null);
    void save("known");
  }

  function submitUnknown(): void {
    setError(null);
    void save("unknown");
  }

  function skip(): void {
    // Skipping writes NOTHING: the question stays unanswered, the talk-
    // stage conversation picks it up (ask-once applies to answers). The
    // card stays, visibly marked; the CTA to talk never blocks.
    setSkipped(true);
    setError(null);
    onNotice(SKIPPED_NOTICE);
  }

  const errorId = `${question.id}-qq-error`;
  const describedBy = [
    question.help ? `${question.id}-qq-help` : undefined,
    error ? errorId : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  let control: JSX.Element;
  if (question.type === "multi_select") {
    control = (
      <fieldset aria-describedby={describedBy} className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium">
          {question.prompt}
          {question.required ? (
            <span className="ml-1">
              <span aria-hidden="true">*</span>
              <span className="sr-only">(required)</span>
            </span>
          ) : null}
        </legend>
        {(question.options ?? []).map((option) =>
          optionRow(
            question.id,
            option,
            "checkbox",
            Array.isArray(draft) && draft.includes(option.value),
            () =>
              setDraft(
                toggleNoneExclusive(draft, option.value),
              ),
          ),
        )}
      </fieldset>
    );
  } else if (question.type === "single_select") {
    control = (
      <fieldset aria-describedby={describedBy} className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium">
          {question.prompt}
          {question.required ? (
            <span className="ml-1">
              <span aria-hidden="true">*</span>
              <span className="sr-only">(required)</span>
            </span>
          ) : null}
        </legend>
        {(question.options ?? []).map((option) =>
          optionRow(question.id, option, "radio", draft === option.value, () =>
            setDraft(option.value),
          ),
        )}
      </fieldset>
    );
  } else if (question.type === "boolean") {
    control = (
      <fieldset aria-describedby={describedBy} className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium">
          {question.prompt}
          {question.required ? (
            <span className="ml-1">
              <span aria-hidden="true">*</span>
              <span className="sr-only">(required)</span>
            </span>
          ) : null}
        </legend>
        {[
          { pick: true, label: "Yes" },
          { pick: false, label: "No" },
        ].map((choice) =>
          optionRow(
            question.id,
            { value: String(choice.pick), label: choice.label },
            "radio",
            draft === choice.pick,
            () => setDraft(choice.pick),
          ),
        )}
      </fieldset>
    );
  } else {
    const inputType =
      question.type === "number"
        ? "number"
        : question.type === "date"
          ? "date"
          : "text";
    control = (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`qq-${question.id}`} className="text-base font-medium">
          {question.prompt}
          {question.required ? (
            <span className="ml-1">
              <span aria-hidden="true">*</span>
              <span className="sr-only">(required)</span>
            </span>
          ) : null}
        </label>
        {question.help ? (
          <p id={`${question.id}-qq-help`} className="text-sm text-muted">
            {question.help}
          </p>
        ) : null}
        <input
          id={`qq-${question.id}`}
          type={inputType}
          value={typeof draft === "string" || typeof draft === "number" ? String(draft) : ""}
          onChange={(event) =>
            setDraft(
              event.target.value === ""
                ? undefined
                : question.type === "number"
                  ? event.target.value
                  : event.target.value,
            )
          }
          disabled={saving}
          aria-describedby={describedBy || undefined}
          className="min-h-11 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
        />
      </div>
    );
  }

  return (
    <li
      data-qq-card={question.id}
      data-qq-optional={question.required ? undefined : "true"}
      data-qq-skipped={skipped ? "true" : undefined}
      className="flex flex-col gap-3 rounded-2xl border border-surface-border bg-surface p-4"
    >
      {control}
      {sensitive ? (
        <p
          data-qq-why={question.id}
          className="rounded-xl border border-teal/25 bg-teal-soft p-3 text-sm text-muted"
        >
          {WHY_WE_ASK[question.id] ?? "Why we ask: it helps prepare your application."}
        </p>
      ) : null}
      {question.help && question.type !== "text" && question.type !== "number" && question.type !== "date" ? (
        <p id={`${question.id}-qq-help`} className="text-sm text-muted">
          {question.help}
        </p>
      ) : null}
      {skipped ? (
        <p data-qq-skipped-note className="text-sm text-muted">
          Skipped for now — the conversation can pick it up. Nothing is blocked.
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" data-qq-error={question.id} className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-qq-save={question.id}
          onClick={submitKnown}
          className="min-h-12 rounded-full bg-teal-deep px-6 py-2.5 text-base font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
          disabled={saving}
        >
          Save this answer
        </button>
        <button
          type="button"
          data-qq-not-sure={question.id}
          onClick={submitUnknown}
          className="min-h-12 rounded-full border border-surface-border bg-surface px-6 py-2.5 text-base font-medium hover:bg-teal-soft disabled:opacity-50"
          disabled={saving}
        >
          I&apos;m not sure
        </button>
        {!question.required ? (
          <button
            type="button"
            data-qq-skip={question.id}
            onClick={skip}
            className="min-h-12 text-base text-muted underline hover:text-foreground disabled:opacity-50"
            disabled={saving}
          >
            Skip for now
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The quick-questions stage. The parent (ConversationChat) gates it to the
 * voice journey between entry and talk, mounts it inside the literal
 * stage-grid geometry with the Coming Together rail, and owns the state:
 * `onStateChange` applies the answer route's fresh client state (the
 * counter re-renders from it; a completed set flips the journey to the
 * talk stage), `onNotice` feeds the page's StatusRegion, `onToTalk` is
 * the calm CTA's move-on (never blocked by pending questions).
 */
export function QuickQuestionsStage(props: {
  state: IntakeClientState;
  onStateChange: (state: IntakeClientState) => void;
  onNotice: (message: string) => void;
  onToTalk: () => void;
}): JSX.Element {
  const { state, onStateChange, onNotice, onToTalk } = props;
  const groups = groupRemainingQuestions(state);
  const { remainingCount, requiredCount } = state.quickQuestions;

  return (
    <section
      data-quick-questions-stage
      aria-labelledby="quick-questions-stage-heading"
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <h2 id="quick-questions-stage-heading" data-qq-heading className="font-display text-2xl font-bold">
          Quick questions
        </h2>
        <p
          data-qq-counter
          aria-live="polite"
          className="font-mono text-sm text-muted"
        >
          {counterCopy(remainingCount, requiredCount)}
        </p>
        <p className="max-w-xl text-muted">
          Here&apos;s the short list — answer what you can, skip what
          you&apos;d rather not. Your answers save as you go, and private
          details stay private.
        </p>
      </div>
      {groups.map((group) => (
        <section
          key={group.id}
          data-qq-group={group.id}
          aria-labelledby={`qq-group-${group.id}-heading`}
          className="flex flex-col gap-3"
        >
          <h3 id={`qq-group-${group.id}-heading`} className="text-lg font-semibold">
            {group.heading}
          </h3>
          <ul className="flex flex-col gap-3">
            {group.questions.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                sensitive={group.sensitive}
                onNotice={onNotice}
                onSaved={onStateChange}
              />
            ))}
          </ul>
        </section>
      ))}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          data-qq-to-talk
          onClick={onToTalk}
          className="min-h-12 self-start rounded-full bg-teal-deep px-8 py-3 text-base font-semibold text-teal-contrast hover:bg-teal"
        >
          Let&apos;s talk
        </button>
        <p className="max-w-xl text-sm text-muted">
          Whatever you skip here, the conversation can pick up — nothing is
          blocked, and nothing is submitted.
        </p>
      </div>
    </section>
  );
}
