import {
  formatIsoDate,
  formatLongDate,
  parseIsoDate,
  type CalendarDate,
} from "../../lib/renewal/calendar-date";
import {
  ESTIMATE_EXPLAINER,
  FACTS_SUBHEADINGS,
  IF_COVERAGE_ENDS_HEADING,
  NO_ESTIMATE_NOTE,
  PASSED_ADVICE,
  PASSED_ESTIMATE_ADVICE,
  STALE_ESTIMATE_NOTE,
  ageAnswerSentence,
  ageLeftOutNote,
  entryStatusFlag,
  estimateSentence,
  factsHeading,
  factsIntro,
  originLabel,
  reminderMessage,
  reportedDateSentence,
  type DateOrigin,
} from "../../lib/renewal/copy";
import { estimateRenewals, excludedByAge } from "../../lib/renewal/estimate";
import {
  parseReportedDate,
  reminderStatus,
  type RenewalReminder,
  type ReminderStatus,
} from "../../lib/renewal/reminder";
import type {
  RenewalFactItem,
  RenewalFactsView,
  RenewalSourceView,
} from "../../lib/renewal/renewal-facts";

// Presentational pieces of the renewal tracker (BN-22 / HACK-50). No hooks
// and no storage here: the server page renders the knowledge-base facts,
// and the client tracker renders the person's own date through the same
// components, so every state can be checked with static markup in tests.
//
// The origin rule: every date and fact on screen carries a label saying
// where it came from. "From <program>" for knowledge-base facts (always
// with the source link, retrieval date, and entry version), "You told us"
// for the person's own date, and "Estimate, not an official date" for a
// date worked out from the two. The labels differ in words and in border
// style, never only in color.

const ORIGIN_STYLES: Readonly<Record<DateOrigin, string>> = {
  official: "border-solid border-sky-800 bg-sky-50 text-sky-950",
  user: "border-solid border-emerald-800 bg-emerald-50 text-emerald-950",
  estimate: "border-dashed border-amber-800 bg-amber-50 text-amber-950",
};

export function OriginTag({
  origin,
  programName,
}: {
  origin: DateOrigin;
  programName: string;
}) {
  // The trailing space keeps the label a separate word for screen readers
  // and copied text ("From NC Medicaid Every 6 months", not "MedicaidEvery").
  return (
    <>
      <span
        data-origin={origin}
        className={`mr-1 inline-flex items-center rounded-full border-2 px-2.5 py-0.5 text-sm font-medium ${ORIGIN_STYLES[origin]}`}
      >
        {originLabel(origin, programName)}
      </span>{" "}
    </>
  );
}

export function SourceNote({ source }: { source: RenewalSourceView }) {
  return (
    <span className="text-sm text-zinc-600 dark:text-zinc-400">
      Source:{" "}
      <a href={source.sourceUrl} className="underline" rel="noreferrer">
        {source.sourceTitle}
      </a>{" "}
      (retrieved {source.retrievedAt}, entry version {source.entryVersion})
    </span>
  );
}

function CalendarTime({ date }: { date: CalendarDate }) {
  return <time dateTime={formatIsoDate(date)}>{formatLongDate(date)}</time>;
}

