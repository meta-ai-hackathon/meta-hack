"use client";

import { useEffect } from "react";

import type { ClientAnswer, ClientQuestion } from "../../lib/intake/serialize";
import { isWorkRequirementsQuestionId } from "../../lib/intake/work-requirements";
import { AnswerStatusBadge } from "../../components/answer-status-badge";
import { StatePicker } from "../../components/state-picker";
import {
  activityTypes,
  draftWorkRows,
  removeWorkRow,
  setWorkRow,
  type WorkRow,
} from "../../lib/intake/work-activities";
import {
  addRowFor,
  ageBandLabel,
  monthLabel,
  relationshipLabel,
  translateQuestion,
  uiText,
  type Language,
} from "../../lib/intake/i18n";
import {
  MONTH_VALUES,
  draftAttribution,
  parseAttribution,
  setAttribution,
  type Months,
} from "../../lib/intake/attribution";
import {
  MAX_ROSTER_MEMBERS,
  MAX_MEMBER_NAME_LENGTH,
  AGE_BAND_VALUES,
  RELATIONSHIP_VALUES,
  addMember,
  draftMembers,
  emptyMember,
  nextMemberId,
  removeMember,
  updateMember,
  type HouseholdMember,
} from "../../lib/intake/roster";
import { Field } from "../../components/field";
import { QUESTION_BY_ID } from "../../lib/intake/spec";

const ACTIVITY_QUESTION = QUESTION_BY_ID["wr_work_activity_types"];

/**
 * Activity labels come from the translated question's own option labels. English
 * keeps the activity list's own short labels, so its copy does not change.
 */
function activityLabel(value: string, language: Language): string {
  const fromActivities = activityTypes().find((activity) => activity.value === value)?.label;
  if (language === "en") {
    return fromActivities ?? value;
  }
  return (
    translateQuestion(ACTIVITY_QUESTION, language).options?.find((option) => option.value === value)?.label ??
    fromActivities ??
    value
  );
}

/** Situation labels in the attribution editor, translated where the spec has them. */
function situationLabel(id: string, fallback: string, language: Language): string {
  // English keeps the spec's short situation label: the prompt here is a long
  // two-sentence question, and swapping it in would change English copy.
  if (id === "wr_income_580" && language !== "en") {
    return translateQuestion(QUESTION_BY_ID["wr_income_580"], language).prompt;
  }
  const translated = (questionId: string): string | undefined =>
    translateQuestion(QUESTION_BY_ID[questionId], language)
      .options?.find((option) => option.value === id)?.label;
  // English keeps the short situation labels it always used: the spec option
  // labels are longer and would change English copy.
  if (language === "en") {
    return fallback;
  }
  // Exemptions carry the common situations; the applied-last-month list covers
  // the rest (pregnancy, treatment, and the others), so a translated editor
  // never falls back to English mid-sentence.
  return (
    translated("wr_exempt_situations") ??
    translated("wr_applied_last_month_which") ??
    fallback
  );
}

// One intake question per screen (BN-09): the plain-language prompt, help
// text, and options come from the question spec; every question carries an
// explicit "I'm not sure" path (→ unknown) and a best-guess marking
// (→ unverified), so the tri-state honesty spine is representable on every
// screen. Stored answers render the honest status badge; pii answers never
// render a value.

