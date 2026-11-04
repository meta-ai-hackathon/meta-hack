"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnswerStatusBadge } from "../../../components/answer-status-badge";
import { StatusRegion } from "../../../components/status-region";
import { pagePointer } from "../../../lib/forms/disposition";
import { loadDeviceTemplate } from "../../../lib/intake/device-template";
import { PILOT_CONFIG } from "../../../lib/pilot";
import { HandoffSection } from "./handoff-section";

// The review + handoff section (Mission v2 M4, BN-18/21/23/24/25): the
// prepared-package view under the conversation. Every form field shows its
// state and provenance ("we already know this from what you told us" /
// drafted for you / still needed); pii-likely fields show the status badge
// and never the value (the server omits it structurally). The handoff half
// renders the ordered steps and the official-portal companion links from
// the pilot seam, and the session's lifecycle transitions: prepared →
// handed_off, then submission is only ever REPORTED by the person — the app
// can never set a submitted state (BN-25).
//
// Response shapes are defined locally, mirroring the review route's
// payload: the server forms modules must not enter the client bundle. The
// download's fill is the browser-safe half (lib/forms/fill-core.ts) plus
// the committed registry's browser-safe entries, reached only through the
// on-demand import in downloadFilledPdf (HACK-138) — the questions never
// wait on the PDF library.

interface ReviewFieldView {
  readonly fieldName: string;
  readonly question: string;
  readonly state: "prefilled" | "asked" | "not_applicable";
  readonly specQuestionId: string | null;
  readonly required: boolean;
  readonly piiLikely: boolean;
  readonly status?: "known" | "unknown" | "unverified";
  readonly provenance?:
    | "user_supplied"
    | "ai_drafted"
    | "source_verified"
    // The tax-return confirm flow's provenances (VAL-INC-007), mirroring
    // the answer table's vocabulary the review payload carries.
    | "tax_return"
    | "user";
  readonly value?: string;
}

/** The disposition report's per-field row (mirrors the review route payload). */
interface CoverageFieldView {
  readonly fieldName: string;
  readonly question: string;
  readonly pages: readonly number[];
  readonly disposition: string;
  readonly dispositionReason?: string;
}

/** The full-form disposition report (mirrors the review route payload). */
interface CoverageReportView {
  readonly counts: {
    readonly mapped: number;
    readonly not_collected_by_interview: number;
    readonly optional_unanswered: number;
    readonly agency_use_only: number;
    readonly duplicate_structural: number;
    readonly total: number;
  };
  readonly fields: readonly CoverageFieldView[];
}

interface ReviewDataView {
  readonly hasSession: boolean;
  readonly form: {
    id: string;
    title: string;
    version: string;
    sourceUrl: string;
    retrievedAt: string;
  };
  /** The program this form belongs to (the pilot seam's per-form answer). */
  readonly programName?: string;
  readonly countyName?: string;
  readonly fields: readonly ReviewFieldView[];
  readonly toResolve: readonly { fieldName: string; question: string }[];
  readonly counts: { prefilled: number; asked: number; notApplicable: number };
  /**
   * The full-form disposition report (VAL-FIX-007): every field on the
   * template with its reviewed disposition, so nothing is silently
   * unmapped. Optional so older payloads keep rendering.
   */
  readonly coverage?: CoverageReportView;
  readonly sessionStatus: string;
  readonly portalLinks: readonly { label: string; url: string }[];
  readonly steps: readonly { title: string; detail: string }[];
}

/** Local copy for the session lifecycle (BN-25) — mirrors the server labels. */
const SESSION_STATUS_COPY: Readonly<Record<string, string>> = {
  draft: "In progress",
  prepared: "Prepared and ready to hand off",
  handed_off: "Handed off",
  user_reported_submitted: "You told us it was submitted",
  user_reported_decided: "You told us a decision was made",
};