function FactList({
  items,
  programName,
  name,
}: {
  items: readonly RenewalFactItem[];
  programName: string;
  name: string;
}) {
  return (
    <ul className="flex flex-col gap-3" data-renewal-fact-list={name}>
      {items.map((item, index) => (
        <li key={`${name}-${index}`} data-renewal-fact>
          <OriginTag origin="official" programName={programName} />
          {item.text}
          <br />
          <SourceNote source={item.source} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Everything the knowledge base says about renewal, each item labeled and
 * sourced. Stale entries show a visible flag; withdrawn entries show only
 * the flag (BN-29).
 */
export function RenewalFactsSection({ facts }: { facts: RenewalFactsView }) {
  const program = facts.programName;
  return (
    <section
      aria-labelledby="renewal-facts-heading"
      data-renewal-facts
      className="flex flex-col gap-6"
    >
      <div className="flex flex-col gap-2">
        <h2 id="renewal-facts-heading" className="text-xl font-semibold">
          {factsHeading(program)}
        </h2>
        <p className="text-zinc-600 dark:text-zinc-400">{factsIntro(program)}</p>
      </div>
      {facts.entryStatus !== "active" ? (
        <p
          role="note"
          data-renewal-entry-status={facts.entryStatus}
          className="rounded-md border-2 border-amber-800 bg-amber-50 p-3 font-medium text-amber-950"
        >
          {entryStatusFlag(facts.entryStatus, facts.statusReason)}
        </p>
      ) : null}
      {facts.schedules.length > 0 ? (
        <section aria-labelledby="renewal-schedules-heading" className="flex flex-col gap-3">
          <h3 id="renewal-schedules-heading" className="text-lg font-semibold">
            {FACTS_SUBHEADINGS.schedules}
          </h3>
          <ul className="flex flex-col gap-3" data-renewal-fact-list="schedules">
            {facts.schedules.map((schedule) => (
              <li key={schedule.id} data-renewal-fact data-renewal-schedule={schedule.id}>
                <OriginTag origin="official" programName={program} />
                <span className="font-medium">{schedule.label}:</span> {schedule.appliesTo}.
                <br />
                <SourceNote source={schedule.source} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {facts.keyDates.length > 0 || facts.deadlineNotes.length > 0 ? (
        <section aria-labelledby="renewal-dates-heading" className="flex flex-col gap-3">
          <h3 id="renewal-dates-heading" className="text-lg font-semibold">
            {FACTS_SUBHEADINGS.keyDates}
          </h3>
          <ul className="flex flex-col gap-3" data-renewal-fact-list="dates">
            {facts.keyDates.map((keyDate, index) => {
              const date = parseIsoDate(keyDate.date);
              return (
                <li key={`date-${index}`} data-renewal-fact data-renewal-key-date={keyDate.date}>
                  <OriginTag origin="official" programName={program} />
                  <span className="font-medium">
                    {date ? <CalendarTime date={date} /> : keyDate.date}:
                  </span>{" "}
                  {keyDate.label}.
                  <br />
                  <SourceNote source={keyDate.source} />
                </li>
              );
            })}
            {facts.deadlineNotes.map((note, index) => (
              <li key={`note-${index}`} data-renewal-fact>
                <OriginTag origin="official" programName={program} />
                <span className="font-medium">{note.label}:</span> {note.due}
                <br />
                <SourceNote source={note.source} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {facts.steps.length > 0 ? (
        <section aria-labelledby="renewal-steps-heading" className="flex flex-col gap-3">
          <h3 id="renewal-steps-heading" className="text-lg font-semibold">
            {FACTS_SUBHEADINGS.steps}
          </h3>
          <FactList items={facts.steps} programName={program} name="steps" />
        </section>
      ) : null}
      {facts.documents.length > 0 ? (
        <section aria-labelledby="renewal-documents-heading" className="flex flex-col gap-3">
          <h3 id="renewal-documents-heading" className="text-lg font-semibold">
            {FACTS_SUBHEADINGS.documents}
          </h3>
          <FactList items={facts.documents} programName={program} name="documents" />
        </section>
      ) : null}
      {facts.rules.length > 0 ? (
        <section aria-labelledby="renewal-rules-heading" className="flex flex-col gap-3">
          <h3 id="renewal-rules-heading" className="text-lg font-semibold">
            {FACTS_SUBHEADINGS.rules}
          </h3>
          <FactList items={facts.rules} programName={program} name="rules" />
        </section>
      ) : null}
      {facts.ifCoverageEnds.length > 0 ? (
        <section aria-labelledby="renewal-coverage-ends-heading" className="flex flex-col gap-3">
          <h3 id="renewal-coverage-ends-heading" className="text-lg font-semibold">
            {FACTS_SUBHEADINGS.ifCoverageEnds}
          </h3>
          <FactList items={facts.ifCoverageEnds} programName={program} name="if-coverage-ends" />
        </section>
      ) : null}
      {facts.links.length > 0 ? (
        <section aria-labelledby="renewal-links-heading" className="flex flex-col gap-3">
          <h3 id="renewal-links-heading" className="text-lg font-semibold">
            {FACTS_SUBHEADINGS.links}
          </h3>
          <ul className="flex flex-col gap-3" data-renewal-fact-list="links">
            {facts.links.map((link) => (
              <li key={link.url} data-renewal-fact>
                <OriginTag origin="official" programName={program} />
                <a href={link.url} className="font-medium underline" rel="noreferrer">
                  {link.label}
                </a>
                <br />
                <SourceNote source={link.source} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

/**
 * The reminder line, emphasized once a reminder is due (soon, today,
 * passed). Once a date has passed it adds what to do, and what the
 * knowledge base says about coverage ending, each item labeled and sourced.
 */
export function ReminderCallout({
  status,
  programName,
  fromEstimate,
  ifCoverageEnds = [],
}: {
  status: ReminderStatus;
  programName: string;
  fromEstimate: boolean;
  ifCoverageEnds?: readonly RenewalFactItem[];
}) {
  const message = reminderMessage(status, programName, fromEstimate);
  if (status.phase === "later") {
    return (
      <p data-reminder-phase="later" className="text-zinc-700 dark:text-zinc-300">
        {message}
      </p>
    );
  }
  return (
    <div
      data-reminder-phase={status.phase}
      className="flex flex-col gap-2 rounded-md border-2 border-amber-800 bg-amber-50 p-4 text-amber-950"
    >
      <p className="font-semibold">{message}</p>
      {status.phase === "passed" ? (
        <>
          <p>{fromEstimate ? PASSED_ESTIMATE_ADVICE : PASSED_ADVICE}</p>
          {ifCoverageEnds.length > 0 ? (
            <div data-renewal-coverage-ends className="flex flex-col gap-2">
              <p className="font-semibold">{IF_COVERAGE_ENDS_HEADING}</p>
              <ul className="flex flex-col gap-2">
                {ifCoverageEnds.map((item, index) => (
                  <li key={`coverage-ends-${index}`}>
                    <OriginTag origin="official" programName={programName} />
                    {item.text}
                    <br />
                    <SourceNote source={item.source} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/**
 * The person's saved date: what they told us, any estimates worked out
 * from it (each with the schedule and source it assumes), and where the
 * reminder stands today.
 */
export function ReportedDateView({
  facts,
  reminder,
  today,
}: {
  facts: Pick<RenewalFactsView, "programName" | "schedules" | "entryStatus" | "ifCoverageEnds">;
  reminder: Pick<RenewalReminder, "kind" | "reportedDate" | "ageAnswer">;
  today: CalendarDate;
}) {
  const reported = parseReportedDate(reminder.reportedDate);
  if (reported === null) {
    return null;
  }
  const program = facts.programName;
  const fromEstimate = reminder.kind === "approval";
  const ageAnswer = fromEstimate ? reminder.ageAnswer : undefined;
  const estimates = fromEstimate ? estimateRenewals(reported, facts.schedules, ageAnswer) : [];
  const leftOut = fromEstimate
    ? facts.schedules.filter((schedule) => excludedByAge(schedule, ageAnswer))
    : [];
  const status = reminderStatus(
    today,
    fromEstimate ? estimates.map((estimate) => estimate.date) : [reported],
  );
  return (
    <div data-renewal-reported={reminder.kind} className="flex flex-col gap-4">
      <p data-renewal-user-date={reminder.reportedDate}>
        <OriginTag origin="user" programName={program} />
        {reportedDateSentence(reminder.kind, reported)}
      </p>
      {ageAnswer !== undefined ? (
        <p data-renewal-age-answer={ageAnswer.answer}>
          <OriginTag origin="user" programName={program} />
          {ageAnswerSentence(ageAnswer)}
        </p>
      ) : null}
      {fromEstimate ? (
        <div className="flex flex-col gap-3">
          <p className="text-zinc-700 dark:text-zinc-300">{ESTIMATE_EXPLAINER}</p>
          {facts.entryStatus === "stale" && estimates.length > 0 ? (
            <p
              role="note"
              data-renewal-estimate-stale
              className="rounded-md border-2 border-amber-800 bg-amber-50 p-3 font-medium text-amber-950"
            >
              {STALE_ESTIMATE_NOTE}
            </p>
          ) : null}
          {leftOut.map((schedule) =>
            schedule.ages ? (
              // The age scope that leaves this estimate out, with the
              // official page that states it (second review: the note
              // had no source).
              <div key={schedule.id} data-renewal-left-out={schedule.id} className="flex flex-col gap-1">
                <p className="text-zinc-700 dark:text-zinc-300">{ageLeftOutNote(schedule.label, schedule.ages)}</p>
                <p className="text-sm">
                  <OriginTag origin="official" programName={program} />
                  {schedule.label}: {schedule.appliesTo}.
                  <br />
                  <SourceNote source={schedule.source} />
                </p>
              </div>
            ) : null,
          )}
          {estimates.length === 0 ? (
            <p>{NO_ESTIMATE_NOTE}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {estimates.map((estimate) => {
                const schedule = facts.schedules.find(
                  (candidate) => candidate.id === estimate.scheduleId,
                );
                if (!schedule) {
                  return null;
                }
                return (
                  <li key={estimate.scheduleId} data-renewal-estimate={estimate.scheduleId}>
                    <OriginTag origin="estimate" programName={program} />
                    {estimateSentence(schedule.label, estimate.date)}
                    <br />
                    <span className="text-sm">
                      <OriginTag origin="official" programName={program} />
                      {schedule.label}: {schedule.appliesTo}.
                    </span>
                    <br />
                    <SourceNote source={schedule.source} />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
      {status ? (
        <ReminderCallout
          status={status}
          programName={program}
          fromEstimate={fromEstimate}
          ifCoverageEnds={facts.ifCoverageEnds}
        />
      ) : null}
    </div>
  );
}
