import Link from "next/link";
import { A11yDemo } from "../components/a11y-demo";
import { AnswerStatusBadge } from "../components/answer-status-badge";
import { ANSWER_STATUSES, type AnswerStatus } from "../lib/honesty";
import { TRACKER_LINK_HEADING } from "../lib/renewal/copy";

// Demo copy for the honest-status showcase: one plain-language explanation
// per tri-state answer status (BN-05).
const STATUS_DEMOS: Readonly<Record<AnswerStatus, string>> = {
  known: "You answered from your own records.",
  unknown: "Not knowing is okay — the flow keeps going.",
  unverified: "You answered, and we have not checked it against a source yet.",
};

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-8 py-16 text-center">
      <h1 className="font-display text-5xl font-bold tracking-tight">
        Benefits Navigator
      </h1>
      <p className="max-w-md text-lg text-muted">
        A step-by-step companion for benefits applications. We help you prepare,
        keep uncertainty visible, and you decide what gets submitted.
      </p>
      <section
        aria-labelledby="honest-status-heading"
        className="flex flex-col items-center gap-3"
      >
        <h2 id="honest-status-heading" className="font-display text-2xl font-bold">
          Every answer carries an honest status
        </h2>
        <ul className="flex flex-col items-center gap-2 text-sm text-muted">
          {ANSWER_STATUSES.map((status) => (
            <li key={status} className="flex items-center gap-2">
              <AnswerStatusBadge status={status} />
              <span>{STATUS_DEMOS[status]}</span>
            </li>
          ))}
        </ul>
      </section>
      <section
        aria-labelledby="start-heading"
        className="flex flex-col items-center gap-3"
      >
        <h2 id="start-heading" className="font-display text-2xl font-bold">
          Ready when you are
        </h2>
        <p className="max-w-md text-sm text-muted">
          Answer a few plain-language questions, one at a time. Your answers
          save as you go — nothing is submitted until you decide.
        </p>
        <div className="flex flex-col items-center gap-3">
          <Link
            href="/intake/conversation"
            className="rounded-full bg-teal-deep px-6 py-3 text-base font-semibold text-teal-contrast hover:bg-teal"
          >
            Start a conversation
          </Link>
          <Link
            href="/intake"
            className="text-base text-teal underline hover:opacity-80"
          >
            Prefer step-by-step questions? Use the form instead
          </Link>
          <Link
            href="/renewal"
            className="text-base text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            {TRACKER_LINK_HEADING}
          </Link>
        </div>
      </section>
      <section
        aria-labelledby="a11y-demo-heading"
        className="flex flex-col items-center gap-3"
      >
        <h2 id="a11y-demo-heading" className="font-display text-2xl font-bold">
          Accessibility built in
        </h2>
        <p className="max-w-md text-sm text-muted">
          Tab through this page: the skip link is the first stop, and focus
          stays visible. The examples below show how labels, help text, and
          status changes are announced.
        </p>
        <A11yDemo />
      </section>
    </div>
  );
}