const PROVENANCE_COPY: Readonly<Record<string, string>> = {
  user_supplied: "You told us",
  ai_drafted: "Drafted for you",
  source_verified: "From a source you verified",
  // The tax-return confirm flow's provenances (VAL-INC-007/010): a
  // confirmed parser proposal and a person-corrected value. Without these
  // labels the badges rendered empty — they are also the income stage's
  // origin-badge copy ("From your tax return").
  tax_return: "From your tax return",
  user: "You corrected this",
};

const STATE_COPY: Readonly<Record<ReviewFieldView["state"], string>> = {
  prefilled: "We already know this from what you told us",
  asked: "Still needed",
  not_applicable: "Not needed for you",
};

/** Plain-language copy for each disposition bucket (VAL-FIX-007 report). */
const DISPOSITION_COPY: Readonly<Record<string, string>> = {
  not_collected_by_interview: "This conversation doesn't collect it",
  optional_unanswered: "Optional — left blank",
  agency_use_only: "For the agency to complete",
  duplicate_structural: "A printed line, not an answer box",
};

/** The report's non-mapped rows — the ones the details list explains. */
function blankCoverageFields(
  coverage: CoverageReportView,
): CoverageReportView["fields"] {
  return coverage.fields.filter((field) => field.disposition !== "mapped");
}

// The page pointer lives in lib/forms/disposition.ts, with the report it
// reads, so the step-by-step page (HACK-115) points at the same pages.
// Re-exported here unchanged.
export { pagePointer };

// An unverified answer must never read as confirmed (honesty spine): its
// state line says what actually happened and asks for the check, and the
// status badge beside it repeats "Answered but not verified".
function stateCopyFor(field: ReviewFieldView): string {
  if (field.state === "prefilled" && field.status === "unverified") {
    return "You answered this, but haven't verified it — please check it";
  }
  return STATE_COPY[field.state];
}

export const REVIEW_UNAVAILABLE_NOTICE =
  "The application review is unavailable right now. Your answers are " +
  "safe; try again after your next message.";

/**
 * What the download is, and what a saved copy of it is (HACK-138): the
 * fill happens in this browser from the values the page already holds —
 * the review payload's non-private values and the answers typed below —
 * so no request ever carries an answer. The file disclosure is the
 * sanctioned-download rule's own condition (rules.md, HACK-115; the same
 * wording the step-by-step page's download shows): the file holds the
 * filled-in answers, private ones included, is an ordinary unencrypted
 * file, and should be deleted after printing or sending on a shared
 * computer. The private answers the page shows only as a status badge —
 * the ones the app keeps in its encrypted records — never enter the file:
 * those lines stay blank for the person to finish by hand.
 */
const DOWNLOAD_COPY = {
  downloaded:
    "Your application downloaded. It was filled right on this device, " +
    "and nothing about it was saved on our side. The lines still needed " +
    "are blank — finish those by hand.",
  templateUnavailable:
    "We couldn't get the blank form right now, so nothing was filled. " +
    "Check your connection and try again.",
  unreadableBoxes:
    "Nothing was filled. Some box answers aren't checked or unchecked, so " +
    "fix the ones listed and try again.",
  invalidTyped:
    "One of the answers you typed for the form couldn't be used. Please " +
    "check it and try again.",
  unreadableForm:
    "We couldn't open the blank form, so nothing was filled. Try again in a moment.",
  failed: "The download didn't go through. Try again in a moment.",
  note:
    "The download is filled right on this device, from the answers on " +
    "this page and the ones you typed below — no answers are sent " +
    "anywhere to make it. Answers shown with a status instead of a value " +
    "stay blank on the file: finish those lines by hand after printing.",
  fileDisclosure:
    "The file holds the answers filled in on the form, private ones " +
    "included. It's an ordinary file that isn't encrypted, so on a shared " +
    "computer, delete it once you've printed or sent it.",
};

/**
 * The DHB-5200's signature field (AcroForm discovery, registry entry
 * v1.1.0): the one field the app can never fill from a store. When the
 * review payload carries it, it renders as the distinct typed-signature
 * step below — the person types their full name, and that fresh value is
 * the ONLY source (it fills the download on this device, in memory, once).
 */
