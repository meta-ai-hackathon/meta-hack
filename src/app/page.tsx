import { A11yDemo } from "../components/a11y-demo";
import { AnswerStatusBadge } from "../components/answer-status-badge";
import { ANSWER_STATUSES, type AnswerStatus } from "../lib/honesty";

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
      <h1 className="text-3xl font-semibold tracking-tight">Benefits Navigator</h1>
      <p className="max-w-md text-lg text-zinc-600 dark:text-zinc-400">
        A step-by-step companion for benefits applications. We help you prepare,
        keep uncertainty visible, and you decide what gets submitted.
      </p>
      <section
        aria-labelledby="honest-status-heading"
        className="flex flex-col items-center gap-3"
      >
        <h2 id="honest-status-heading" className="text-lg font-semibold">
          Every answer carries an honest status
        </h2>
        <ul className="flex flex-col items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          {ANSWER_STATUSES.map((status) => (
            <li key={status} className="flex items-center gap-2">
              <AnswerStatusBadge status={status} />
              <span>{STATUS_DEMOS[status]}</span>
            </li>
          ))}
        </ul>
      </section>
      <section
        aria-labelledby="a11y-demo-heading"
        className="flex flex-col items-center gap-3"
      >
        <h2 id="a11y-demo-heading" className="text-lg font-semibold">
          Accessibility built in
        </h2>
        <p className="max-w-md text-sm text-zinc-600 dark:text-zinc-400">
          Tab through this page: the skip link is the first stop, and focus
          stays visible. The examples below show how labels, help text, and
          status changes are announced.
        </p>
        <A11yDemo />
      </section>
    </div>
  );
}
