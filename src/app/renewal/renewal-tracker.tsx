"use client";

import { useEffect, useRef, useState } from "react";
import { Field } from "../../components/field";
import { StatusRegion } from "../../components/status-region";
import { deviceLocalMoment, deviceToday } from "../../lib/renewal/calendar-date";
import {
  AGE_QUESTION_HELP,
  BROWSER_CAN_CLEAR_NOTE,
  CHANGE_BUTTON,
  DATE_CHOICE_HELP,
  DATE_CHOICE_LABELS,
  DATE_CHOICE_LEGEND,
  DATE_FIELD_HELP,
  DATE_FIELD_LABEL,
  DISCARDED_NOTICE,
  DOWNLOADED_NOTICE,
  DOWNLOAD_BUTTON,
  DOWNLOAD_FAILED_NOTICE,
  LOADING_NOTE,
  NOSCRIPT_NOTE,
  NO_DATE_INTRO,
  NO_ESTIMATE_NOTE,
  PRIVACY_NOTE,
  REMOVED_NOTICE,
  REMOVE_BUTTON,
  REMOVE_FAILED_NOTICE,
  SAVE_BUTTON,
  SAVE_CHANGED_NOTICE,
  SAVE_FAILED_NOTICE,
  SECTION_HEADING,
  STORAGE_UNAVAILABLE_NOTE,
  UNKNOWN_DATE_NOTE,
  UNSUPPORTED_NOTICE,
  ageChoiceLabels,
  ageQuestionLegend,
  savedNotice,
  type DateChoice,
} from "../../lib/renewal/copy";
import { checkDateForm, type DateFormCheck } from "../../lib/renewal/date-form";
import {
  DEVICE_STORAGE_TIMEOUT_MS,
  openDeviceReminderStore,
  requestPersistentStorage,
  withDeadline,
} from "../../lib/renewal/device-kv";
import { CALENDAR_FILE_TYPE, downloadTextFile, offerFile } from "../../lib/renewal/download";
import {
  AGE_ANSWERS,
  ageQuestionRange,
  type AgeAnswer,
  type AgeAnswerValue,
} from "../../lib/renewal/estimate";
import {
  MAX_REMINDER_REVISION,
  RENEWAL_REMINDER_VERSION,
  REPORTED_DATE_MAX,
  REPORTED_DATE_MIN,
  newCalendarId,
  type RenewalReminder,
  type ReportedDateKind,
} from "../../lib/renewal/reminder";
import { buildReminderCalendar } from "../../lib/renewal/reminder-calendar";
import {
  clearReminder,
  loadReminder,
  saveReminder,
  type ReminderStoreDeps,
} from "../../lib/renewal/reminder-store";
import type { RenewalFactsView } from "../../lib/renewal/renewal-facts";
import { useDeviceToday } from "../../lib/renewal/use-device-today";
import { ReportedDateView } from "./renewal-view";

// The renewal tracker's client side (BN-22 / HACK-50): the person's own
// date, entered, sealed on this device, turned into a calendar file, or
// removed. Nothing in this component calls fetch or any route: the date
// lives in React state, the encrypted device store, and a blob: download.
// The form renders only after mount, so a click before hydration can never
// submit the date to the server in a URL, and the date input has no `name`
// for the same reason.

const DATE_CHOICES: readonly DateChoice[] = ["renewal_due", "approval", "unknown"];

/** Hides the loading line when scripting is off (rendered inside <noscript>). */
export const HIDE_LOADING_WITHOUT_SCRIPT_CSS = "[data-renewal-loading]{display:none}";

type Storage =
  | { readonly state: "checking" }
  | { readonly state: "unavailable" }
  | { readonly state: "ready"; readonly deps: ReminderStoreDeps };

/**
 * The form's reminder identity: the calendar id names the file's events
 * across downloads and date changes, and the revision counts saves. A
 * file's SEQUENCE comes from the time it is made, not from the revision.
 */
interface CalendarIdentity {
  readonly calendarId: string;
  readonly revision: number;
}

const getRandomValues = (array: Uint8Array<ArrayBuffer>) => globalThis.crypto.getRandomValues(array);

