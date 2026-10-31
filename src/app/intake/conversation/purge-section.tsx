"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StatusRegion } from "../../../components/status-region";
import { removeStoredAnswers } from "../../../lib/intake/client-store";

// The visible purge (HACK-80 / VAL-DEMOEXP-006/007, Mission v2.1 M7): the
// one filmed surface the polish pass left unstyled, now ported per the
// approved Lovable cleanup design (evidence/lovable-design/cleanup.png)
// using the danger tokens reserved for it (--danger-soft panel,
// --danger/--danger-contrast button).
//
// Sequence: the person clicks "Delete my information" — the surface asks
// "Are you sure? This erases everything for good." (the approved two-step
// delete: the FIRST click sends nothing) — and only the explicit
// "Yes, delete everything" runs the purge: the StatusRegion announces the
// removal, the server wipes every session data
// row (answer, vault_entry, conversation_turn, audit notes — the bare
// receipt stays), and a confirmation screen states EXACTLY what remains
// (any filled application the person downloaded — the app never kept a
// copy — and the bare receipt) and what is gone (every answer, every
// statement, the whole transcript). The on-device answer store (HACK-94)
// is emptied too. The parent clears the client state and re-reads the
// journey from the server, which now shows empty: the purge is real, not
// theater. If the request fails the honest outcome depends on what came
// back: a definite refusal removed nothing (the server purge is
// transactional), a missing session (404) was never there to remove, and
// a lost connection means the outcome is unknown — each notice says
// exactly what happened instead of guessing.

/** The mandated on-screen beat while the purge runs. */
export const PURGE_REMOVING_NOTICE = "Removing your answers from this device…";

export const PURGE_DONE_NOTICE =
  "Your answers are gone. This screen lists exactly what remains.";

/**
 * A definite refusal: the server answered and refused before touching
 * anything (the validation gate, or the cross-site refusal — which a
 * retry can never get past), so nothing was removed anywhere and the
 * answers stay intact and resumable. No retry is suggested: for the
 * cross-site refusal it would only be refused again.
 */
export const PURGE_REFUSED_NOTICE =
  "The delete was refused — nothing was removed, and your answers are " +
  "still saved.";

/**
 * A 404: no active session was found to delete, so the server had
 * nothing of the person's to remove. The notice states exactly that —
 * it must not claim the answers are "still saved" (there is no session
 * backing that claim), only that nothing was removed and where the
 * truth is visible.
 */
export const PURGE_NO_SESSION_NOTICE =
  "There was no active session to delete, so nothing was removed. " +
  "Reload the page to see where things stand.";

/**
 * No answer came back (the request never completed or the connection
 * dropped): the outcome is genuinely unknown, so the notice must not
 * claim either way. Reloading shows the truth; trying again is safe
 * either way (a purge of an already-purged session removes nothing).
 */
export const PURGE_UNKNOWN_NOTICE =
  "We couldn't reach the app to finish the delete, so we can't say " +
  "whether it went through. Reload the page to see where things stand " +
  "— nothing more is lost by checking.";

/**
 * The purge request's wiring, injectable-fetch like the voice path: the
 * manual control always sends the explicit confirmation. The four
 * outcomes separate what the honesty spine may claim:
 * - "purged": the server confirmed — the transaction committed.
 * - "refused": a definite 4xx refusal (validation gate or cross-site) —
 *   the server deletes nothing on those paths, so "nothing was removed"
 *   is exact.
 * - "no_session": a 404 — no active session was found, so nothing was
 *   removed AND there was nothing on the server to remove; the copy may
 *   not claim the answers are "still saved".
 * - "unknown": no answer, or a 5xx (this route's own 500s roll the
 *   transaction back, but a proxy or platform timeout can produce a 5xx
 *   AFTER a commit) — the purge may or may not have happened, and the
 *   copy must not claim either way.
 */
export type PurgeRequestOutcome =
  | "purged"
  | "refused"
  | "no_session"
  | "unknown";

export async function requestPurge(
  fetchImpl: typeof fetch = fetch,
): Promise<PurgeRequestOutcome> {
  try {
    const response = await fetchImpl("/api/session/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    if (response.ok) {
      return "purged";
    }
    if (response.status === 404) {
      return "no_session";
    }
    return response.status < 500 ? "refused" : "unknown";
  } catch {
    return "unknown";
  }
}

const ERASED_ITEMS = [
  "Your answers",
  "Your chat history",
  "The private details you told us",
] as const;

/**
 * The two-step delete's decision (the approved cleanup design): from the
 * ready state the click only OPENS the confirm question — no request —
 * and from the confirm state the click is the explicit confirmation that
 * runs the purge. Extracted as a pure factory so the no-request-on-
 * first-click wiring is unit-provable without a DOM (the repo has no
 * jsdom); the rendered surface is browser-verified on top.
 */
