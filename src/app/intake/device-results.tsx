"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnswerStatusBadge } from "../../components/answer-status-badge";
import { StatusRegion } from "../../components/status-region";
import { MAX_FORM_ANSWER_LENGTH, type ToResolveItem } from "../../lib/forms/fill-core";
import type { FormFlowFieldView } from "../../lib/forms/flow";
import type { ClientAnswerState } from "../../lib/intake/client-store";
import {
  DEVICE_FORM_ENTRY,
  deviceFormReview,
  deviceHandoffLinks,
  deviceMatch,
  fillFormOnDevice,
} from "../../lib/intake/device-form";
import { loadDeviceTemplate } from "../../lib/intake/device-template";
import type { MatchCard, MatchSourceCitation } from "../../lib/match-core";

// What the step-by-step page shows once the questions are done (HACK-115):
// the benefit match, the review of the application form, and the filled
// form to download. All of it is computed in this browser from the answers
// on this device (lib/intake/device-form.ts). The match explains each
// program with the program's own sourced facts only. Downloading fetches
// the blank public form, fills it here, and hands the file to the browser;
// no answer is sent anywhere, and answers typed here for the form's other
// fields live only in this page.
//
// Private answers never appear on this screen: the review shows their
// status and provenance, and the match never carries them.

export const DEVICE_RESULTS_COPY = {
  matchHeading: "Benefits that may be worth pursuing",
  matchEmpty:
    "No program we have official sources for lines up with your answers so " +
    "far. That isn't a decision of any kind; only the agency decides.",
  explanationFacts: "This explanation quotes the sourced facts above directly.",
  toResolveHeading: "To resolve",
  toResolveBody:
    "These answers are missing or not verified yet. Nothing below is " +
    "assumed: the programs are only suggested, and the official rules decide.",
  reviewHeading: "Your application, prepared from your answers",
  realFormNote:
    "We filled in the fields we could from what you told us and left the " +
    "rest blank for you to finish. This is the official application form: " +
    "you review it, complete it, and submit it yourself. The app never " +
    "submits for you. Preparing it is not a benefits decision; only the " +
    "agency decides that.",
  typedNote:
    "Used for this download only. It isn't saved anywhere, so it clears " +
    "when you leave this screen.",
  answerAbove: "Answer this question",
  stillNeededHeading: "Still needed on the form",
  stillNeededBody: "These are left blank on the prepared form. Nothing is guessed.",
  downloadButton: "Download the filled form",
  downloading: "Preparing your form…",
  downloadNote:
    "When you tap download, this page gets the blank form and fills it in " +
    "this browser. None of your answers are sent anywhere.",
  downloaded:
    "Your application downloaded. It was filled in this browser, and none " +
    "of your answers were sent anywhere.",
  templateUnavailable:
    "We couldn't get the blank form right now, so nothing was filled. " +
    "Check your connection and try again.",
  unreadableForm: "We couldn't open the blank form, so nothing was filled. Try again in a moment.",
  invalidTyped:
    "One of the answers you typed for the form couldn't be used. Please " +
    "check it and try again.",
  failed: "Something went wrong preparing your form. Please try again.",
  leftBlankHeading: "Left blank on the form you downloaded",
  handoffHeading: "Submit it yourself",
  handoffBody:
    "You submit the form yourself, through one of the official ways to " +
    "apply below. The app never submits for you.",
} as const;

const REQUIREMENT_KIND_LABELS: Readonly<Record<MatchCard["requirements"][number]["kind"], string>> = {
  document: "Document you may need",
  step: "Step",
  deadline: "Deadline",
  renewal: "Renewal",
};

const PROVENANCE_COPY: Readonly<Record<string, string>> = {
  user_supplied: "You told us",
  ai_drafted: "Drafted for you",
  source_verified: "From a source you verified",
};

const STATE_COPY: Readonly<Record<FormFlowFieldView["state"], string>> = {
  prefilled: "We already know this from what you told us",
  asked: "Still needed",
  not_applicable: "Not needed for you",
};