export interface QuestionViewProps {
  question: ClientQuestion;
  /** Roster + applicable situations for the attribution editor (device mode). */
  attributionContext?: import("../../lib/intake/attribution").AttributionContext;
  /** Roster + income prefill suggestions for the work-rows editor (device mode). */
  workContext?: import("../../lib/intake/work-activities").WorkContext;
  /** Intake language (HACK-131); English when omitted. */
  language?: import("../../lib/intake/i18n").Language;
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
  attributionContext,
  workContext,
  language = "en",
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
  // When the attribution editor is shown, sync the draft to the pruned
  // entries so a removed member or withdrawn situation is not re-saved.
  useEffect(() => {
    if (question.type !== "attribution" || !attributionContext) return;
    const pruned = draftAttribution(value, attributionContext);
    const stored = parseAttribution(value);
    if (JSON.stringify(pruned) !== JSON.stringify(stored ?? [])) {
      onValueChange(pruned.length === 0 ? undefined : pruned);
    }
    // Runs when the editor for this question is (re)shown with a context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id, attributionContext]);

  const choice = isChoiceType(question.type);
  const helpId = `${question.id}-help`;
  const errorId = `${question.id}-error`;
  const proofNoteId = `${question.id}-proof-note`;
  const isWorkRequirements = isWorkRequirementsQuestionId(question.id);

  const requiredMark = question.required ? (
    <span>
      <span aria-hidden="true">*</span>
      <span className="sr-only">({uiText("required", language)})</span>
    </span>
  ) : null;

  const describedBy = [
    helpId,
    isWorkRequirements ? proofNoteId : undefined,
    error ? errorId : undefined,
  ]
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
          { inputValue: "true", label: uiText("yes", language), selected: value === true, pick: () => onValueChange(true) },
          {
            inputValue: "false",
            label: uiText("no", language),
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
    if (question.id === "state") {
      // HACK-142: the state question's 50-option radio page becomes a
      // compact type-to-filter picker. The value is still the spec's
      // option value, so the answer route, validation, and provenance are
      // unchanged; the prompt label and help wiring stay on the input.
      control = (
        <div className="flex flex-col gap-2" data-intake-state-picker>
          <label htmlFor="state-picker-input" className="text-base font-medium">
            {question.prompt} {requiredMark}
          </label>
          <StatePicker
            id="state-picker"
            options={question.options ?? []}
            value={typeof value === "string" ? value : undefined}
            onChange={(next) => onValueChange(next)}
            disabled={busy}
            describedBy={describedBy}
          />
        </div>
      );
    } else {
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
    }
  } else if (question.type === "attribution") {
    const entries = draftAttribution(value, attributionContext);
    const members = attributionContext?.members ?? [];
    const situations = attributionContext?.situations ?? [];
    control = (
      <fieldset aria-describedby={describedBy} className="flex flex-col gap-3">
        <legend className="mb-1 text-base font-medium">
          {question.prompt} {requiredMark}
        </legend>
        {question.help ? <p id={helpId} className="text-sm text-muted">{question.help}</p> : null}
        {attributionContext === undefined ? (
          <p className="text-sm text-muted">
            {uiText("deviceOnly", language)}
          </p>
        ) : members.length === 0 || situations.length === 0 ? (
          <p className="text-sm text-muted">
            {uiText("noHouseholdList", language)}
          </p>
        ) : (
          situations.map((situation) => (
            <fieldset key={situation.id} className="flex flex-col gap-2 rounded-xl border border-surface-border bg-surface p-3">
              <legend className="text-base font-medium">{situationLabel(situation.id, situation.label, language)}</legend>
              {members.map((member) => {
                const entry = entries.find((e) => e.memberId === member.id && e.situationId === situation.id);
                return (
                  <label key={member.id} className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${question.id}-${situation.id}-${member.id}`}>
                    {member.displayName}
                    <select
                      id={`${question.id}-${situation.id}-${member.id}`}
                      value={entry?.months ?? ""}
                      disabled={busy}
                      onChange={(e) => { const next = setAttribution(entries, member.id, situation.id, e.target.value === "" ? null : (e.target.value as Months)); onValueChange(next.length === 0 ? undefined : next); }}
                      className="min-h-11 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
                    >
                      <option value="">{uiText("notPicked", language)}</option>
                      {MONTH_VALUES.map((v) => (
                        <option key={v} value={v}>{monthLabel(v, language)}</option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </fieldset>
          ))
        )}
      </fieldset>
    );
  } else if (question.type === "work_activity") {
    const members = workContext?.members ?? [];
    const memberIds = new Set(members.map((m) => m.id));
    const rows: WorkRow[] = draftWorkRows(value, memberIds);
    // Income-section suggestions (HACK-128) are offered, never drafted:
    // a row enters the draft only when the person taps Add for it.
    const offered = (workContext?.suggestions ?? []).filter(
      (s) => !rows.some((r) => r.memberId === s.memberId && r.activity === s.activity),
    );
    const setRows = (next: WorkRow[]) => onValueChange(next.length === 0 ? undefined : next);
    control = (
      <fieldset aria-describedby={describedBy} className="flex flex-col gap-3">
        <legend className="mb-1 text-base font-medium">
          {question.prompt} {requiredMark}
        </legend>
        {question.help ? <p id={helpId} className="text-sm text-muted">{question.help}</p> : null}
        {members.length === 0 ? (
          <p className="text-sm text-muted">
            {workContext === undefined
              ? uiText("deviceOnly", language)
              : uiText("rosterFirst", language)}
          </p>
        ) : (
          <>
            {offered.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-xl border border-teal/25 bg-teal-soft p-3">
                <p className="text-sm text-muted">
                  {uiText("fromIncome", language)}
                </p>
                {offered.map((s) => (
                  <button
                    key={`${s.memberId}|${s.activity}`}
                    type="button"
                    disabled={busy}
                    onClick={() => setRows([...rows, s])}
                    className="min-h-11 self-start rounded-full border border-surface-border bg-surface px-4 py-2 text-base font-medium hover:bg-teal-soft disabled:opacity-50"
                  >
                    {addRowFor(
                      members.find((m) => m.id === s.memberId)?.displayName ?? uiText("thisPerson", language),
                      activityLabel(s.activity, language),
                      language,
                    )}
                  </button>
                ))}
              </div>
            ) : null}
            {rows.map((row, index) => (
              <div key={index} className="flex flex-col gap-2 rounded-xl border border-surface-border bg-surface p-3" data-work-row={index}>
                <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${question.id}-${index}-member`}>
                  {uiText("householdMember", language)}
                  <select
                    id={`${question.id}-${index}-member`}
                    value={row.memberId}
                    disabled={busy}
                    onChange={(e) => setRows(setWorkRow(rows, index, { memberId: e.target.value }))}
                    className="min-h-11 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
                  >
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>{m.displayName}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${question.id}-${index}-activity`}>
                  {uiText("activityType", language)}
                  <select
                    id={`${question.id}-${index}-activity`}
                    value={row.activity}
                    disabled={busy}
                    onChange={(e) => setRows(setWorkRow(rows, index, { activity: e.target.value }))}
                    className="min-h-11 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
                  >
                    {activityTypes().map((a) => (
                      <option key={a.value} value={a.value}>{activityLabel(a.value, language)}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${question.id}-${index}-hours`}>
                  {uiText("hoursLastMonth", language)}
                  <input
                    id={`${question.id}-${index}-hours`}
                    type="number"
                    min="0"
                    value={row.hours === null ? "" : row.hours}
                    disabled={busy}
                    onChange={(e) => setRows(setWorkRow(rows, index, { hours: e.target.value === "" ? null : Number(e.target.value), hoursNotSure: false }))}
                    className="min-h-11 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-muted" htmlFor={`${question.id}-${index}-notsure`}>
                  <input
                    id={`${question.id}-${index}-notsure`}
                    type="checkbox"
                    checked={row.hoursNotSure === true}
                    disabled={busy}
                    onChange={(e) => setRows(setWorkRow(rows, index, { hoursNotSure: e.target.checked, hours: e.target.checked ? null : row.hours }))}
                  />
                  {uiText("notSureHours", language)}
                </label>
                {rows.some((r, i) => i !== index && r.memberId === row.memberId && r.activity === row.activity) ? (
                  <p className="text-sm font-medium text-danger">{uiText("duplicateRow", language)}</p>
                ) : null}
                {row.hours !== null && row.hours < 0 ? (
                  <p className="text-sm font-medium text-danger">{uiText("negHours", language)}</p>
                ) : null}
                {row.hours !== null && row.hours > 744 ? (
                  <p className="text-sm font-medium text-danger">{uiText("tooManyHours", language)}</p>
                ) : null}
                {row.hours === null && row.hoursNotSure !== true ? (
                  <p className="text-sm text-muted">{uiText("enterHours", language)}</p>
                ) : null}
                <button type="button" aria-label={`${uiText("removeRow", language)} (${uiText("rowWord", language)} ${index + 1})`} disabled={busy} onClick={() => setRows(removeWorkRow(rows, index))} className="self-start text-sm text-muted underline">
                  {uiText("removeRow", language)}
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const used = new Set(rows.map((r) => `${r.memberId}|${r.activity}`));
                const pair = members.flatMap((m) => activityTypes().map((a) => ({ memberId: m.id, activity: a.value }))).find((c) => !used.has(`${c.memberId}|${c.activity}`));
                if (pair) setRows([...rows, { ...pair, hours: null }]);
              }}
              className="min-h-11 self-start rounded-full border border-surface-border bg-surface px-4 py-2 text-base font-medium hover:bg-teal-soft disabled:opacity-50"
            >
              {uiText("addRow", language)}
            </button>
          </>
        )}
      </fieldset>
    );
  } else if (question.type === "roster") {
    const members: HouseholdMember[] = draftMembers(value);
    const setMembers = (next: HouseholdMember[]) => onValueChange(next);
    control = (
      <fieldset aria-describedby={describedBy} className="flex flex-col gap-3">
        <legend className="mb-1 text-base font-medium">
          {question.prompt} {requiredMark}
        </legend>
        {question.help ? (
          <p id={helpId} className="text-sm text-muted">{question.help}</p>
        ) : null}
        {members.map((member, index) => (
          <div key={member.id} className="flex flex-col gap-2 rounded-xl border border-surface-border bg-surface p-3" data-roster-member={member.id}>
            <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${question.id}-${member.id}-name`}>
              {uiText("person", language)} {index + 1}: {uiText("personName", language)}
              <input
                id={`${question.id}-${member.id}-name`}
                type="text"
                maxLength={MAX_MEMBER_NAME_LENGTH}
                value={member.displayName}
                disabled={busy}
                onChange={(e) => setMembers(updateMember(members, member.id, { displayName: e.target.value }))}
                aria-describedby={member.displayName.trim() === "" ? `${question.id}-${member.id}-name-hint` : undefined}
                className="min-h-11 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
              />
            </label>
            {member.displayName.trim() === "" ? (
              <p id={`${question.id}-${member.id}-name-hint`} className="text-sm text-muted">{uiText("nameHint", language)}</p>
            ) : null}
            <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${question.id}-${member.id}-relationship`}>
              {uiText("relationship", language)}
              <select
                id={`${question.id}-${member.id}-relationship`}
                value={member.relationship}
                disabled={busy}
                onChange={(e) => setMembers(updateMember(members, member.id, { relationship: e.target.value as HouseholdMember["relationship"] }))}
                className="min-h-11 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
              >
                {RELATIONSHIP_VALUES.map((v) => (
                  <option key={v} value={v} disabled={v === "self" && member.relationship !== "self" && members.some((m) => m.relationship === "self")}>{relationshipLabel(v, language)}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium" htmlFor={`${question.id}-${member.id}-age`}>
              {uiText("ageRange", language)}
              <select
                id={`${question.id}-${member.id}-age`}
                value={member.ageBand}
                disabled={busy}
                onChange={(e) => setMembers(updateMember(members, member.id, { ageBand: e.target.value as HouseholdMember["ageBand"] }))}
                className="min-h-11 rounded-xl border border-surface-border bg-background px-3 py-2 text-base"
              >
                {AGE_BAND_VALUES.map((v) => (
                  <option key={v} value={v}>{ageBandLabel(v, language)}</option>
                ))}
              </select>
            </label>
            {members.length > 1 ? (
              <button type="button" aria-label={`${uiText("removePerson", language)} (${uiText("person", language).toLowerCase()} ${index + 1}${member.displayName ? `: ${member.displayName}` : ""})`} disabled={busy} onClick={() => setMembers(removeMember(members, member.id))} className="self-start text-sm text-muted underline">
                {uiText("removePerson", language)}
              </button>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          disabled={busy || members.length >= MAX_ROSTER_MEMBERS}
          onClick={() => setMembers(addMember(members, emptyMember(nextMemberId(members))))}
          className="min-h-11 self-start rounded-full border border-surface-border bg-surface px-4 py-2 text-base font-medium hover:bg-teal-soft disabled:opacity-50"
        >
          {uiText("addPerson", language)}
        </button>
        {members.length >= MAX_ROSTER_MEMBERS ? (
          <p className="text-sm text-muted">{uiText("rosterFull", language)}</p>
        ) : null}
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
            aria-describedby={
              isWorkRequirements
                ? [controlProps["aria-describedby"], proofNoteId]
                    .filter(Boolean)
                    .join(" ")
                : controlProps["aria-describedby"]
            }
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
      {isWorkRequirements ? (
        <p
          id={proofNoteId}
          data-intake-proof-note
          className="text-sm text-muted"
        >
          {uiText("noProofNeeded", language)}
        </p>
      ) : null}
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
          <AnswerStatusBadge status={answer.status} language={language} />
          {question.pii ? (
            <p className="text-sm text-muted">
              {uiText("privateAnswer", language)}
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
        {uiText("bestGuess", language)}
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          id={`${question.id}-continue`}
          onClick={onSubmit}
          disabled={busy}
          className="rounded-full bg-teal-deep px-5 py-2 text-base font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
        >
          {uiText("continue", language)}
        </button>
        <button
          type="button"
          id={`${question.id}-not-sure`}
          onClick={onNotSure}
          disabled={busy}
          className="rounded-full border border-surface-border bg-surface px-5 py-2 text-base font-medium hover:bg-teal-soft disabled:opacity-50"
        >
          {uiText("notSure", language)}
        </button>
        {!question.required ? (
          <button
            type="button"
            id={`${question.id}-skip`}
            onClick={onSkip}
            disabled={busy}
            className="text-base text-muted underline hover:text-foreground disabled:opacity-50"
          >
            {uiText("skipForNow", language)}
          </button>
        ) : null}
      </div>
    </div>
  );
}
