import { ANSWER_STATUS_LABELS, type AnswerStatus } from "../lib/honesty";

/**
 * Honest answer-status badge (BN-05, pairs with the BN-07 a11y baseline).
 * Renders the plain-language label for an answer's tri-state status with an
 * accessible name; color is never the only signal — the label text carries
 * the meaning.
 */
const BADGE_TONES: Readonly<Record<AnswerStatus, string>> = {
  known: "border-emerald-600 bg-emerald-50 text-emerald-900",
  unknown: "border-amber-500 bg-amber-50 text-amber-900",
  unverified: "border-sky-600 bg-sky-50 text-sky-900",
};

const BADGE_DOTS: Readonly<Record<AnswerStatus, string>> = {
  known: "bg-emerald-600",
  unknown: "bg-amber-500",
  unverified: "bg-sky-600",
};

export function AnswerStatusBadge({ status }: { status: AnswerStatus }) {
  const label = ANSWER_STATUS_LABELS[status];
  return (
    <span
      data-status={status}
      role="status"
      aria-label={label}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-medium ${BADGE_TONES[status]}`}
    >
      <span
        aria-hidden="true"
        className={`h-1.5 w-1.5 rounded-full ${BADGE_DOTS[status]}`}
      />
      {label}
    </span>
  );
}