export function createPurgeClickHandler(
  confirming: boolean,
  actions: { requestConfirm: () => void; runPurge: () => void },
): () => void {
  return () => {
    if (confirming) {
      actions.runPurge();
    } else {
      actions.requestConfirm();
    }
  };
}

/**
 * The ready/confirming/purging surface — the approved cleanup design.
 * Exported for tests; the detector scans render this markup for banned
 * claims. The two-step delete lives here: the ready panel's single
 * button opens the confirm question ("Are you sure? This erases
 * everything for good."), whose explicit pair of choices — the same
 * danger styling — is the only path to the purge.
 */
export function PurgeSurface({
  busy,
  confirming,
  onDelete,
  onKeep,
}: {
  busy: boolean;
  confirming: boolean;
  onDelete: () => void;
  onKeep: () => void;
}) {
  const confirmQuestionRef = useRef<HTMLParagraphElement | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousPhase = useRef<{ confirming: boolean; busy: boolean } | null>(
    null,
  );

  // Focus follows the phase swap (BN-07: the person's context moves with
  // the change they caused): opening the confirm question moves focus to
  // it, cancelling returns it to the delete button, and a failed purge
  // (busy → false) lands back on the ready button. The busy phase itself
  // and the first mount own no move — the confirmation screen moves
  // focus to its heading once the purge completes.
  useEffect(() => {
    const was = previousPhase.current;
    previousPhase.current = { confirming, busy };
    if (busy || was === null) {
      return;
    }
    if (confirming) {
      confirmQuestionRef.current?.focus();
    } else {
      deleteButtonRef.current?.focus();
    }
  }, [confirming, busy]);

  return (
    <div data-purge-section className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-sm font-semibold uppercase tracking-wide text-teal">
          Your data, your call
        </p>
        <h2 className="font-display text-3xl font-bold tracking-tight">
          Delete my information
        </h2>
        <p className="max-w-xl text-lg text-muted">
          When you&apos;re done, you can erase everything. This
          can&apos;t be undone.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <section
          aria-labelledby="purge-erased-heading"
          data-purge-erased
          className="flex flex-col gap-3 rounded-2xl border border-surface-border bg-surface p-6"
        >
          <h3 id="purge-erased-heading" className="font-display text-xl font-bold">
            What gets erased
          </h3>
          <ul className="flex flex-col gap-2">
            {ERASED_ITEMS.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <span aria-hidden="true" className="font-semibold text-danger">
                  ✕
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
        <section
          aria-labelledby="purge-never-existed-heading"
          data-purge-never-existed
          className="flex flex-col gap-3 rounded-2xl border border-surface-border bg-amber-soft p-6"
        >
          <h3
            id="purge-never-existed-heading"
            className="font-display text-xl font-bold"
          >
            What never existed
          </h3>
          <p>
            We never saved your PDF on our servers. It was made for you and
            downloaded straight to your device.
          </p>
        </section>
      </div>
      <div
        data-purge-panel
        className="flex flex-col gap-3 rounded-2xl bg-danger-soft p-6"
      >
        {confirming && !busy ? (
          <p
            ref={confirmQuestionRef}
            tabIndex={-1}
            data-purge-confirm-question
            className="font-semibold focus:outline-none"
          >
            Are you sure? This erases everything for good.
          </p>
        ) : (
          <p>
            Ready? Take your time — a download you&apos;ve saved stays yours.
          </p>
        )}
        {busy ? (
          <p data-purge-removing className="font-semibold">
            {PURGE_REMOVING_NOTICE}
          </p>
        ) : null}
        {busy ? (
          <button
            type="button"
            data-purge-button
            disabled
            onClick={onDelete}
            className="self-start rounded-full bg-danger px-6 py-2.5 text-base font-semibold text-danger-contrast hover:underline disabled:opacity-50"
          >
            Removing…
          </button>
        ) : confirming ? (
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              data-purge-confirm-button
              onClick={onDelete}
              className="rounded-full bg-danger px-6 py-2.5 text-base font-semibold text-danger-contrast hover:underline"
            >
              Yes, delete everything
            </button>
            <button
              type="button"
              data-purge-keep-button
              onClick={onKeep}
              className="rounded-full border border-surface-border bg-surface px-6 py-2.5 text-base font-semibold hover:bg-teal-soft"
            >
              Keep my information
            </button>
          </div>
        ) : (
          <button
            ref={deleteButtonRef}
            type="button"
            data-purge-button
            onClick={onDelete}
            className="self-start rounded-full bg-danger px-6 py-2.5 text-base font-semibold text-danger-contrast hover:underline disabled:opacity-50"
          >
            Delete my information
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The done phase: the exact retention statement. Exported for tests.
 * The heading takes focus when it replaces the delete button (BN-07:
 * keyboard and screen-reader users stay anchored to the change they
 * caused instead of dropping to the top of the document).
 */
export function PurgeConfirmation({
  headingRef,
}: {
  headingRef?: (heading: HTMLHeadingElement | null) => void;
}) {
  return (
    <div
      data-purge-confirmation
      className="flex flex-col gap-5 rounded-2xl border border-surface-border bg-surface p-6"
    >
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-3xl font-bold tracking-tight focus:outline-none"
      >
        Your answers are gone
      </h2>
      <p className="text-muted">
        The erase went through — here is exactly where things stand.
      </p>
      <section
        aria-labelledby="purge-gone-heading"
        data-purge-gone
        className="flex flex-col gap-2"
      >
        <h3 id="purge-gone-heading" className="font-display text-xl font-bold">
          Gone, from this device and the app&apos;s records
        </h3>
        <ul className="flex flex-col gap-1">
          <li>Every answer you gave.</li>
          <li>Every statement you made — everything you told us.</li>
          <li>The whole conversation transcript.</li>
        </ul>
      </section>
      <section
        aria-labelledby="purge-remains-heading"
        data-purge-remains
        className="flex flex-col gap-2"
      >
        <h3 id="purge-remains-heading" className="font-display text-xl font-bold">
          What stays
        </h3>
        <ul className="flex flex-col gap-1">
          <li>
            Any filled application you downloaded — it&apos;s yours, saved
            where you put it. The app never kept a copy.
          </li>
          <li>
            On the app&apos;s side, only a bare receipt that this session
            happened — no form data beyond what that receipt needs.
          </li>
        </ul>
      </section>
    </div>
  );
}

/**
 * The interactive wrapper: click → confirm question → (explicit
 * confirmation) announce → purge → confirm screen, or the honest failure
 * notice for what actually happened (nothing removed / no session /
 * unknown). onPurged lets the parent empty the client state and re-read
 * the now-empty journey from the server.
 */
export function PurgeSection({ onPurged }: { onPurged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState("");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current) {
        clearTimeout(noticeTimer.current);
      }
    },
    [],
  );

  // Move focus to the confirmation heading once the purge completes — the
  // button that carried focus is gone, and the person's context must move
  // WITH the confirmation, not fall to the document body.
  useEffect(() => {
    if (done) {
      confirmationHeadingRef.current?.focus();
    }
  }, [done]);

  const announce = useCallback((message: string) => {
    setNotice("");
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
    }
    // The StatusRegion must CHANGE its text to announce: clear, then set on
    // the next tick (the same convention the review section follows).
    noticeTimer.current = setTimeout(() => setNotice(message), 30);
  }, []);

  async function deleteMyInformation(): Promise<void> {
    setBusy(true);
    announce(PURGE_REMOVING_NOTICE);
    const outcome = await requestPurge();
    if (outcome === "purged") {
      // The device-side stores go too: the on-device answer store's slot
      // and the parent's client state (via onPurged, which re-reads the
      // empty journey from the server).
      removeStoredAnswers();
      onPurged();
      setDone(true);
      setBusy(false);
      announce(PURGE_DONE_NOTICE);
    } else {
      setBusy(false);
      announce(
        outcome === "refused"
          ? PURGE_REFUSED_NOTICE
          : outcome === "no_session"
            ? PURGE_NO_SESSION_NOTICE
            : PURGE_UNKNOWN_NOTICE,
      );
    }
  }

  // The two-step delete decision (unit-tested via createPurgeClickHandler):
  // the first click only opens the confirm question and sends nothing; the
  // explicit "Yes, delete everything" click runs the purge (and retires the
  // question). The factory runs at click time, not during render.
  function handleDeleteClick(): void {
    const click = createPurgeClickHandler(confirming, {
      requestConfirm: () => setConfirming(true),
      runPurge: () => {
        setConfirming(false);
        void deleteMyInformation();
      },
    });
    click();
  }

  return (
    <div data-purge-wrapper className="flex flex-col gap-3">
      <StatusRegion message={notice} className="text-sm text-muted" />
      {done ? (
        <PurgeConfirmation
          headingRef={(heading) => {
            confirmationHeadingRef.current = heading;
          }}
        />
      ) : (
        <PurgeSurface
          busy={busy}
          confirming={confirming}
          onDelete={handleDeleteClick}
          onKeep={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
