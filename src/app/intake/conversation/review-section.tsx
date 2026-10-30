"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnswerStatusBadge } from "../../../components/answer-status-badge";
import { StatusRegion } from "../../../components/status-region";

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
// payload: the server forms modules must not enter the client bundle.

interface ReviewFieldView {
  readonly fieldName: string;
  readonly question: string;
  readonly state: "prefilled" | "asked" | "not_applicable";
  readonly specQuestionId: string | null;
  readonly required: boolean;
  readonly piiLikely: boolean;
  readonly status?: "known" | "unknown" | "unverified";
  readonly provenance?: "user_supplied" | "ai_drafted" | "source_verified";
  readonly value?: string;
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
  readonly fields: readonly ReviewFieldView[];
  readonly toResolve: readonly { fieldName: string; question: string }[];
  readonly counts: { prefilled: number; asked: number; notApplicable: number };
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
};

const STATE_COPY: Readonly<Record<ReviewFieldView["state"], string>> = {
  prefilled: "We already know this from what you told us",
  asked: "Still needed",
  not_applicable: "Not needed for you",
};

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

export function ReviewSection({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<ReviewDataView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadReview() {
      try {
        const response = await fetch("/api/forms/sample-application-form/review");
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
  }, [refreshKey]);

  return (
    <>
      {data ? <ReviewSectionContent data={data} /> : null}
      <StatusRegion
        message={failed ? REVIEW_UNAVAILABLE_NOTICE : ""}
        className="text-sm text-zinc-600 dark:text-zinc-400"
      />
    </>
  );
}

/**
 * The pure presentation for one review payload. Exported for tests: the
 * detector scans render this markup for fixture payloads.
 */
export function ReviewSectionContent({ data }: { data: ReviewDataView }) {
  // The session's lifecycle status: the server's value until THIS component
  // advances it locally (derived state — no setState-in-effect cascade).
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const sessionStatus = localStatus ?? data.sessionStatus;
  const [downloaded, setDownloaded] = useState(false);
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
      // Drafted answers for fields the question spec doesn't ask ride the
      // fill request and live only in memory — nothing is stored anywhere.
      let body: FormData | undefined;
      const draftsToSend = Object.entries(drafts).filter(
        ([, value]) => value.trim() !== "",
      );
      if (draftsToSend.length > 0) {
        body = new FormData();
        body.append(
          "answers",
          JSON.stringify(Object.fromEntries(draftsToSend)),
        );
      }
      const response = await fetch(`/api/forms/${data.form.id}/fill`, {
        method: "POST",
        ...(body ? { body } : {}),
      });
      if (!response.ok) {
        throw new Error("fill failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${data.form.id}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setDownloaded(true);
      announce(
        "The sample application downloaded. Nothing was saved on our side.",
      );
    } catch {
      announce("The download didn't go through. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-review-section className="flex flex-col gap-6">
      <section aria-labelledby="review-heading" className="flex flex-col gap-3">
        <h2 id="review-heading" className="text-lg font-semibold">
          Your application, prepared from your answers
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {data.form.title} — source:{" "}
          <a href={data.form.sourceUrl} className="underline" rel="noreferrer">
            {data.form.sourceUrl}
          </a>{" "}
          (retrieved {data.form.retrievedAt}, form version {data.form.version})
        </p>
        <p data-sample-form-note className="text-sm text-amber-700 dark:text-amber-400">
          This is the demonstration form. Your program&apos;s real form replaces
          it once the pilot is locked — do not submit the sample anywhere.
        </p>
        <ul className="flex flex-col gap-3" data-review-fields>
          {data.fields.map((field) => (
            <li
              key={field.fieldName}
              data-review-field={field.fieldName}
              className="flex flex-col gap-1 rounded-md border border-zinc-200 p-3 dark:border-zinc-700"
            >
              <span className="font-medium">{field.question}</span>
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <span data-field-state={field.state} className="text-zinc-600 dark:text-zinc-400">
                  {stateCopyFor(field)}
                </span>
                {field.status ? <AnswerStatusBadge status={field.status} /> : null}
                {field.provenance && field.state === "prefilled" ? (
                  <span
                    data-field-provenance={field.provenance}
                    className="text-zinc-600 dark:text-zinc-400"
                  >
                    ({PROVENANCE_COPY[field.provenance]})
                  </span>
                ) : null}
              </span>
              {field.state === "prefilled" && field.value !== undefined ? (
                <span data-field-value={field.fieldName}>{field.value}</span>
              ) : null}
              {field.state === "asked" && field.specQuestionId === null ? (
                <span className="flex flex-col gap-1">
                  <label
                    className="sr-only"
                    htmlFor={`form-answer-${field.fieldName}`}
                  >
                    {field.question}
                  </label>
                  <input
                    id={`form-answer-${field.fieldName}`}
                    type="text"
                    value={drafts[field.fieldName] ?? ""}
                    onChange={(event) =>
                      setDrafts((previous) => ({
                        ...previous,
                        [field.fieldName]: event.target.value,
                      }))
                    }
                    className="rounded border border-zinc-300 px-2 py-1 dark:border-zinc-600 dark:bg-zinc-800"
                  />
                  <span
                    data-draft-note={field.fieldName}
                    className="text-xs text-zinc-500 dark:text-zinc-400"
                  >
                    Used for this download only — nothing is stored on our
                    side.
                  </span>
                </span>
              ) : null}
              {field.state === "asked" && field.specQuestionId !== null ? (
                <span className="text-sm text-zinc-600 dark:text-zinc-400">
                  Keep answering in the conversation — your answer lands here.
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {data.toResolve.length > 0 ? (
        <section
          aria-labelledby="form-to-resolve-heading"
          data-form-to-resolve
          className="flex flex-col gap-2 rounded-md border border-zinc-200 p-4 dark:border-zinc-700"
        >
          <h2 id="form-to-resolve-heading" className="text-lg font-semibold">
            Still needed on the form
          </h2>
          <p className="text-zinc-600 dark:text-zinc-400">
            These are left blank on the prepared form — nothing is guessed.
          </p>
          <ul className="list-disc pl-5">
            {data.toResolve.map((item) => (
              <li key={item.fieldName}>{item.question}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section
        aria-labelledby="handoff-heading"
        data-handoff
        className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4 dark:border-zinc-700"
      >
        <h2 id="handoff-heading" className="text-lg font-semibold">
          Getting it done
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Where you are: <span data-session-status={sessionStatus}>{SESSION_STATUS_COPY[sessionStatus] ?? sessionStatus}</span>
        </p>
        <ol className="flex flex-col gap-2 pl-5" data-handoff-steps>
          {data.steps.map((step, index) => (
            <li key={step.title} className="flex flex-col">
              <span className="font-medium">
                {index + 1}. {step.title}
              </span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">
                {step.detail}
              </span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || sessionStatus !== "draft"}
            onClick={() => void advance({ status: "prepared" })}
            data-action="prepare"
            className="rounded bg-zinc-800 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900"
          >
            Mark my package prepared
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void downloadFilledPdf()}
            data-action="download"
            className="rounded bg-zinc-800 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900"
          >
            Download the filled PDF
          </button>
          <button
            type="button"
            disabled={busy || !downloaded || sessionStatus !== "prepared"}
            onClick={() => void advance({ status: "handed_off" })}
            data-action="hand-off"
            className="rounded bg-zinc-800 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-zinc-200 dark:text-zinc-900"
          >
            I picked up my application — mark handed off
          </button>
          <button
            type="button"
            disabled={busy || sessionStatus !== "handed_off"}
            onClick={() =>
              void advance({ userReportedStatus: "user_reported_submitted" })
            }
            data-action="report-submitted"
            className="rounded border border-zinc-400 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-zinc-500"
          >
            I submitted it myself
          </button>
        </div>
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
        className="text-sm text-zinc-600 dark:text-zinc-400"
      />
    </div>
  );
}
