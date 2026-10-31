"use client";

import type { ClientAnswer, ClientQuestion } from "../../lib/intake/serialize";
import { AnswerStatusBadge } from "../../components/answer-status-badge";
import { Field } from "../../components/field";

// One intake question per screen (BN-09): the plain-language prompt, help
// text, and options come from the question spec; every question carries an
// explicit "I'm not sure" path (→ unknown) and a best-guess marking
// (→ unverified), so the tri-state honesty spine is representable on every
// screen. Stored answers render the honest status badge; pii answers never
// render a value.

export interface QuestionViewProps {
  question: ClientQuestion;
  /** Stored answer for this question, when one exists. */
  answer?: ClientAnswer;
  /** Draft value being edited (undefined = nothing entered yet). */
  value: unknown;
  onValueChange: (value: unknown) => void;
  bestGuess: boolean;
  onBestGuessChange: (checked: boolean) => void;
  onNotSure: () => void;
  onSubmit: () => void;
  onSkip: () => void;
  busy: boolean;
  error?: string;
}

function isMultiSelected(value: unknown, optionValue: string): boolean {
  return Array.isArray(value) && value.includes(optionValue);
}

function toggleMulti(value: unknown, optionValue: string): string[] {
  const current = Array.isArray(value) ? value.map(String) : [];
  return current.includes(optionValue)
    ? current.filter((item) => item !== optionValue)
    : [...current, optionValue];
}

/** Choice questions own their markup (fieldset/legend); scalars use Field. */
function isChoiceType(type: ClientQuestion["type"]): boolean {
  return (
    type === "single_select" ||
    type === "multi_select" ||
    type === "boolean"
  );
}

export function QuestionView({
  question,
  answer,
  value,
  onValueChange,
  bestGuess,
  onBestGuessChange,
  onNotSure,
  onSubmit,
  onSkip,
  busy,
  error,
}: QuestionViewProps) {
  const choice = isChoiceType(question.type);
  const helpId = `${question.id}-help`;
  const errorId = `${question.id}-error`;

  const requiredMark = question.required ? (
    <span>
      <span aria-hidden="true">*</span>
      <span className="sr-only">(required)</span>
    </span>
  ) : null;

  const describedBy = [helpId, error ? errorId : undefined]
    .filter(Boolean)
    .join(" ");

  let control: React.ReactNode;
  if (question.type === "boolean") {
    control = (
      <fieldset aria-describedby={describedBy} className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium">
          {question.prompt} {requiredMark}
        </legend>
        {[
          { inputValue: "true", label: "Yes", selected: value === true, pick: () => onValueChange(true) },
          {
            inputValue: "false",
            label: "No",
            selected: value === false,
            pick: () => onValueChange(false),
          },
        ].map((choiceItem) => (
          <label
            key={choiceItem.inputValue}
            htmlFor={`${question.id}-${choiceItem.inputValue}`}
            className="flex items-center gap-2 rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-base has-[:checked]:border-teal has-[:checked]:bg-teal-soft"
          >
            <input
              type="radio"
              id={`${question.id}-${choiceItem.inputValue}`}
              name={question.id}
              value={choiceItem.inputValue}
              checked={choiceItem.selected}
              onChange={choiceItem.pick}
              disabled={busy}
            />
            {choiceItem.label}
          </label>
        ))}
      </fieldset>
    );
  } else if (question.type === "single_select") {
    control = (
      <fieldset aria-describedby={describedBy} className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium">
          {question.prompt} {requiredMark}
        </legend>
        {(question.options ?? []).map((option) => (
          <label
            key={option.value}
            htmlFor={`${question.id}-${option.value}`}
            className="flex items-center gap-2 rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-base has-[:checked]:border-teal has-[:checked]:bg-teal-soft"
          >
            <input
              type="radio"
              id={`${question.id}-${option.value}`}
              name={question.id}
              value={option.value}
              checked={value === option.value}
              onChange={() => onValueChange(option.value)}
              disabled={busy}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
    );
  } else if (question.type === "multi_select") {
    control = (
      <fieldset aria-describedby={describedBy} className="flex flex-col gap-2">
        <legend className="mb-1 text-base font-medium">
          {question.prompt} {requiredMark}
        </legend>
        {(question.options ?? []).map((option) => (
          <label
            key={option.value}
            htmlFor={`${question.id}-${option.value}`}
            className="flex items-center gap-2 rounded-xl border border-surface-border bg-surface px-3 py-2.5 text-base has-[:checked]:border-teal has-[:checked]:bg-teal-soft"
          >
            <input
              type="checkbox"
              id={`${question.id}-${option.value}`}
              name={question.id}
              value={option.value}
              checked={isMultiSelected(value, option.value)}
              onChange={() => onValueChange(toggleMulti(value, option.value))}
              disabled={busy}
            />
            {option.label}
          </label>
        ))}
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
      <Field
        id={`intake-${question.id}`}
        label={question.prompt}
        help={question.help}
        error={error}
        required={question.required}
      >
        {(controlProps) => (
          <input
            {...controlProps}
            type={inputType}
            value={
              typeof value === "string" || typeof value === "number"
                ? String(value)
                : ""
            }
            onChange={(event) =>
              onValueChange(
                event.target.value === ""
                  ? undefined
                  : question.type === "number"
                    ? Number(event.target.value)
                    : event.target.value,
              )
            }
            disabled={busy}
            className="rounded-xl border border-surface-border bg-surface px-3 py-2 text-base"
          />
        )}
      </Field>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-intake-question={question.id}>
      {control}
      {choice ? (
        <>
          {question.help ? (
            <p
              id={helpId}
              className="text-sm text-muted"
            >
              {question.help}
            </p>
          ) : null}
          {error ? (
            <p
              id={errorId}
              role="alert"
              className="text-sm font-medium text-danger"
            >
              {error}
            </p>
          ) : null}
        </>
      ) : null}
      {answer ? (
        <div className="flex flex-col items-start gap-1">
          <AnswerStatusBadge status={answer.status} />
          {question.pii ? (
            <p className="text-sm text-muted">
              {"For your privacy, we don't show your saved answer here. To change it, enter a new one."}
            </p>
          ) : null}
        </div>
      ) : null}
      <label
        htmlFor={`${question.id}-best-guess`}
        className="flex items-center gap-2 text-sm text-muted"
      >
        <input
          type="checkbox"
          id={`${question.id}-best-guess`}
          checked={bestGuess}
          onChange={(event) => onBestGuessChange(event.target.checked)}
          disabled={busy}
        />
        This is my best guess — I have not verified it
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          id={`${question.id}-continue`}
          onClick={onSubmit}
          disabled={busy}
          className="rounded-full bg-teal-deep px-5 py-2 text-base font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
        >
          Continue
        </button>
        <button
          type="button"
          id={`${question.id}-not-sure`}
          onClick={onNotSure}
          disabled={busy}
          className="rounded-full border border-surface-border bg-surface px-5 py-2 text-base font-medium hover:bg-teal-soft disabled:opacity-50"
        >
          {"I'm not sure"}
        </button>
        {!question.required ? (
          <button
            type="button"
            id={`${question.id}-skip`}
            onClick={onSkip}
            disabled={busy}
            className="text-base text-muted underline hover:text-foreground disabled:opacity-50"
          >
            Skip for now
          </button>
        ) : null}
      </div>
    </div>
  );
}
