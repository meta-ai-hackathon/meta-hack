"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnswerStatusBadge } from "../../components/answer-status-badge";
import { StatusRegion } from "../../components/status-region";
import {
  MAX_FORM_ANSWER_LENGTH,
  type FillConflict,
  type ToResolveItem,
} from "../../lib/forms/fill-core";
import {
  pagePointer,
  type DispositionReport,
  type DispositionReportField,
} from "../../lib/forms/disposition";
import type { FormFlowFieldView } from "../../lib/forms/flow";
import type { FormFieldDisposition } from "../../lib/forms/registry-core";
import type { AnswerProvenance } from "../../lib/honesty";
import type { ClientAnswerState } from "../../lib/intake/client-store";
import {
  DEVICE_FORM_ENTRY,
  deviceFormCoverage,
  deviceFormReview,
  deviceHandoffLinks,
  deviceMatch,
  reviewAnswersForForm,
} from "../../lib/intake/device-form";
import { saveFilledFormToDevice } from "../../lib/intake/device-download";
import type { PrintPreview } from "../../lib/intake/device-print";
import { loadDeviceTemplate } from "../../lib/intake/device-template";
import type { MatchCard, MatchSourceCitation } from "../../lib/match-core";

// What the step-by-step page shows once the questions are done (HACK-115):
// the benefit match, the review of the application form, and the filled
// form, ready to print or to download a copy of. All of it is computed in
// this browser from the answers on this device (lib/intake/device-form.ts).
// The match explains each program with the program's own sourced facts
// only.
//
// Showing the filled form fetches the blank public form, loads the PDF fill
// (lib/intake/device-fill.ts) and the print preview
// (lib/intake/device-print.ts), both kept out of the page's first load,
// fills the form here, and draws its pages on this page so the person can
// check them and print them to sign and send in. No answer is sent
// anywhere. The person signs and sends in the form themselves, so they can
// also download a copy to print, sign, send in, and keep: the owner decided
// on HACK-115 that the download is vital, and .github/claude-review/rules.md
// sets its conditions. Only a press of Download a copy saves one, made from
// the same filled bytes the pages were drawn from, through
// lib/intake/device-download.ts, the one module on the device path allowed
// to hand the browser a file. The note beside the button says the file
// holds the filled-in answers, private ones included, that it isn't
// encrypted, and to delete it on a shared computer. Nothing else is saved to
// the device: nothing goes in the browser's storage, and no copy is kept
// anywhere else. Where the form fills but this browser can't draw its pages
// (pdf.js didn't load, a canvas was refused, or the drawing never
// finished), the page offers Download a copy alone, with the same note, so
// the person can still get the form; with no pages there is nothing to
// print.
//
// The pages and those bytes last only while they match the answers: a
// change to any answer, typed ones included, drops them, and so does
// leaving the page, whether for another screen of the app or another site
// (pagehide, so a page the browser keeps for Back comes back without them),
// and so does a delete, which takes this screen away. A drop releases the
// canvases and wipes the bytes. Answers typed here for the form's other
// fields live only in this page's memory, held by the wizard so going back
// to a question doesn't lose them. With the pages, the page lists what the
// form left blank and any question the person checked more than one box
// for, which the fill prints as given and flags.
//
// While the pages are on screen they mark <html>, and every element that
// holds them, for the print rules in globals.css, so a print holds only the
// pages in every browser, whether or not it supports :has().
//
// The show button keeps focus while the form is prepared (it is marked
// busy rather than disabled), the status line says what is happening, and
// focus moves to the pages' heading once they are drawn. Some in-app
// browsers ignore window.print(), so a print press the browser never acts
// on says how to print instead.
//
// Private answers never appear on this screen as text: the review shows
// their status and provenance, and the match never carries them. The
// filled pages show them only as the drawn form the person prints or
// downloads, and a page's screen reader label names the page, never what is
// on it.

/**
 * What a saved copy of the filled form is, said wherever the page offers one
 * (rules.md, Real data rules): beside Download a copy, and beside Print,
 * whose window can save the form as a PDF, the same kind of file.
 */