export const SIGNATURE_FIELD_NAME = "Signature";

export function ReviewSection({
  refreshKey,
  stagger = false,
  formId = PILOT_CONFIG.formRegistryId,
  idPrefix = "",
  ownsSessionLifecycle = true,
}: {
  refreshKey: number;
  stagger?: boolean;
  /**
   * The form-registry id to review. Defaults to the pilot's primary form;
   * the additional applications ("also prepare" reuse) pass their own.
   */
  formId?: string;
  /** DOM-id prefix — the sibling review sections pass their form ids. */
  idPrefix?: string;
  /**
   * Whether this review renders the session's lifecycle controls (the
   * BN-25 status is one per session, not per form). Additional
   * applications pass false — their reviews are preparation surfaces.
   */
  ownsSessionLifecycle?: boolean;
}) {
  const [data, setData] = useState<ReviewDataView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadReview() {
      try {
        // The form under review: the pilot's primary application by
        // default; an additional application ("Also prepare…") passes its
        // own registered form id. Both run the same form-agnostic route.
        const response = await fetch(`/api/forms/${formId}/review`);
        if (!response.ok) {
          throw new Error("review unavailable");
        }
        const payload = (await response.json()) as ReviewDataView;
        if (!cancelled) {
          setData(payload.hasSession ? payload : null);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    }
    void loadReview();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, formId]);

  return (
    <>
      {data ? (
        <ReviewSectionContent
          data={data}
          stagger={stagger}
          idPrefix={idPrefix}
          ownsSessionLifecycle={ownsSessionLifecycle}
        />
      ) : null}
      <StatusRegion
        message={failed ? REVIEW_UNAVAILABLE_NOTICE : ""}
        className="text-sm text-muted"
      />
    </>
  );
}

/**
 * The pure presentation for one review payload. Exported for tests: the
 * detector scans render this markup for fixture payloads. `stagger` (the
 * results stage's real-data fill reveal, VAL-VJS2-001) staggers the mapped
 * field list — the fields, states, provenance, and counts stay exactly the
 * payload's, never simulated.
 */
