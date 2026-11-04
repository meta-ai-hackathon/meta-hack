import { SourceCard } from "../../../components/source-card";
import {
  HANDOFF_WHERE_LABELS,
  handoffCompanionForForm,
  nextHandoffAction,
  showsAfterYouApply,
  type HandoffCompanion,
  type HandoffStepView,
} from "../../../lib/handoff";
import { isSessionStatus } from "../../../lib/honesty";

// The handoff companion (BN-23, BN-24, BN-26; HACK-49, HACK-46, HACK-47,
// HACK-119), mounted inside the review section's handoff. It shows one
// next step, labeled with where it happens, then the ordered steps for
// signing the form and sending it in, and, once the form is handed off,
// what the sources say happens next. Every step comes from the knowledge
// base with its source card (BN-27). There is no button, form, or link
// here that signs, sends, submits, or faxes anything: the person does
// that themselves, through the official channels the steps link.
//
// HACK-119 splits the render in two: the next-step box (NextActionBox)
// LEADS the handoff — it renders first, before the review's own
// controls — and the sourced steps (SourcedHandoffSteps) follow them.
// HandoffSection keeps the combined rendering for surfaces that want the
// whole companion in one place.

export interface HandoffSectionProps {
  /** The form-registry id of the form under review. */
  readonly formId: string;
  /** The session's BN-25 lifecycle status, as the review section holds it. */
  readonly sessionStatus: string;
  /** Whether the filled form was downloaded in this view. */
  readonly downloaded: boolean;
  /** How many items the prepared form still lists as needed. */
  readonly stillNeededCount: number;
  /** The sourced steps. Defaults to the ones the KB writes for this form. */
  readonly companion?: HandoffCompanion | null;
  /**
   * DOM-id prefix for this section's labelled headings: two prepared
   * applications render as sibling review sections, and ids must stay
   * unique per form (the label wiring + axe).
   */
  readonly idPrefix?: string;
}

function StepItem({ step }: { step: HandoffStepView }) {
  return (
    <li data-handoff-step={step.id} className="pl-1">
      <div className="flex flex-col gap-1">
        <span className="font-medium">{step.label}</span>
        <span>{step.detail}</span>
        {step.link ? (
          <a
            href={step.link.url}
            className="text-teal underline hover:opacity-80"
            rel="noreferrer"
          >
            {step.link.label}
          </a>
        ) : null}
        <SourceCard source={step.source} />
      </div>
    </li>
  );
}

/**
 * The handoff's ONE next step (BN-23, HACK-49), as its own box: the box
 * LEADS the handoff (HACK-119) — the review section renders it first,
 * before its own controls. Null without sourced steps written for this
 * form, or with a status outside BN-25 (there is nothing honest to say).
 */
export function NextActionBox({
  formId,
  sessionStatus,
  downloaded,
  stillNeededCount,
  companion = handoffCompanionForForm(formId),
  idPrefix = "",
}: HandoffSectionProps) {
  if (!companion || !isSessionStatus(sessionStatus)) {
    return null;
  }
  const idFor = (suffix: string): string =>
    idPrefix === "" ? suffix : `${idPrefix}-${suffix}`;
  const action = nextHandoffAction({
    sessionStatus,
    downloaded,
    stillNeededCount,
  });
  return (
    <section
      aria-labelledby={idFor("next-action-heading")}
      data-next-action={action.kind}
      className="flex flex-col gap-2 rounded-2xl border-2 border-teal bg-teal-soft p-5"
    >
      <h3
        id={idFor("next-action-heading")}
        className="font-display text-xl font-bold"
      >
        Your next step
      </h3>
      <p>
        <span
          data-where={action.where}
          className="inline-block rounded-full border border-teal-deep px-3 py-0.5 text-sm font-semibold"
        >
          {HANDOFF_WHERE_LABELS[action.where]}
        </span>
      </p>
      <p className="font-semibold">{action.title}</p>
      <p>{action.detail}</p>
    </section>
  );
}

/**
 * The sourced steps beside the next step: how to sign the form and send
 * it in, then — once it is handed off — what to expect after. Every step
 * cites its official source (BN-27). Null on the same terms the whole
 * companion is.
 */
export function SourcedHandoffSteps({
  formId,
  sessionStatus,
  companion = handoffCompanionForForm(formId),
  idPrefix = "",
}: HandoffSectionProps) {
  if (!companion || !isSessionStatus(sessionStatus)) {
    return null;
  }
  const status = sessionStatus as Parameters<typeof showsAfterYouApply>[0];
  const idFor = (suffix: string): string =>
    idPrefix === "" ? suffix : `${idPrefix}-${suffix}`;
  return (
    <>
      <section
        aria-labelledby={idFor("submission-steps-heading")}
        data-submission-steps
        className="flex flex-col gap-2"
      >
        <h3
          id={idFor("submission-steps-heading")}
          className="font-display text-xl font-bold"
        >
          Signing it and sending it in yourself
        </h3>
        <p className="text-sm text-muted">
          In order, with the official source for each step. You sign the
          form and send it in yourself. Nothing on this page sends it for
          you.
        </p>
        <ol className="list-decimal space-y-3 pl-5">
          {companion.submissionSteps.map((step) => (
            <StepItem key={step.id} step={step} />
          ))}
        </ol>
      </section>

      {showsAfterYouApply(status) ? (
        <section
          aria-labelledby={idFor("after-you-apply-heading")}
          data-after-you-apply
          className="flex flex-col gap-2"
        >
          <h3
            id={idFor("after-you-apply-heading")}
            className="font-display text-xl font-bold"
          >
            What to expect after you send it
          </h3>
          <p className="text-sm text-muted">
            What the form and the official guidance say happens next. They
            describe the agency&apos;s process, not the outcome of any one
            application.
          </p>
          <ul className="list-disc space-y-3 pl-5">
            {companion.afterYouApply.map((step) => (
              <StepItem key={step.id} step={step} />
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** The whole companion in one place: the next-step box, then its steps. */
export function HandoffSection(props: HandoffSectionProps) {
  // An explicitly passed null companion (tests, callers) wins over the
  // registry default; only an absent prop falls back to it.
  const companion =
    props.companion === undefined
      ? handoffCompanionForForm(props.formId)
      : props.companion;
  if (!companion || !isSessionStatus(props.sessionStatus)) {
    return null;
  }
  return (
    <div data-handoff-companion className="flex flex-col gap-5">
      <NextActionBox {...props} companion={companion} />
      <SourcedHandoffSteps {...props} companion={companion} />
    </div>
  );
}
