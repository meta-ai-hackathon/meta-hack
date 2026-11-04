"use client";

import { useEffect, useRef, useState } from "react";

// A concept preview of one-click renewals, for the launch video (HACK-152).
// Renewals aren't built yet. This page shows how one could feel, with
// made-up details, and does nothing else: it isn't linked from the app, it
// makes no requests, and it keeps nothing, so everything here lives in the
// page's memory and goes when the page closes. The person taps through what
// changed since their last application, sees exactly what would be sent,
// and has to confirm it, so a renewal never goes out unchecked. The last
// screen says plainly that nothing was sent, that in the real app they
// review, sign and send the form themselves, and that the agency decides.

/** The made-up household the preview shows. None of it is a real person's. */
export const PREVIEW_HOUSEHOLD = {
  name: "Jamie Watts (made up)",
  household: "3 people: Jamie and two children",
  income: "$2,400 every two weeks from a job",
  address: "100 Sample Lane, Charlotte, NC",
} as const;

export type PreviewCheckId = "household" | "income" | "address";

/** What the preview asks about, one question a screen, with the answer from last time. */
export const PREVIEW_CHECKS: readonly {
  readonly id: PreviewCheckId;
  readonly label: string;
  readonly question: string;
  readonly lastTime: string;
}[] = [
  {
    id: "household",
    label: "Household",
    question: "Has anyone moved in or out since your last application?",
    lastTime: PREVIEW_HOUSEHOLD.household,
  },
  {
    id: "income",
    label: "Income",
    question: "Has your income changed since your last application?",
    lastTime: PREVIEW_HOUSEHOLD.income,
  },
  {
    id: "address",
    label: "Address",
    question: "Has your address changed since your last application?",
    lastTime: PREVIEW_HOUSEHOLD.address,
  },
];

export const RENEWAL_PREVIEW_COPY = {
  banner:
    "Concept preview. Renewals aren't built yet. This page uses made-up details, and nothing here is sent or saved.",
  heading: "Your Medicaid renewal",
  intro:
    "When it's time to renew, the idea is to start from your last application. If nothing changed, you check it and confirm in a few taps instead of filling out the whole form again.",
  forWhom: `Renewal for ${PREVIEW_HOUSEHOLD.name}`,
  start: "Start the renewal",
  lastTime: "On your last application",
  noChange: "No change",
  changed: "Something changed",
  changedNote: "In the real app, you'd update just this part before confirming. This preview keeps the details from last time.",
  reviewHeading: "Here's what would be sent",
  reviewIntro: "Everything else stays as it was on your last application.",
  needsUpdate: "Needs updating",
  markedChanged: "You said this changed, so in the real app you'd update it here.",
  confirmCheck: "I've checked these details and they're correct.",
  confirmCheckChanged: "I've checked these details and marked what needs updating.",
  confirmNote: "In the real app, you'd see the filled renewal form and sign it yourself before anything is sent.",
  confirm: "Confirm these details",
  doneHeading: "Preview finished. Nothing was sent.",
  doneBody:
    "In the real app, Tenet would prepare your renewal form for you to review, sign and send yourself. Only the agency decides on your renewal.",
  again: "Start the preview again",
} as const;

/** The steps the preview walks through, in order. */
type Step = "intro" | { readonly check: number } | "review" | "done";

/** "Step n of 4" for the three questions and the review. */
function stepLabel(step: Step): string | null {
  const total = PREVIEW_CHECKS.length + 1;
  if (step === "review") {
    return `Step ${total} of ${total}`;
  }
  if (typeof step === "object") {
    return `Step ${step.check + 1} of ${total}`;
  }
  return null;
}

const PRIMARY_BUTTON =
  "min-h-11 rounded-full bg-teal-deep px-6 py-2.5 text-base font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50";
const SECONDARY_BUTTON =
  "min-h-11 rounded-full border border-surface-border bg-surface px-6 py-2.5 text-base font-medium hover:bg-teal-soft";