export function RenewalTracker({ facts }: { facts: RenewalFactsView }) {
  const today = useDeviceToday();
  const [storage, setStorage] = useState<Storage>({ state: "checking" });
  const [saved, setSaved] = useState<RenewalReminder | null>(null);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<DateChoice | "">("");
  const [ageChoice, setAgeChoice] = useState<AgeAnswerValue | "">("");
  const [dateText, setDateText] = useState("");
  const [kindError, setKindError] = useState<string | undefined>(undefined);
  const [dateError, setDateError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [draftCalendarId, setDraftCalendarId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const ageRange = ageQuestionRange(facts.schedules);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Opening has its own deadline (device-kv.ts); reading gets one here,
      // so a browser that never settles a request cannot leave the page on
      // its loading line (review fix).
      const deps = await openDeviceReminderStore();
      if (cancelled) {
        return;
      }
      if (deps === null) {
        setStorage({ state: "unavailable" });
        return;
      }
      const result = await withDeadline(
        loadReminder(deps, [facts.entryId]),
        DEVICE_STORAGE_TIMEOUT_MS,
        "reading the saved reminder",
      );
      if (cancelled) {
        return;
      }
      setStorage({ state: "ready", deps });
      if (result.status === "ok") {
        setSaved(result.reminder);
      } else if (result.status === "discarded") {
        setNotice(DISCARDED_NOTICE);
      } else if (result.status === "unsupported") {
        setNotice(UNSUPPORTED_NOTICE);
      }
    }
    void load().catch(() => {
      if (!cancelled) {
        setStorage({ state: "unavailable" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [facts.entryId]);

  function focusHeading() {
    headingRef.current?.focus();
  }

  function validate(): DateFormCheck {
    const check = checkDateForm(choice, dateText, today ?? deviceToday());
    setKindError(!check.ok && check.field === "kind" ? check.error : undefined);
    setDateError(!check.ok && check.field === "date" ? check.error : undefined);
    return check;
  }

  function formAgeAnswer(kind: ReportedDateKind): AgeAnswer | undefined {
    return kind === "approval" && ageRange !== null && ageChoice !== ""
      ? { min: ageRange.min, max: ageRange.max, answer: ageChoice }
      : undefined;
  }

  /**
   * The identity the form's date gets: a saved reminder keeps its calendar
   * id and goes up one revision; a new one gets a fresh id, kept for this
   * visit so a file downloaded before saving matches the saved reminder.
   */
  function formIdentity(): CalendarIdentity {
    if (saved !== null) {
      return {
        calendarId: saved.calendarId,
        revision: Math.min(saved.revision + 1, MAX_REMINDER_REVISION),
      };
    }
    const calendarId = draftCalendarId ?? newCalendarId(getRandomValues);
    if (draftCalendarId === null) {
      setDraftCalendarId(calendarId);
    }
    return { calendarId, revision: 0 };
  }

  async function handleSave() {
    const check = validate();
    if (!check.ok || busy) {
      return;
    }
    if (storage.state !== "ready") {
      setNotice(STORAGE_UNAVAILABLE_NOTE);
      return;
    }
    const identity = formIdentity();
    const ageAnswer = formAgeAnswer(check.kind);
    const reminder: RenewalReminder = {
      version: RENEWAL_REMINDER_VERSION,
      entryId: facts.entryId,
      kind: check.kind,
      reportedDate: check.reportedDate,
      calendarId: identity.calendarId,
      revision: identity.revision,
      ...(ageAnswer !== undefined ? { ageAnswer } : {}),
    };
    setBusy(true);
    try {
      const outcome = await saveReminder(reminder, storage.deps);
      if (outcome.status === "changed") {
        // Third review fix: another tab removed or changed the reminder
        // while this save ran, so nothing was written. The form keeps this
        // date, and saving again writes it.
        setNotice(SAVE_CHANGED_NOTICE);
        return;
      }
      setSaved(reminder);
      setEditing(false);
      setNotice(savedNotice(reminder.kind));
      focusHeading();
      // Ask the browser to keep the reminder (review fix); the notice above
      // still points to the calendar file, which no browser clears.
      void requestPersistentStorage();
    } catch {
      setNotice(SAVE_FAILED_NOTICE);
    } finally {
      setBusy(false);
    }
  }

  function handleDownload(
    reminder: Pick<RenewalReminder, "kind" | "reportedDate" | "ageAnswer">,
    calendarId: string,
  ) {
    const outcome = offerFile(
      () => {
        const now = new Date();
        const moment = deviceLocalMoment(now);
        return buildReminderCalendar({
          facts,
          kind: reminder.kind,
          reportedDate: reminder.reportedDate,
          ...(reminder.ageAnswer !== undefined ? { ageAnswer: reminder.ageAnswer } : {}),
          calendarId,
          now,
          today: moment.date,
          minutesIntoToday: moment.minutes,
        });
      },
      downloadTextFile,
      CALENDAR_FILE_TYPE,
    );
    setNotice(
      outcome === "downloaded" ? DOWNLOADED_NOTICE : outcome === "nothing" ? NO_ESTIMATE_NOTE : DOWNLOAD_FAILED_NOTICE,
    );
  }

  function handleDownloadFromForm() {
    const check = validate();
    if (check.ok) {
      const ageAnswer = formAgeAnswer(check.kind);
      handleDownload(
        { kind: check.kind, reportedDate: check.reportedDate, ...(ageAnswer !== undefined ? { ageAnswer } : {}) },
        formIdentity().calendarId,
      );
    }
  }

  async function handleRemove() {
    if (storage.state !== "ready" || busy) {
      return;
    }
    setBusy(true);
    try {
      await clearReminder(storage.deps);
      setSaved(null);
      setEditing(false);
      setChoice("");
      setAgeChoice("");
      setDateText("");
      // Removed means removed: a later save starts a new set of events.
      setDraftCalendarId(null);
      setNotice(REMOVED_NOTICE);
      focusHeading();
    } catch {
      // Second review fix: a delete that fails (storage closed after the
      // person cleared this site's data with the tab open, for example)
      // left the old notice on screen and an unhandled rejection. The
      // reminder stays shown, because it may still be on the device.
      setNotice(REMOVE_FAILED_NOTICE);
    } finally {
      setBusy(false);
    }
  }

  function handleChange() {
    if (saved) {
      setChoice(saved.kind);
      setAgeChoice(saved.ageAnswer?.answer ?? "");
      setDateText(saved.reportedDate);
    }
    setEditing(true);
    // Clearing the region lets the next save's notice be announced again,
    // even when its words are the same (the StatusRegion convention).
    setNotice("");
    focusHeading();
  }

  const showSummary = saved !== null && !editing && today !== null;
  const ageLabels = ageRange !== null ? ageChoiceLabels(ageRange) : null;

  return (
    <section
      aria-labelledby="renewal-date-heading"
      data-renewal-tracker
      className="flex flex-col gap-4 rounded-md border border-zinc-300 p-5 dark:border-zinc-600"
    >
      <h2
        id="renewal-date-heading"
        ref={headingRef}
        tabIndex={-1}
        className="text-xl font-semibold"
      >
        {SECTION_HEADING}
      </h2>
      <StatusRegion message={notice} className="text-sm text-zinc-700 dark:text-zinc-300" />
      {storage.state === "checking" ? (
        <>
          <p data-renewal-loading className="text-zinc-600 dark:text-zinc-400">
            {LOADING_NOTE}
          </p>
          <noscript>
            <p data-renewal-noscript className="text-zinc-700 dark:text-zinc-300">
              {NOSCRIPT_NOTE}
            </p>
          </noscript>
          {/* Without JavaScript the check never runs, so its line would say
              "checking" forever next to the note above (second review fix).
              A browser only applies this style when scripting is off. */}
          <noscript>
            <style>{HIDE_LOADING_WITHOUT_SCRIPT_CSS}</style>
          </noscript>
        </>
      ) : null}
      {storage.state === "unavailable" ? (
        <p className="text-zinc-700 dark:text-zinc-300">{STORAGE_UNAVAILABLE_NOTE}</p>
      ) : null}
      {showSummary && saved && today ? (
        <div className="flex flex-col gap-4">
          <ReportedDateView facts={facts} reminder={saved} today={today} />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => handleDownload(saved, saved.calendarId)}
              className="rounded-md bg-zinc-900 px-4 py-2 text-base font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
            >
              {DOWNLOAD_BUTTON}
            </button>
            <button
              type="button"
              onClick={handleChange}
              className="rounded-md border border-zinc-400 px-4 py-2 text-base font-medium hover:bg-zinc-100 dark:border-zinc-500 dark:hover:bg-zinc-800"
            >
              {CHANGE_BUTTON}
            </button>
            <button
              type="button"
              onClick={() => void handleRemove()}
              disabled={busy}
              className="rounded-md border border-zinc-400 px-4 py-2 text-base font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-500 dark:hover:bg-zinc-800"
            >
              {REMOVE_BUTTON}
            </button>
          </div>
        </div>
      ) : null}
      {storage.state !== "checking" && !showSummary ? (
        <form
          noValidate
          data-renewal-form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <p className="text-zinc-700 dark:text-zinc-300">{NO_DATE_INTRO}</p>
          <fieldset
            className="flex flex-col gap-2"
            aria-describedby={kindError ? "renewal-kind-help renewal-kind-error" : "renewal-kind-help"}
          >
            <legend className="mb-1 text-base font-medium">{DATE_CHOICE_LEGEND}</legend>
            <p id="renewal-kind-help" className="text-sm text-zinc-600 dark:text-zinc-400">
              {DATE_CHOICE_HELP}
            </p>
            {DATE_CHOICES.map((value) => (
              <label
                key={value}
                htmlFor={`renewal-kind-${value}`}
                className="flex items-center gap-2 text-base"
              >
                <input
                  id={`renewal-kind-${value}`}
                  type="radio"
                  name="renewal-date-kind"
                  value={value}
                  checked={choice === value}
                  onChange={() => {
                    setChoice(value);
                    setKindError(undefined);
                  }}
                  className="h-4 w-4"
                />
                {DATE_CHOICE_LABELS[value]}
              </label>
            ))}
            {kindError ? (
              <p
                id="renewal-kind-error"
                role="alert"
                className="text-sm font-medium text-red-700 dark:text-red-400"
              >
                {kindError}
              </p>
            ) : null}
          </fieldset>
          {choice === "unknown" ? (
            <p data-renewal-unknown className="text-zinc-700 dark:text-zinc-300">
              {UNKNOWN_DATE_NOTE}
            </p>
          ) : (
            <>
              <Field
                id="renewal-date"
                label={DATE_FIELD_LABEL}
                help={DATE_FIELD_HELP}
                error={dateError}
              >
                {(control) => (
                  <input
                    {...control}
                    type="date"
                    min={REPORTED_DATE_MIN}
                    max={REPORTED_DATE_MAX}
                    autoComplete="off"
                    value={dateText}
                    onChange={(event) => {
                      setDateText(event.target.value);
                      setDateError(undefined);
                    }}
                    className="self-start rounded-md border border-zinc-400 p-2.5 text-base dark:border-zinc-500 dark:bg-zinc-800"
                  />
                )}
              </Field>
              {choice === "approval" && ageLabels !== null ? (
                <fieldset
                  data-renewal-age-question
                  className="flex flex-col gap-2"
                  aria-describedby="renewal-age-help"
                >
                  <legend className="mb-1 text-base font-medium">{ageQuestionLegend()}</legend>
                  <p id="renewal-age-help" className="text-sm text-zinc-600 dark:text-zinc-400">
                    {AGE_QUESTION_HELP}
                  </p>
                  {AGE_ANSWERS.map((value) => (
                    <label
                      key={value}
                      htmlFor={`renewal-age-${value}`}
                      className="flex items-center gap-2 text-base"
                    >
                      <input
                        id={`renewal-age-${value}`}
                        type="radio"
                        name="renewal-age-range"
                        value={value}
                        checked={ageChoice === value}
                        onChange={() => setAgeChoice(value)}
                        className="h-4 w-4"
                      />
                      {ageLabels[value]}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <div className="flex flex-wrap gap-3">
                {storage.state === "ready" ? (
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-md bg-zinc-900 px-4 py-2 text-base font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    {SAVE_BUTTON}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={handleDownloadFromForm}
                  className="rounded-md border border-zinc-400 px-4 py-2 text-base font-medium hover:bg-zinc-100 dark:border-zinc-500 dark:hover:bg-zinc-800"
                >
                  {DOWNLOAD_BUTTON}
                </button>
              </div>
            </>
          )}
        </form>
      ) : null}
      {storage.state === "ready" ? (
        <p data-renewal-can-clear className="text-sm text-zinc-600 dark:text-zinc-400">
          {BROWSER_CAN_CLEAR_NOTE}
        </p>
      ) : null}
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{PRIVACY_NOTE}</p>
    </section>
  );
}