const FILE_DISCLOSURE =
  "The file holds the answers filled in on the form, private ones " +
  "included. It's an ordinary file that isn't encrypted, so on a shared " +
  "computer, delete it once you've printed or sent it.";

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
    "Used only for the filled form you print or download. This page keeps " +
    "it only while it's open, and deleting your answers clears it from " +
    "this page.",
  answerAbove: "Answer this question",
  stillNeededHeading: "Still needed on the form",
  stillNeededBody: "These are left blank on the prepared form. Nothing is guessed.",
  showFormButton: "Show the filled form",
  showingForm: "Filling in your form…",
  // Only the filled form: the answers themselves may be saved in this
  // browser, as the save for later section says.
  showFormNote:
    "This fills in the official form with your answers here in this " +
    "browser and shows it below, so you can print it or download a copy. " +
    "None of your answers are sent anywhere, and the filled form is saved " +
    "to this device only if you download a copy or save it as a PDF when " +
    "printing.",
  ready:
    "Your filled form is ready below. It was filled in this browser, and " +
    "none of your answers were sent anywhere.",
  templateUnavailable:
    "We couldn't get the blank form right now, so nothing was filled. " +
    "Check your connection and try again.",
  unreadableForm: "We couldn't open the blank form, so nothing was filled. Try again in a moment.",
  invalidTyped:
    "One of the answers you typed for the form couldn't be used. Please " +
    "check it and try again.",
  failed: "Something went wrong preparing your form. Please try again.",
  // The form filled, but this browser couldn't draw its pages (pdf.js
  // didn't load, a canvas was refused, or the drawing never finished). The
  // download needs only the filled form, so it is still offered.
  drawFailed:
    "We filled in your form, but this browser couldn't show its pages " +
    "here. You can still download a copy below, or try again.",
  downloadOnlyHeading: "Your filled form, ready to download",
  downloadOnlyBody:
    "This browser couldn't show the pages of your filled form here, so " +
    "there's nothing to print from this page. You can download a copy to " +
    "check, print, sign, and send in yourself, or show the filled form " +
    "again to try once more. This goes away when you change an answer or " +
    "leave.",
  unreadableBoxes:
    "Nothing was filled. Some box answers aren't checked or unchecked, so " +
    "fix the ones listed and try again.",
  unreadableBoxesHeading: "Box answers to fix first",
  unreadableBoxesBody:
    "Each of these is a box on the form, so its answer is the word checked " +
    "or unchecked. Fix it or leave it empty, then show the filled form again.",
  previewHeading: "Your filled form, ready to print or download",
  previewBody:
    "These are the pages of your application with your answers filled in, " +
    "private ones included. Check them, then print them or download a " +
    "copy, sign the form, and send it in yourself. The pages stay only on " +
    "this page, and they go away when you change an answer or leave.",
  printButton: "Print the form",
  printNote:
    "When the print window opens, choose a printer. Saving the form as a " +
    `PDF there instead saves a file to this device. ${FILE_DISCLOSURE}`,
  // A browser that ignores Print may not save files from a page either, so
  // the way that works in any case comes first.
  printUnavailable:
    "This browser didn't open a print window. To print your form, open " +
    "this page in a browser such as Safari or Chrome. Answers saved in " +
    "this browser don't move to another one, so you'll answer the " +
    "questions again there. Or try Download a copy, and print the file " +
    "from another app.",
  fileDisclosure: FILE_DISCLOSURE,
  downloadButton: "Download a copy",
  downloadNote:
    "A copy saves to this device as a PDF file, to keep, print, or send in. " +
    `${FILE_DISCLOSURE} The copy is made here in this browser, and none of ` +
    "your answers are sent anywhere.",
  // The page hands the browser the file but can't see what the browser
  // does with it (some in-app browsers drop it), so this says what should
  // happen and what to do if it doesn't.
  downloaded:
    "Your browser should now save the copy, or ask you where to save it. " +
    "It was made in this browser, and none of your answers were sent " +
    "anywhere. If no file appears, open this page in a browser such as " +
    "Safari or Chrome, where you'll answer the questions again.",
  downloadNotStarted:
    "The download didn't start, so no copy was saved. Press Download a copy " +
    "to try again.",
  leftBlankHeading: "Left blank on the form below",
  leftBlankHeadingNoPages: "Left blank on the form",
  coverageHeading: "Every field, accounted for",
  coverageDetails: "Why each blank field stays blank",
  coverageAllMapped: "Every box on this form takes an answer, so nothing was skipped.",
  conflictsHeading: "Check these on the form below",
  conflictsHeadingNoPages: "Check these on the form",
  conflictsBody:
    "You checked more than one box where the form takes one answer. The " +
    "form shows every box you checked, so fix these by hand on the printed " +
    "form before you sign it.",
  handoffHeading: "Submit it yourself",
  handoffBody:
    "You sign the form and submit it yourself. The official links below " +
    "show how and where to apply. The app never signs or submits anything " +
    "for you.",
  handoffBodyNoLinks:
    "You sign the form and submit it yourself. The app never signs or " +
    "submits anything for you.",
} as const;

