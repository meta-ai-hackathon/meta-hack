import { ANSWER_STATUS_LABELS, type AnswerStatus } from "../lib/honesty";

/**
 * Honest answer-status badge (BN-05, pairs with the BN-07 a11y baseline).
 * Renders the plain-language label for an answer's tri-state status with an
 * accessible name; color is never the only signal — the label text carries
 * the meaning.
 */
// Chip tones in the polished palette (frontend-polish): mode-invariant
// light chips, each text/background pair gated by contrast-tokens.test.ts
// at or above its pre-polish ratio (9.77 / 10.57 / 9.91 achieved).
const BADGE_TONES: Readonly<Record<AnswerStatus, string>> = {
  known: "border-[#0f3d3e]/25 bg-[#dfebe6] text-[#0f3d3e]",
  unknown: "border-[#4a3700]/25 bg-[#fcf6e3] text-[#4a3700]",
  unverified: "border-[#1c3560]/25 bg-[#e3e8f4] text-[#1c3560]",
};

const BADGE_DOTS: Readonly<Record<AnswerStatus, string>> = {
  known: "bg-[#0f3d3e]",
  unknown: "bg-[#4a3700]",
  unverified: "bg-[#1c3560]",
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