export function RenewalPreview() {
  const [step, setStep] = useState<Step>("intro");
  const [changed, setChanged] = useState<ReadonlySet<PreviewCheckId>>(new Set());
  const [checked, setChecked] = useState(false);
  const heading = useRef<HTMLHeadingElement | null>(null);
  const shownStep = useRef<Step>(step);

  // Each new step takes focus to its heading, so a screen reader lands on
  // it. The first screen keeps the page's own starting focus. Comparing
  // with the step last shown, instead of flipping a one-time flag, keeps
  // that true when React runs this effect twice on mount in development.
  useEffect(() => {
    if (shownStep.current !== step) {
      heading.current?.focus();
    }
    shownStep.current = step;
  }, [step]);

  function answer(id: PreviewCheckId, didChange: boolean, index: number): void {
    setChanged((current) => {
      const next = new Set(current);
      if (didChange) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
    setStep(index + 1 < PREVIEW_CHECKS.length ? { check: index + 1 } : "review");
  }

  function restart(): void {
    setChanged(new Set());
    setChecked(false);
    setStep("intro");
  }

  const label = stepLabel(step);

  return (
    <div data-renewal-preview className="flex flex-col gap-6">
      <p
        data-concept-banner
        className="rounded-2xl border border-dashed border-amber-line bg-amber-soft p-4 font-medium text-amber-ink"
      >
        {RENEWAL_PREVIEW_COPY.banner}
      </p>
      <h1 className="font-display text-4xl font-bold tracking-tight">{RENEWAL_PREVIEW_COPY.heading}</h1>

      {label === null ? null : (
        <p data-step-label className="text-sm font-medium text-muted">
          {label}
        </p>
      )}

      {step === "intro" ? (
        <section aria-labelledby="renewal-step-heading" className="flex flex-col gap-4">
          <h2 id="renewal-step-heading" ref={heading} tabIndex={-1} className="font-display text-2xl font-bold">
            {RENEWAL_PREVIEW_COPY.forWhom}
          </h2>
          <p className="max-w-xl text-lg text-muted">{RENEWAL_PREVIEW_COPY.intro}</p>
          <button type="button" data-action="start" className={`self-start ${PRIMARY_BUTTON}`} onClick={() => setStep({ check: 0 })}>
            {RENEWAL_PREVIEW_COPY.start}
          </button>
        </section>
      ) : null}

      {typeof step === "object" ? (
        <section aria-labelledby="renewal-step-heading" data-check={PREVIEW_CHECKS[step.check].id} className="flex flex-col gap-4">
          <h2 id="renewal-step-heading" ref={heading} tabIndex={-1} className="font-display text-2xl font-bold">
            {PREVIEW_CHECKS[step.check].question}
          </h2>
          <div className="flex flex-col gap-1 rounded-xl border border-surface-border bg-surface p-4">
            <p className="text-sm text-muted">{RENEWAL_PREVIEW_COPY.lastTime}</p>
            <p data-last-time className="text-lg font-medium">
              {PREVIEW_CHECKS[step.check].lastTime}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              data-action="no-change"
              className={PRIMARY_BUTTON}
              onClick={() => answer(PREVIEW_CHECKS[step.check].id, false, step.check)}
            >
              {RENEWAL_PREVIEW_COPY.noChange}
            </button>
            <button
              type="button"
              data-action="changed"
              className={SECONDARY_BUTTON}
              onClick={() => answer(PREVIEW_CHECKS[step.check].id, true, step.check)}
            >
              {RENEWAL_PREVIEW_COPY.changed}
            </button>
          </div>
          <p className="text-sm text-muted">{RENEWAL_PREVIEW_COPY.changedNote}</p>
        </section>
      ) : null}

      {step === "review" ? (
        <section aria-labelledby="renewal-step-heading" data-review className="flex flex-col gap-4">
          <h2 id="renewal-step-heading" ref={heading} tabIndex={-1} className="font-display text-2xl font-bold">
            {RENEWAL_PREVIEW_COPY.reviewHeading}
          </h2>
          {/* Anything the person said changed shows "Needs updating" in place of
              last time's value, so the review never presents a stale answer as
              what would be sent. Last time's value stays below it, labeled. */}
          <dl className="flex flex-col gap-3">
            {PREVIEW_CHECKS.map((check) => (
              <div
                key={check.id}
                data-review-item={check.id}
                className="flex flex-col gap-1 rounded-xl border border-surface-border bg-surface p-4"
              >
                <dt className="text-sm text-muted">{check.label}</dt>
                {changed.has(check.id) ? (
                  <>
                    <dd data-marked-changed className="text-lg font-semibold text-amber-ink">
                      {RENEWAL_PREVIEW_COPY.needsUpdate}
                    </dd>
                    <dd className="text-sm text-muted">
                      {RENEWAL_PREVIEW_COPY.lastTime}: {check.lastTime}
                    </dd>
                    <dd className="text-sm text-muted">{RENEWAL_PREVIEW_COPY.markedChanged}</dd>
                  </>
                ) : (
                  <dd className="text-lg font-medium">{check.lastTime}</dd>
                )}
              </div>
            ))}
          </dl>
          <p className="text-muted">{RENEWAL_PREVIEW_COPY.reviewIntro}</p>
          <label className="flex items-start gap-3 text-base">
            <input
              type="checkbox"
              data-confirm-check
              className="mt-1 h-5 w-5"
              checked={checked}
              onChange={(event) => setChecked(event.target.checked)}
            />
            <span data-confirm-label>
              {changed.size > 0 ? RENEWAL_PREVIEW_COPY.confirmCheckChanged : RENEWAL_PREVIEW_COPY.confirmCheck}
            </span>
          </label>
          <p id="renewal-confirm-note" className="text-sm text-muted">
            {RENEWAL_PREVIEW_COPY.confirmNote}
          </p>
          <button
            type="button"
            data-action="confirm"
            className={`self-start ${PRIMARY_BUTTON}`}
            disabled={!checked}
            aria-describedby="renewal-confirm-note"
            onClick={() => setStep("done")}
          >
            {RENEWAL_PREVIEW_COPY.confirm}
          </button>
        </section>
      ) : null}

      {step === "done" ? (
        <section aria-labelledby="renewal-step-heading" data-done className="flex flex-col gap-4">
          <h2 id="renewal-step-heading" ref={heading} tabIndex={-1} className="font-display text-2xl font-bold">
            {RENEWAL_PREVIEW_COPY.doneHeading}
          </h2>
          <p className="max-w-xl text-lg text-muted">{RENEWAL_PREVIEW_COPY.doneBody}</p>
          <button type="button" data-action="again" className={`self-start ${SECONDARY_BUTTON}`} onClick={restart}>
            {RENEWAL_PREVIEW_COPY.again}
          </button>
        </section>
      ) : null}
    </div>
  );
}