const REQUIREMENT_KIND_LABELS: Readonly<Record<MatchCard["requirements"][number]["kind"], string>> = {
  document: "Document you may need",
  step: "Step",
  deadline: "Deadline",
  renewal: "Renewal",
};

// Every provenance an answer can carry has its label, so a badge is never
// empty: the tax return confirm flow's two (VAL-INC-007) read as they do on
// the conversation page.
const PROVENANCE_COPY: Readonly<Record<AnswerProvenance, string>> = {
  user_supplied: "You told us",
  ai_drafted: "Drafted for you",
  source_verified: "From a source you verified",
  tax_return: "From your tax return",
  user: "You corrected this",
};

const STATE_COPY: Readonly<Record<FormFlowFieldView["state"], string>> = {
  prefilled: "We already know this from what you told us",
  asked: "Still needed",
  not_applicable: "Not needed for you",
};

// Why a field the pipeline never fills stays blank (VAL-FIX-007), in this
// page's words. The registry's own reason for each one stays in the data.
const DISPOSITION_COPY: Readonly<Record<Exclude<FormFieldDisposition, "mapped">, string>> = {
  not_collected_by_interview: "These questions don't ask this",
  optional_unanswered: "Optional, so it stays blank",
  agency_use_only: "For the agency to fill in",
  duplicate_structural: "A printed line, not an answer box",
};

/** A coverage row for a field the pipeline leaves blank. */
type BlankCoverageField = DispositionReportField & {
  readonly disposition: Exclude<FormFieldDisposition, "mapped">;
};

function isBlankCoverageField(field: DispositionReportField): field is BlankCoverageField {
  return field.disposition !== "mapped";
}

/** How the form's fields split up, from the coverage report's counts. */
function coverageSummary(counts: DispositionReport["counts"]): string {
  return (
    `The application has ${counts.total} boxes and lines to fill in. ` +
    `${counts.mapped} of them take your answers. The rest stay blank on the ` +
    `form you print: ${counts.not_collected_by_interview} that these ` +
    "questions don't ask, so fill those in by hand if they apply to you, " +
    `${counts.optional_unanswered} that are optional, ${counts.agency_use_only} ` +
    `for the agency to fill in, and ${counts.duplicate_structural} printed ` +
    "lines that aren't answer boxes."
  );
}