const LEFT_BLANK_COPY: Readonly<Record<ToResolveItem["reason"], string>> = {
  unknown: "No answer yet.",
  unsupported_characters:
    "It has characters the form's standard font can't print, so write it in by hand.",
  option_missing: "The form's choices don't include your answer, so pick one by hand.",
};

// An unverified answer must never read as confirmed (honesty spine): its
// state line says what actually happened and asks for the check.
function stateCopyFor(field: FormFlowFieldView): string {
  if (field.state === "prefilled" && field.status === "unverified") {
    return "You answered this but haven't verified it. Please check it.";
  }
  return STATE_COPY[field.state];
}

function SourceNote({ source }: { source: MatchSourceCitation }) {
  return (
    <span className="text-sm text-muted">
      Source:{" "}
      <a href={source.sourceUrl} className="underline" rel="noreferrer">
        {source.sourceUrl}
      </a>{" "}
      (retrieved {source.retrievedAt}, entry version {source.entryVersion})
    </span>
  );
}

function MatchCardView({ card }: { card: MatchCard }) {
  return (
    <article
      data-match-card={card.entryId}
      className="flex flex-col gap-3 rounded-2xl border border-surface-border bg-surface p-6"
    >
      <h3 className="font-display text-2xl font-bold">{card.entryTitle}</h3>
      <p className="text-sm text-muted">
        {card.framing} Facts from entry version {card.entryVersion}.
      </p>
      {card.reasons.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="font-medium">Why this may fit</h4>
          <ul className="list-disc pl-5 marker:text-teal">
            {card.reasons.map((reason, index) => (
              <li key={`${reason.questionId ?? "reason"}-${index}`}>
                {reason.text}
                {reason.answerLabel ? <> (your answer: {reason.answerLabel})</> : null}
                <br />
                <SourceNote source={reason.source} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <h4 className="font-medium">What you would need</h4>
        <ul className="list-disc pl-5 marker:text-teal">
          {card.requirements.map((requirement, index) => (
            <li key={`${requirement.kind}-${index}`}>
              <span className="font-medium">{REQUIREMENT_KIND_LABELS[requirement.kind]}:</span>{" "}
              {requirement.text}
              <br />
              <SourceNote source={requirement.source} />
            </li>
          ))}
        </ul>
      </div>
      {card.links.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="font-medium">Official application links</h4>
          <ul className="list-disc pl-5 marker:text-teal">
            {card.links.map((link, index) => (
              <li key={`${link.url}-${index}`}>
                <a href={link.url} className="text-teal underline hover:opacity-80" rel="noreferrer">
                  {link.label}
                </a>
                <br />
                <SourceNote source={link.source} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <h4 className="font-medium">In plain language</h4>
        <p data-match-explanation={card.entryId}>{card.explanation.text}</p>
        <p className="text-sm text-muted">{DEVICE_RESULTS_COPY.explanationFacts}</p>
      </div>
      {card.terms.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="font-medium">Terms on this card</h4>
          <dl className="flex flex-col gap-1">
            {card.terms.map((term) => (
              <div key={term.id} data-match-term={term.id}>
                <dt className="font-medium">{term.term}</dt>
                <dd>
                  {term.definition}{" "}
                  <a href={term.source.url} className="underline" rel="noreferrer">
                    {term.source.title}
                  </a>{" "}
                  (retrieved {term.source.retrievedAt})
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </article>
  );
}

/** Hand the filled form to the browser as a download. Nothing is kept here. */
function saveToDevice(bytes: Uint8Array, fileName: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function DeviceResults(props: {
  /** Every answer on this device, private values included. Never rendered or sent. */
  readonly answers: ClientAnswerState;
  /** Go back to a question, to answer what the form still needs. */
  readonly onAnswer?: (questionId: string) => void;
}) {
  const { answers, onAnswer } = props;
  const match = useMemo(() => deviceMatch(answers), [answers]);
  const review = useMemo(() => deviceFormReview(answers), [answers]);
  const handoffLinks = useMemo(() => deviceHandoffLinks(), []);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [leftBlank, setLeftBlank] = useState<readonly ToResolveItem[] | null>(null);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current) {
        clearTimeout(noticeTimer.current);
      }
    },
    [],
  );

  // The status region announces a change, so clear it and set the message
  // on the next tick: a repeated outcome is announced again.
  const announce = useCallback((message: string) => {
    setNotice("");
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = setTimeout(() => setNotice(message), 30);
  }, []);

  async function download(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const template = await loadDeviceTemplate(DEVICE_FORM_ENTRY);
      if (template === null) {
        announce(DEVICE_RESULTS_COPY.templateUnavailable);
        return;
      }
      const result = await fillFormOnDevice(template, answers, typed);
      if (result.kind === "invalid_answers") {
        announce(DEVICE_RESULTS_COPY.invalidTyped);
        return;
      }
      if (result.kind === "unreadable_form") {
        announce(DEVICE_RESULTS_COPY.unreadableForm);
        return;
      }
      saveToDevice(result.outcome.bytes, `${DEVICE_FORM_ENTRY.id}.pdf`);
      setLeftBlank(result.outcome.toResolve);
      announce(DEVICE_RESULTS_COPY.downloaded);
    } catch {
      announce(DEVICE_RESULTS_COPY.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-device-results className="flex flex-col gap-8">
      <section aria-labelledby="device-match-heading" data-match-section className="flex flex-col gap-3">
        <h2 id="device-match-heading" className="font-display text-2xl font-bold">
          {DEVICE_RESULTS_COPY.matchHeading}
        </h2>
        {match.matches.length === 0 ? (
          <p className="text-muted">{DEVICE_RESULTS_COPY.matchEmpty}</p>
        ) : null}
        {match.matches.map((card) => (
          <MatchCardView key={card.entryId} card={card} />
        ))}
        {match.toResolve.length > 0 ? (
          <div
            data-to-resolve
            className="flex flex-col gap-2 rounded-2xl border border-dashed border-amber-line bg-amber-soft p-5"
          >
            <h3 className="font-display text-xl font-bold text-amber-ink">
              {DEVICE_RESULTS_COPY.toResolveHeading}
            </h3>
            <p className="text-amber-ink">{DEVICE_RESULTS_COPY.toResolveBody}</p>
            <ul className="flex flex-col gap-2">
              {match.toResolve.map((item) => (
                <li key={item.questionId} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{item.prompt}</span>
                  <AnswerStatusBadge status={item.status} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="device-review-heading" data-review-section className="flex flex-col gap-3">
        <h2 id="device-review-heading" className="font-display text-2xl font-bold">
          {DEVICE_RESULTS_COPY.reviewHeading}
        </h2>
        <p className="text-sm text-muted">
          {DEVICE_FORM_ENTRY.title}. Source:{" "}
          <a href={DEVICE_FORM_ENTRY.source.url} className="underline" rel="noreferrer">
            {DEVICE_FORM_ENTRY.source.url}
          </a>{" "}
          (retrieved {DEVICE_FORM_ENTRY.source.retrievedAt}, form version {DEVICE_FORM_ENTRY.version})
        </p>
        <p data-real-form-note className="text-sm font-medium text-amber-ink">
          {DEVICE_RESULTS_COPY.realFormNote}
        </p>
        <ul className="flex flex-col gap-3" data-review-fields>
          {review.fields.map((field, index) => {
            const typedId = `device-form-answer-${index}`;
            const typeHere = field.state === "asked" && field.specQuestionId === null;
            return (
              <li
                key={field.fieldName}
                data-review-field={field.fieldName}
                className="flex flex-col gap-1 rounded-xl border border-surface-border bg-surface p-4"
              >
                {typeHere ? (
                  <label htmlFor={typedId} className="font-medium">
                    {field.question}
                  </label>
                ) : (
                  <span className="font-medium">{field.question}</span>
                )}
                <span className="flex flex-wrap items-center gap-2 text-sm">
                  <span data-field-state={field.state} className="text-muted">
                    {stateCopyFor(field)}
                  </span>
                  {field.status ? <AnswerStatusBadge status={field.status} /> : null}
                  {field.provenance && field.state === "prefilled" ? (
                    <span data-field-provenance={field.provenance} className="text-muted">
                      ({PROVENANCE_COPY[field.provenance]})
                    </span>
                  ) : null}
                </span>
                {field.state === "prefilled" && field.value !== undefined ? (
                  <span data-field-value={field.fieldName}>{field.value}</span>
                ) : null}
                {typeHere ? (
                  <span className="flex flex-col gap-1">
                    <input
                      id={typedId}
                      type="text"
                      autoComplete="off"
                      maxLength={MAX_FORM_ANSWER_LENGTH}
                      value={typed[field.fieldName] ?? ""}
                      onChange={(event) =>
                        setTyped((previous) => ({ ...previous, [field.fieldName]: event.target.value }))
                      }
                      className="rounded-lg border border-surface-border bg-surface px-2 py-1"
                    />
                    <span data-typed-note={field.fieldName} className="text-xs text-muted">
                      {DEVICE_RESULTS_COPY.typedNote}
                    </span>
                  </span>
                ) : null}
                {field.state === "asked" && field.specQuestionId !== null && onAnswer ? (
                  <button
                    type="button"
                    onClick={() => onAnswer(field.specQuestionId!)}
                    className="self-start text-sm text-muted underline hover:text-foreground"
                  >
                    {DEVICE_RESULTS_COPY.answerAbove}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        {review.toResolve.length > 0 ? (
          <div
            data-form-to-resolve
            className="flex flex-col gap-2 rounded-2xl border border-dashed border-amber-line bg-amber-soft p-5"
          >
            <h3 className="font-display text-xl font-bold text-amber-ink">
              {DEVICE_RESULTS_COPY.stillNeededHeading}
            </h3>
            <p className="text-amber-ink">{DEVICE_RESULTS_COPY.stillNeededBody}</p>
            <ul className="list-disc pl-5">
              {review.toResolve.map((item) => (
                <li key={item.fieldName}>{item.question}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">{DEVICE_RESULTS_COPY.downloadNote}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void download()}
            data-action="download"
            className="self-start rounded-full bg-teal-deep px-4 py-2 text-sm font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
          >
            {busy ? DEVICE_RESULTS_COPY.downloading : DEVICE_RESULTS_COPY.downloadButton}
          </button>
        </div>
        {leftBlank !== null && leftBlank.length > 0 ? (
          <div data-left-blank className="flex flex-col gap-1">
            <h3 className="font-medium">{DEVICE_RESULTS_COPY.leftBlankHeading}</h3>
            <ul className="list-disc pl-5">
              {leftBlank.map((item) => (
                <li key={item.fieldName}>
                  {item.question} {LEFT_BLANK_COPY[item.reason]}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <StatusRegion message={notice} className="text-sm text-muted" />
      </section>

      <section aria-labelledby="device-handoff-heading" data-handoff className="flex flex-col gap-2">
        <h2 id="device-handoff-heading" className="font-display text-xl font-bold">
          {DEVICE_RESULTS_COPY.handoffHeading}
        </h2>
        <p className="text-sm text-muted">{DEVICE_RESULTS_COPY.handoffBody}</p>
        <ul className="list-disc pl-5" data-handoff-links>
          {handoffLinks.map((link, index) => (
            <li key={`${link.url}-${index}`}>
              <a href={link.url} className="underline" rel="noreferrer">
                {link.label}
              </a>
              <br />
              <SourceNote source={link.source} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