export function ReviewSectionContent({
  data,
  stagger = false,
  idPrefix = "",
  ownsSessionLifecycle = true,
}: {
  data: ReviewDataView;
  stagger?: boolean;
  /**
   * DOM-id prefix for this section's labelled controls. Two prepared
   * applications render as sibling review sections (the ask-once reuse);
   * ids must stay unique per form for the label wiring and axe.
   */
  idPrefix?: string;
  /**
   * Whether THIS review owns the session's lifecycle controls (the BN-25
   * status is one per session, not per form — claude-review P2 on PR
   * #121). The additional applications' reviews are preparation surfaces:
   * they leave the status line and the lifecycle transitions to the
   * pilot's primary review, so a package step marked on one form can
   * never misstate where the other form stands.
   */
  ownsSessionLifecycle?: boolean;
}) {
  const idFor = (suffix: string): string =>
    idPrefix === "" ? suffix : `${idPrefix}-${suffix}`;
  // The session's lifecycle status: the server's value until THIS component
  // advances it locally (derived state — no setState-in-effect cascade).
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const sessionStatus = localStatus ?? data.sessionStatus;
  const [downloaded, setDownloaded] = useState(false);
  // The fill's own still-needed rows, joined to the review's after a
  // download (the private answers the page doesn't hold among them) —
  // what is blank on the file is what the section lists. They belong to
  // the payload they were filled from: a refreshed review (the next
  // message's answers landed) drops them until the person downloads
  // again, so a stale row never lingers (claude-review P2, PR #150).
  const [fill, setFill] = useState<{
    readonly data: ReviewDataView;
    readonly blanks: readonly { fieldName: string; question: string }[];
  } | null>(null);
  const fillBlanks = fill && fill.data === data ? fill.blanks : [];
  const stillNeeded: readonly { fieldName: string; question: string }[] = [
    ...data.toResolve,
    ...fillBlanks.filter(
      (blank) =>
        !data.toResolve.some((item) => item.fieldName === blank.fieldName),
    ),
  ];
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current) {
        clearTimeout(noticeTimer.current);
      }
    },
    [],
  );

  const announce = useCallback((message: string) => {
    setNotice("");
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
    }
    // The StatusRegion must CHANGE its text to announce: clear, then set on
    // the next tick (the same convention the match section follows).
    noticeTimer.current = setTimeout(() => setNotice(message), 30);
  }, []);

  async function advance(body: Record<string, string>): Promise<void> {
    setBusy(true);
    try {
      const response = await fetch("/api/session", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error("transition failed");
      }
      const payload = (await response.json()) as {
        session: { status: string };
      };
      setLocalStatus(payload.session.status);
      announce(SESSION_STATUS_COPY[payload.session.status] ?? "Progress saved");
    } catch {
      announce("That step didn't go through. Nothing was lost — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadFilledPdf(): Promise<void> {
    setBusy(true);
    try {
      // The fill runs HERE, in the browser (HACK-138): the sanctioned
      // download is a form "created in the user's browser from values the
      // client already holds" (.github/claude-review/rules.md, the HACK-115
      // owner decision), and the rule forbids "sending server- or
      // vault-held pii values to a page or payload". The old server fill
      // (POST /api/forms/<formId>/fill) crossed that line — the vault-held
      // values rode to the page inside the PDF — so this download now
      // fills from exactly what this page holds: the review payload's own
      // values (private ones are omitted from the payload by design) and
      // the answers typed below. The one request on the path is the blank
      // public template's GET. Nothing about the fill is stored, sent, or
      // logged anywhere.
      const { fillReviewOnDevice, reviewFormEntry } = await import(
        "../../../lib/intake/review-fill"
      );
      const entry = reviewFormEntry(data.form.id);
      if (!entry) {
        throw new Error("unknown form");
      }
      const template = await loadDeviceTemplate(entry);
      if (!template) {
        announce(DOWNLOAD_COPY.templateUnavailable);
        return;
      }
      const result = await fillReviewOnDevice(template, data.fields, drafts, entry);
      if (result.kind === "unreadable_boxes") {
        // Name the blocking questions: "the ones listed" is nothing
        // without the list (claude-review P2, PR #150) — on the real form
        // many boxes are answered by hand, so the person needs to know
        // which typed answer stopped the fill.
        const questions = result.fields.map(
          (name) =>
            data.fields.find((field) => field.fieldName === name)?.question ?? name,
        );
        announce(`${DOWNLOAD_COPY.unreadableBoxes} (${questions.join("; ")})`);
        return;
      }
      if (result.kind === "invalid_answers") {
        announce(DOWNLOAD_COPY.invalidTyped);
        return;
      }
      if (result.kind === "unreadable_form") {
        announce(DOWNLOAD_COPY.unreadableForm);
        return;
      }
      const blob = new Blob([new Uint8Array(result.outcome.bytes)], {
        type: "application/pdf",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${data.form.id}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      // The fill's own still-needed list (the private answers the page
      // doesn't hold, among them) joins the review's, so what is blank on
      // the file is exactly what the section above lists.
      setFill({ data, blanks: result.outcome.toResolve });
      setDownloaded(true);
      announce(DOWNLOAD_COPY.downloaded);
    } catch {
      announce(DOWNLOAD_COPY.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-review-section
      data-review-form={data.form.id}
      className="flex flex-col gap-6"
    >
      <section
        aria-labelledby={idFor("review-heading")}
        className="flex flex-col gap-3"
      >
        {/* The heading carries the form's own title: two prepared
        applications (the ask-once reuse) render as sibling sections, and
        assistive-tech heading navigation must tell them apart. */}
        <h2
          id={idFor("review-heading")}
          className="font-display text-2xl font-bold"
        >
          {data.form.title} — prepared from your answers
        </h2>
        <p className="text-sm text-muted">
          {data.form.title} — source:{" "}
          <a href={data.form.sourceUrl} className="underline" rel="noreferrer">
            {data.form.sourceUrl}
          </a>{" "}
          (retrieved {data.form.retrievedAt}, form version {data.form.version})
        </p>
        <p data-real-form-note className="text-sm font-medium text-amber-ink">
          We filled in the fields we could from what you told us, and left
          the rest blank for you to finish. This is the official application
          form: you review it, complete it, and submit it yourself — the app
          never submits for you. Preparing it is not a benefits decision;
          only the agency decides that.
        </p>
        {/* The real-data fill reveal (VAL-VJS2-001, owner master spec):
        "Filling your application · X of N fields" — X and N read the ACTUAL
        review payload (prefilled count over the real mapped fields); the
        stagger below only paces the presentation of the same real fields.
        Nothing is simulated, and the "still needed" list stays visible. */}
        <p
          data-fill-reveal
          className="flex flex-wrap items-baseline gap-2 text-sm font-medium"
        >
          Filling your application
          <span
            data-fill-count={`${data.counts.prefilled} of ${data.fields.length} fields`}
            className="font-mono text-xs text-muted"
          >
            {data.counts.prefilled} of {data.fields.length} fields
          </span>
        </p>
        <ul className="flex flex-col gap-3" data-review-fields>
          {data.fields.map((field, index) => (
            <li
              key={field.fieldName}
              data-review-field={field.fieldName}
              style={
                stagger ? { animationDelay: `${index * 90}ms` } : undefined
              }
              className={
                stagger
                  ? "stagger-item flex flex-col gap-1 rounded-xl border border-surface-border bg-surface p-4"
                  : "flex flex-col gap-1 rounded-xl border border-surface-border bg-surface p-4"
              }
            >
              <span className="font-medium">{field.question}</span>
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <span data-field-state={field.state} className="text-muted">
                  {stateCopyFor(field)}
                </span>
                {field.status ? <AnswerStatusBadge status={field.status} /> : null}
                {field.provenance && field.state === "prefilled" ? (
                  <span
                    data-field-provenance={field.provenance}
                    className="text-muted"
                  >
                    ({PROVENANCE_COPY[field.provenance]})
                  </span>
                ) : null}
              </span>
              {field.state === "prefilled" && field.value !== undefined ? (
                <span data-field-value={field.fieldName}>{field.value}</span>
              ) : null}
              {field.state === "asked" &&
              field.specQuestionId === null &&
              field.fieldName === SIGNATURE_FIELD_NAME ? (
                // The distinct typed-signature step (VAL-VJS2-002, HACK-116
                // decision 3): the person types their full legal name — the
                // same act as signing by hand, in e-signature form. The
                // value fills the form on this device and nothing else; the
                // app never signs and never pre-fills this field.
                <span
                  data-signature-step
                  className="flex flex-col gap-1"
                >
                  <label
                    htmlFor={idFor("signature-input")}
                    className="font-medium"
                  >
                    Type your full name to sign
                  </label>
                  <span
                    id={idFor("signature-help")}
                    className="text-sm text-muted"
                  >
                    Typing your full name signs this application, like an
                    e-signature. The app never signs for you, and your
                    signature is never filled in from anything you told us
                    before. Leave it blank to sign the printed form by hand.
                  </span>
                  <input
                    id={idFor("signature-input")}
                    type="text"
                    aria-describedby={idFor("signature-help")}
                    autoComplete="name"
                    value={drafts[SIGNATURE_FIELD_NAME] ?? ""}
                    onChange={(event) =>
                      setDrafts((previous) => ({
                        ...previous,
                        [SIGNATURE_FIELD_NAME]: event.target.value,
                      }))
                    }
                    className="rounded-lg border border-surface-border bg-surface px-2 py-1"
                  />
                  <span
                    data-draft-note={field.fieldName}
                    className="text-xs text-muted"
                  >
                    Used for this download only — nothing is stored on our
                    side.
                  </span>
                </span>
              ) : null}
              {field.state === "asked" &&
              field.specQuestionId === null &&
              field.fieldName !== SIGNATURE_FIELD_NAME ? (
                <span className="flex flex-col gap-1">
                  <label
                    className="sr-only"
                    htmlFor={idFor(`form-answer-${field.fieldName}`)}
                  >
                    {field.question}
                  </label>
                  <input
                    id={idFor(`form-answer-${field.fieldName}`)}
                    type="text"
                    value={drafts[field.fieldName] ?? ""}
                    onChange={(event) =>
                      setDrafts((previous) => ({
                        ...previous,
                        [field.fieldName]: event.target.value,
                      }))
                    }
                    className="rounded-lg border border-surface-border bg-surface px-2 py-1"
                  />
                  <span
                    data-draft-note={field.fieldName}
                    className="text-xs text-muted"
                  >
                    Used for this download only — nothing is stored on our
                    side.
                  </span>
                </span>
              ) : null}
              {field.state === "asked" && field.specQuestionId !== null ? (
                <span className="text-sm text-muted">
                  Keep answering in the conversation — your answer lands here.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {data.coverage ? (
        <section
          aria-labelledby={idFor("coverage-heading")}
          data-field-coverage
          className="flex flex-col gap-2"
        >
          <h2
            id={idFor("coverage-heading")}
            className="font-display text-xl font-bold"
          >
            Every field, accounted for
            {/* Two prepared applications render as sibling review sections;
            the regions' accessible names stay unique per form (axe
            landmark-unique) — the form's own title rides visually hidden. */}
            <span className="sr-only"> — {data.form.title}</span>
          </h2>
          <p
            data-coverage-counts
            data-coverage-count={data.coverage.counts.total}
            className="text-sm text-muted"
          >
            The application has {data.coverage.counts.total} fillable boxes
            and lines. {data.coverage.counts.mapped} of them take your
            answers. The rest stay blank on the downloaded form:{" "}
            {data.coverage.counts.not_collected_by_interview} this
            conversation doesn&apos;t collect — complete those by hand if
            they apply to you; {data.coverage.counts.optional_unanswered}{" "}
            are optional; {data.coverage.counts.agency_use_only} are for the
            agency to complete; and{" "}
            {data.coverage.counts.duplicate_structural} are printed lines
            that were never answer boxes.
          </p>
          {blankCoverageFields(data.coverage).length > 0 ? (
            <details className="rounded-xl border border-surface-border bg-surface p-4 text-sm">
              <summary className="cursor-pointer font-medium">
                Why each blank field stays blank
              </summary>
              <ul className="mt-3 flex flex-col gap-2">
                {blankCoverageFields(data.coverage).map((field) => (
                  <li
                    key={field.fieldName}
                    data-coverage-field={field.fieldName}
                    className="flex flex-col gap-0.5"
                  >
                    <span className="font-medium">{field.question}</span>
                    <span className="text-muted">
                      {DISPOSITION_COPY[field.disposition] ?? field.disposition}{" "}
                      — {pagePointer(field.pages)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="text-sm text-muted" data-coverage-all-mapped>
              Every fillable box on this form takes an answer — nothing was
              skipped.
            </p>
          )}
        </section>
      ) : null}

      {stillNeeded.length > 0 ? (
        <section
          aria-labelledby={idFor("form-to-resolve-heading")}
          data-form-to-resolve
          className="flex flex-col gap-2 rounded-2xl border border-dashed border-amber-line bg-amber-soft p-5"
        >
          <h2
            id={idFor("form-to-resolve-heading")}
            className="font-display text-xl font-bold text-amber-ink"
          >
            Still needed on the form
            <span className="sr-only"> — {data.form.title}</span>
          </h2>
          <p className="text-amber-ink">
            These are left blank on the prepared form — nothing is guessed.
          </p>
          <ul className="list-disc pl-5">
            {stillNeeded.map((item) => (
              <li key={item.fieldName}>{item.question}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        aria-labelledby={idFor("handoff-heading")}
        data-handoff
        className="flex flex-col gap-3 rounded-2xl border border-surface-border bg-surface p-6"
      >
        <h2
          id={idFor("handoff-heading")}
          className="font-display text-2xl font-bold"
        >
          Getting it done
          <span className="sr-only"> — {data.form.title}</span>
        </h2>
        {ownsSessionLifecycle ? (
          <p className="text-sm text-muted">
            Where you are: <span data-session-status={sessionStatus}>{SESSION_STATUS_COPY[sessionStatus] ?? sessionStatus}</span>
          </p>
        ) : null}
        {/* The destination line (adjudicated spec Step 4, ADOPT): where the
        person submits the form themselves — the publicly published
        destination, carried by the pilot seam per form (the ask-once
        reuse surfaces each application's own program). The app never
        submits. */}
        <p data-destination-line className="text-sm font-medium">
          Where it goes: {data.countyName ?? PILOT_CONFIG.countyName} DSS —{" "}
          {data.programName ?? PILOT_CONFIG.programName}. You submit it
          yourself; the app never submits for you.
        </p>
        <ol className="flex flex-col gap-2 pl-5" data-handoff-steps>
          {data.steps.map((step, index) => (
            <li key={step.title} className="flex flex-col">
              <span className="font-medium">
                {index + 1}. {step.title}
              </span>
              <span className="text-sm text-muted">
                {step.detail}
              </span>
            </li>
          ))}
        </ol>
        {!ownsSessionLifecycle ? (
          // The additional applications' reviews are preparation surfaces:
          // the one session lifecycle (BN-25) is marked on the pilot's
          // primary review, so a step marked for one form can never
          // misstate where the other form stands.
          <p className="text-sm text-muted" data-lifecycle-owner-note>
            One journey, two prepared applications: the package steps —
            prepared, handed off, submitted — are marked on the{" "}
            {PILOT_CONFIG.programName} application&apos;s review.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void downloadFilledPdf()}
            data-action="download"
            className="rounded-full bg-teal-deep px-4 py-2 text-sm font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
          >
            Download the filled PDF
          </button>
          {/* The download's own honest note + the file disclosure
          (DOWNLOAD_COPY; the sanctioned-download rule's copy condition,
          HACK-138): what the fill is, what stays blank on the file, and
          what a saved copy is. */}
          <p data-download-note className="w-full text-sm text-muted">
            {DOWNLOAD_COPY.note} {DOWNLOAD_COPY.fileDisclosure}
          </p>
          {ownsSessionLifecycle ? (
            <>
              <button
                type="button"
                disabled={busy || sessionStatus !== "draft"}
                onClick={() => void advance({ status: "prepared" })}
                data-action="prepare"
                className="rounded-full bg-teal-deep px-4 py-2 text-sm font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
              >
                Mark my package prepared
              </button>
              <button
                type="button"
                disabled={busy || !downloaded || sessionStatus !== "prepared"}
                onClick={() => void advance({ status: "handed_off" })}
                data-action="hand-off"
                className="rounded-full bg-teal-deep px-4 py-2 text-sm font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
              >
                I picked up my application — mark handed off
              </button>
              <button
                type="button"
                disabled={busy || sessionStatus !== "handed_off"}
                onClick={() =>
                  void advance({
                    userReportedStatus: "user_reported_submitted",
                  })
                }
                data-action="report-submitted"
                className="rounded-full border border-surface-border bg-surface px-4 py-2 text-sm font-semibold hover:bg-teal-soft disabled:opacity-50"
              >
                I submitted it myself
              </button>
            </>
          ) : null}
        </div>
        <HandoffSection
          formId={data.form.id}
          sessionStatus={sessionStatus}
          downloaded={downloaded}
          stillNeededCount={stillNeeded.length}
          idPrefix={idPrefix}
        />
        <div className="flex flex-col gap-1">
          <h3 className="font-medium">Official portal (submit here yourself)</h3>
          <ul className="list-disc pl-5" data-portal-links>
            {data.portalLinks.map((link) => (
              <li key={link.url}>
                <a href={link.url} className="underline" rel="noreferrer">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <StatusRegion
        message={notice}
        className="text-sm text-muted"
      />
    </div>
  );
}