// The fill never picks a side of a contradiction (VAL-FIX-007): it prints
// every box the person checked and flags the group, and this says which.
const CONFLICT_COPY: Readonly<Record<FillConflict["kind"], string>> = {
  yes_no: "Both Yes and No are checked.",
  single_choice: "More than one box is checked where the form takes one.",
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

/**
 * How long after a print press the browser has to start printing before
 * the page says it didn't. Every browser that prints fires beforeprint as
 * it starts, well inside this.
 */
export const PRINT_CHECK_MS = 2_000;

/** A canvas for one page of the filled form. It lives only on this page. */
function createPrintCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** The name a downloaded copy of the filled form saves under. */
const DOWNLOAD_FILE_NAME = `${DEVICE_FORM_ENTRY.id}.pdf`;

/** The filled form on screen, with what its fill left blank or flagged. */
interface FilledForm {
  /**
   * Its pages, drawn to check and print, or null when the form filled but
   * this browser couldn't draw them: then the page offers the download
   * alone, so the person can still get the form.
   */
  readonly drawn: PrintPreview | null;
  /**
   * The filled PDF the pages were drawn from, for a copy the person
   * downloads. It lives only in this page's memory and is wiped with the
   * pages.
   */
  readonly bytes: Uint8Array;
  readonly leftBlank: readonly ToResolveItem[];
  readonly conflicts: readonly FillConflict[];
  /** The answers it was filled from, typed ones included. */
  readonly answers: ClientAnswerState;
  readonly typed: Readonly<Record<string, string>>;
}

/**
 * Let go of a filled form: release its canvases and wipe its bytes, so
 * nothing of it outlasts its pages. Safe to call more than once.
 */
function releaseFilled(form: FilledForm): void {
  form.drawn?.release();
  form.bytes.fill(0);
}

/** On <html> while the filled pages are on screen, for the print rules in globals.css. */
const PRINT_ROOT_ATTRIBUTE = "data-print-filled-form";

/** On each element that holds the filled pages while they're on screen, for the same rules. */
const PRINT_PATH_ATTRIBUTE = "data-print-path";

/**
 * Mark the page for printing the filled pages alone (the ref of their
 * container): <html>, and every element from the body down that holds the
 * pages. The print rules key off these marks, not :has(), which older
 * browsers such as Firefox before 121 don't support. Without the marks,
 * those browsers would print the whole screen, the review's typed answers
 * included. The marks go when the pages do.
 */
function markForPrint(pages: HTMLElement | null): (() => void) | undefined {
  if (pages === null) {
    return undefined;
  }
  const root = pages.ownerDocument.documentElement;
  const holders: Element[] = [];
  for (let holder = pages.parentElement; holder !== null && holder !== root; holder = holder.parentElement) {
    holder.setAttribute(PRINT_PATH_ATTRIBUTE, "");
    holders.push(holder);
  }
  root.setAttribute(PRINT_ROOT_ATTRIBUTE, "");
  return () => {
    root.removeAttribute(PRINT_ROOT_ATTRIBUTE);
    for (const holder of holders) {
      holder.removeAttribute(PRINT_PATH_ATTRIBUTE);
    }
  };
}

/**
 * The answers typed into the review for the fields no question asks, by
 * field name. Whatever shows this screen holds them, in the page's memory
 * only, so a trip from the review to a question and back keeps them. They
 * are never stored.
 */
export interface TypedReviewAnswers {
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (fieldName: string, value: string) => void;
}

export function DeviceResults(props: {
  /** Every answer on this device, private values included. Never rendered or sent. */
  readonly answers: ClientAnswerState;
  /** What the person typed into the review so far, and how to change it. */
  readonly typedAnswers: TypedReviewAnswers;
  /** Go back to a question, to answer what the form still needs. */
  readonly onAnswer?: (questionId: string) => void;
}) {
  const { answers, onAnswer } = props;
  const typed = props.typedAnswers.values;
  const match = useMemo(() => deviceMatch(answers), [answers]);
  const review = useMemo(() => deviceFormReview(answers), [answers]);
  const handoffLinks = useMemo(() => deviceHandoffLinks(), []);
  const coverage = useMemo(() => deviceFormCoverage(), []);
  const blankFields = useMemo(() => coverage.fields.filter(isBlankCoverageField), [coverage]);
  const [busy, setBusy] = useState(false);
  // The typed answers as the fill takes them. A box or yes/no answer that
  // isn't checked or unchecked would print as an unchecked box with no word
  // to the person, so those hold the filled form back and are listed, from
  // the first try on.
  const forForm = useMemo(() => reviewAnswersForForm(typed), [typed]);
  const [triedForm, setTriedForm] = useState(false);
  const unreadableBoxes = useMemo(
    () => new Set(triedForm ? forForm.unreadable : []),
    [triedForm, forForm],
  );
  const questionByField = useMemo(
    () => new Map(review.fields.map((field) => [field.fieldName, field.question])),
    [review],
  );
  const [filled, setFilled] = useState<FilledForm | null>(null);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The pages on screen, for leaving the page to reach without a render. */
  const onScreen = useRef<FilledForm | null>(null);
  /**
   * Pages handed to the screen that aren't on it yet. React puts them
   * there on a later render, and an answer change or leaving the page can
   * drop them before that, so until they are on screen this is how they
   * are let go of.
   */
  const pending = useRef<FilledForm | null>(null);
  /** How many times the page has been left, so a drawing started before that is never shown. */
  const leaves = useRef(0);
  const previewHeading = useRef<HTMLHeadingElement | null>(null);
  /** Set when the person's press brings the pages up, so focus follows them. */
  const focusPreview = useRef(false);

  // The pages show the form their answers fill, so a change to any answer,
  // typed ones included, drops them in the same render: they never show
  // next to answers they don't match. The effect below releases them.
  if (filled !== null && (filled.answers !== answers || filled.typed !== typed)) {
    setFilled(null);
  }

  // Pages that leave the screen are released at once, and the bytes kept
  // for a download wiped with them: replaced, dropped for a change, or gone
  // with this screen. Pages the person just asked for take focus to their
  // heading, so a screen reader lands on them.
  useEffect(() => {
    onScreen.current = filled;
    if (filled === null) {
      return;
    }
    if (pending.current === filled) {
      // On screen now, so this effect lets go of them from here on.
      pending.current = null;
    }
    if (focusPreview.current) {
      focusPreview.current = false;
      previewHeading.current?.focus();
    }
    return () => releaseFilled(filled);
  }, [filled]);

  // Leaving drops the pages too, so a screen the app brings back (React
  // keeps a page it navigates away from) never shows released ones, and
  // pages still on their way to the screen are let go of with it.
  useEffect(
    () => () => {
      setFilled(null);
      if (pending.current !== null) {
        releaseFilled(pending.current);
        pending.current = null;
      }
      if (noticeTimer.current) {
        clearTimeout(noticeTimer.current);
      }
    },
    [],
  );

  // So does leaving for another site or closing the tab. The browser may
  // keep the page to show again on Back, so the canvases are released and
  // the bytes wiped at once, before it is put away, rather than on the next
  // render, both for the pages on screen and for any on their way there.
  useEffect(() => {
    const leave = () => {
      leaves.current += 1;
      for (const form of [onScreen.current, pending.current]) {
        if (form !== null) {
          releaseFilled(form);
        }
      }
      onScreen.current = null;
      pending.current = null;
      setFilled(null);
    };
    window.addEventListener("pagehide", leave);
    return () => window.removeEventListener("pagehide", leave);
  }, []);

  // Filling stops when the answers it started from change or this screen
  // goes away: pages drawn from older answers would be stale. Pages drawn
  // in time but not yet on screen when the answers changed never get there
  // (the check above drops them as they render), so they are let go of
  // here, once the change is on screen.
  const answersSignal = useRef<AbortSignal | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    answersSignal.current = controller.signal;
    const waiting = pending.current;
    if (waiting !== null && (waiting.answers !== answers || waiting.typed !== typed)) {
      pending.current = null;
      releaseFilled(waiting);
    }
    return () => controller.abort();
  }, [answers, typed]);

  // The status region announces a change, so clear it and set the message
  // on the next tick: a repeated outcome is announced again.
  const announce = useCallback((message: string) => {
    setNotice("");
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = setTimeout(() => setNotice(message), 30);
  }, []);

  // Word that the form is being filled in, is ready below, or that a copy
  // of it is downloading or didn't download, lasts only while that is
  // true: the pages can go without a new announcement (an answer changed,
  // or the page was left), and so can the work on them. A line that says
  // to press Download a copy again never outlasts the button.
  const aboutTheForm =
    notice === DEVICE_RESULTS_COPY.ready ||
    notice === DEVICE_RESULTS_COPY.drawFailed ||
    notice === DEVICE_RESULTS_COPY.downloaded ||
    notice === DEVICE_RESULTS_COPY.downloadNotStarted;
  const status =
    (aboutTheForm && filled === null) || (notice === DEVICE_RESULTS_COPY.showingForm && !busy) ? "" : notice;

  // A browser that prints fires beforeprint as it starts. One that ignores
  // window.print() (some in-app browsers do) never does, and a print press
  // there says how to print instead of doing nothing. A print that starts
  // late takes that back.
  const printStarted = useRef(false);
  const printCheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const started = () => {
      printStarted.current = true;
      setNotice((current) => (current === DEVICE_RESULTS_COPY.printUnavailable ? "" : current));
    };
    window.addEventListener("beforeprint", started);
    window.addEventListener("afterprint", started);
    return () => {
      window.removeEventListener("beforeprint", started);
      window.removeEventListener("afterprint", started);
      if (printCheck.current) {
        clearTimeout(printCheck.current);
      }
    };
  }, []);

  function printForm(): void {
    printStarted.current = false;
    if (printCheck.current) {
      clearTimeout(printCheck.current);
    }
    window.print();
    printCheck.current = setTimeout(() => {
      if (!printStarted.current) {
        announce(DEVICE_RESULTS_COPY.printUnavailable);
      }
    }, PRINT_CHECK_MS);
  }

  // The person's own press of Download a copy, and nothing else, saves a
  // copy: the same filled form the pages show, handed to the browser as a
  // file by the one module allowed to (device-download.ts). It is called
  // right here, in the press, never after a wait or from anywhere else.
  function downloadCopy(): void {
    // Pages let go of on leaving, which a page brought back from the
    // browser's cache may still show for a moment, have nothing to save.
    if (filled === null || onScreen.current !== filled) {
      return;
    }
    // A browser that won't make the file (a locked-down frame can refuse
    // object URLs) saved nothing, and the page says so.
    let saved = false;
    try {
      saved = saveFilledFormToDevice(filled.bytes, DOWNLOAD_FILE_NAME);
    } catch {
      saved = false;
    }
    announce(saved ? DEVICE_RESULTS_COPY.downloaded : DEVICE_RESULTS_COPY.downloadNotStarted);
  }

  async function showFilledForm(): Promise<void> {
    if (busy) {
      return;
    }
    setTriedForm(true);
    if (forForm.unreadable.length > 0) {
      announce(DEVICE_RESULTS_COPY.unreadableBoxes);
      return;
    }
    const signal = answersSignal.current ?? new AbortController().signal;
    const leavesBefore = leaves.current;
    // Pages already on screen go first: the form is drawn again from scratch.
    setFilled(null);
    setBusy(true);
    announce(DEVICE_RESULTS_COPY.showingForm);
    // The filled bytes, until the pages drawn from them are on screen. Any
    // way out before that wipes them.
    let bytes: Uint8Array | null = null;
    let shown = false;
    try {
      const [template, { fillFormOnDevice }, { renderPrintPreview }] = await Promise.all([
        loadDeviceTemplate(DEVICE_FORM_ENTRY),
        import("../../lib/intake/device-fill"),
        import("../../lib/intake/device-print"),
      ]);
      if (template === null) {
        announce(DEVICE_RESULTS_COPY.templateUnavailable);
        return;
      }
      const result = await fillFormOnDevice(template, answers, forForm.values);
      if (result.kind === "invalid_answers") {
        announce(DEVICE_RESULTS_COPY.invalidTyped);
        return;
      }
      if (result.kind === "unreadable_form") {
        announce(DEVICE_RESULTS_COPY.unreadableForm);
        return;
      }
      bytes = result.outcome.bytes;
      // A drawing that fails, a pdf.js that wouldn't load or stopped
      // answering included, still leaves the filled form, so the person
      // can download it even where the pages can't be shown. A drawing
      // stopped because the answers changed is no failure, and goes below.
      const drawn = await renderPrintPreview(bytes, createPrintCanvas, signal).catch((error: unknown) => {
        if (signal.aborted) {
          throw error;
        }
        return null;
      });
      // Pages drawn from answers that have since changed, or for a page the
      // person has left, are never shown.
      if (signal.aborted || leaves.current !== leavesBefore) {
        drawn?.release();
        return;
      }
      focusPreview.current = true;
      const form: FilledForm = {
        drawn,
        bytes,
        leftBlank: result.outcome.toResolve,
        conflicts: result.outcome.conflicts,
        answers,
        typed,
      };
      // From here on, whatever drops the form lets go of it, whether it
      // reached the screen or not.
      pending.current = form;
      setFilled(form);
      shown = true;
      announce(drawn === null ? DEVICE_RESULTS_COPY.drawFailed : DEVICE_RESULTS_COPY.ready);
    } catch {
      // An answer changed or the screen went away while the form was being
      // drawn: nothing failed, and the person sees the change they made.
      // Anything else before the form filled failed.
      if (!signal.aborted) {
        announce(DEVICE_RESULTS_COPY.failed);
      }
    } finally {
      if (!shown) {
        bytes?.fill(0);
      }
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
            const typedNoteId = `${typedId}-note`;
            const questionId = `device-form-question-${index}`;
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
                  <span id={questionId} className="font-medium">
                    {field.question}
                  </span>
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
                    {/* No spellcheck: a browser's cloud spellcheck sends what is typed off the device. */}
                    <input
                      id={typedId}
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby={typedNoteId}
                      aria-invalid={unreadableBoxes.has(field.fieldName) ? true : undefined}
                      maxLength={MAX_FORM_ANSWER_LENGTH}
                      value={typed[field.fieldName] ?? ""}
                      onChange={(event) => props.typedAnswers.onChange(field.fieldName, event.target.value)}
                      className="rounded-lg border border-surface-border bg-surface px-2 py-1"
                    />
                    <span id={typedNoteId} data-typed-note={field.fieldName} className="text-xs text-muted">
                      {DEVICE_RESULTS_COPY.typedNote}
                    </span>
                  </span>
                ) : null}
                {field.state === "asked" && field.specQuestionId !== null && onAnswer ? (
                  <button
                    type="button"
                    aria-describedby={questionId}
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
        <div data-field-coverage className="flex flex-col gap-2">
          <h3 className="font-display text-xl font-bold">{DEVICE_RESULTS_COPY.coverageHeading}</h3>
          <p data-coverage-counts className="text-sm text-muted">
            {coverageSummary(coverage.counts)}
          </p>
          {blankFields.length > 0 ? (
            <details className="rounded-xl border border-surface-border bg-surface p-4 text-sm">
              <summary className="cursor-pointer font-medium">
                {DEVICE_RESULTS_COPY.coverageDetails}
              </summary>
              <ul className="mt-3 flex flex-col gap-2">
                {blankFields.map((field) => (
                  <li
                    key={field.fieldName}
                    data-coverage-field={field.fieldName}
                    className="flex flex-col gap-0.5"
                  >
                    <span className="font-medium">{field.question}</span>
                    <span className="text-muted">
                      {DISPOSITION_COPY[field.disposition]}, {pagePointer(field.pages)}.
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p data-coverage-all-mapped className="text-sm text-muted">
              {DEVICE_RESULTS_COPY.coverageAllMapped}
            </p>
          )}
        </div>
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
          <p className="text-sm text-muted">{DEVICE_RESULTS_COPY.showFormNote}</p>
          {/* Busy, not disabled, while the form is prepared: a disabled
          button would drop the focus it has. A press meanwhile does nothing. */}
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => void showFilledForm()}
            data-action="show-form"
            className="self-start rounded-full bg-teal-deep px-4 py-2 text-sm font-semibold text-teal-contrast hover:bg-teal aria-disabled:opacity-50"
          >
            {busy ? DEVICE_RESULTS_COPY.showingForm : DEVICE_RESULTS_COPY.showFormButton}
          </button>
        </div>
        {unreadableBoxes.size > 0 ? (
          <div data-unreadable-boxes className="flex flex-col gap-1">
            <h3 className="font-medium">{DEVICE_RESULTS_COPY.unreadableBoxesHeading}</h3>
            <p className="text-sm text-muted">{DEVICE_RESULTS_COPY.unreadableBoxesBody}</p>
            <ul className="list-disc pl-5">
              {[...unreadableBoxes].map((name) => (
                <li key={name} data-unreadable-box={name}>
                  {questionByField.get(name) ?? name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <StatusRegion message={status} className="text-sm text-muted" />
      </section>

      {/* The filled form: its pages with Print and Download a copy, or,
      when this browser couldn't draw the pages, Download a copy alone. */}
      {filled !== null ? (
        <section
          aria-labelledby="device-print-heading"
          data-print-preview={filled.drawn !== null ? "" : undefined}
          data-download-only={filled.drawn === null ? "" : undefined}
          className="flex flex-col gap-3"
        >
          <h2
            id="device-print-heading"
            ref={previewHeading}
            tabIndex={-1}
            className="font-display text-2xl font-bold"
          >
            {filled.drawn !== null ? DEVICE_RESULTS_COPY.previewHeading : DEVICE_RESULTS_COPY.downloadOnlyHeading}
          </h2>
          <p className="text-sm text-muted">
            {filled.drawn !== null ? DEVICE_RESULTS_COPY.previewBody : DEVICE_RESULTS_COPY.downloadOnlyBody}
          </p>
          <div className="flex flex-col gap-2">
            {filled.drawn !== null ? (
              <p id="device-print-note" data-print-note className="text-sm text-muted">
                {DEVICE_RESULTS_COPY.printNote}
              </p>
            ) : null}
            <p id="device-download-note" data-download-note className="text-sm text-muted">
              {DEVICE_RESULTS_COPY.downloadNote}
            </p>
            <div className="flex flex-wrap gap-2">
              {filled.drawn !== null ? (
                <button
                  type="button"
                  onClick={printForm}
                  data-action="print"
                  aria-describedby="device-print-note"
                  className="rounded-full bg-teal-deep px-4 py-2 text-sm font-semibold text-teal-contrast hover:bg-teal"
                >
                  {DEVICE_RESULTS_COPY.printButton}
                </button>
              ) : null}
              <button
                type="button"
                onClick={downloadCopy}
                data-action="download-copy"
                aria-describedby="device-download-note"
                className="rounded-full border border-surface-border bg-surface px-4 py-2 text-sm font-semibold hover:bg-teal-soft"
              >
                {DEVICE_RESULTS_COPY.downloadButton}
              </button>
            </div>
          </div>
          {filled.leftBlank.length > 0 ? (
            <div data-left-blank className="flex flex-col gap-1">
              <h3 className="font-medium">
                {filled.drawn !== null ? DEVICE_RESULTS_COPY.leftBlankHeading : DEVICE_RESULTS_COPY.leftBlankHeadingNoPages}
              </h3>
              <ul className="list-disc pl-5">
                {filled.leftBlank.map((item) => (
                  <li key={item.fieldName}>
                    {item.question} {LEFT_BLANK_COPY[item.reason]}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {filled.conflicts.length > 0 ? (
            <div data-check-conflicts className="flex flex-col gap-1">
              <h3 className="font-medium">
                {filled.drawn !== null ? DEVICE_RESULTS_COPY.conflictsHeading : DEVICE_RESULTS_COPY.conflictsHeadingNoPages}
              </h3>
              <p className="text-sm text-muted">{DEVICE_RESULTS_COPY.conflictsBody}</p>
              <ul className="list-disc pl-5">
                {filled.conflicts.map((conflict) => (
                  <li key={conflict.fields.join("\n")} data-check-conflict={conflict.kind}>
                    {conflict.question} {CONFLICT_COPY[conflict.kind]}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {/* The pages, and only they, print (the print rules in
          globals.css, keyed off the marks markForPrint sets while the pages
          are here). Each canvas joins its frame here and leaves with it.
          With no pages there is no Print button and nothing is marked. */}
          {filled.drawn !== null ? (
            <div data-print-pages ref={markForPrint} className="flex flex-col gap-4">
              {filled.drawn.pages.map((page) => (
                <div
                  key={page.pageNumber}
                  role="img"
                  aria-label={page.label}
                  data-print-page={page.pageNumber}
                  ref={(frame) => {
                    frame?.replaceChildren(page.canvas);
                  }}
                  className="overflow-hidden rounded-lg border border-surface-border"
                />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="device-handoff-heading" data-handoff className="flex flex-col gap-2">
        <h2 id="device-handoff-heading" className="font-display text-xl font-bold">
          {DEVICE_RESULTS_COPY.handoffHeading}
        </h2>
        <p className="text-sm text-muted">
          {handoffLinks.length > 0
            ? DEVICE_RESULTS_COPY.handoffBody
            : DEVICE_RESULTS_COPY.handoffBodyNoLinks}
        </p>
        {handoffLinks.length > 0 ? (
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
        ) : null}
      </section>
    </div>
  );
}
