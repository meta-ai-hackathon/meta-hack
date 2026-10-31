"use client";

import { useEffect, useRef, useState } from "react";
import { StatusRegion } from "../../components/status-region";
import { requestPurge, type PurgeRequestOutcome } from "./conversation/purge-section";

// Answers this browser has saved on the app's server (HACK-99, from the
// PR #67 review). Until HACK-99, /intake saved every answer to the server
// session behind the bn_session cookie, and the conversation page still
// does: its chat and its step-by-step fallback write to that same session.
// This page reads only the device, so answers there would sit on the server
// unseen, while the page says nothing entered here is sent and that its
// delete clears this device.
//
// This notice closes that gap. On load it asks the read-only state route
// whether this browser's session holds answers. The request carries only
// the cookie, never an answer, and creates no session. When answers are
// there it says how many, without guessing where they came from or calling
// them unused, because the person may still be using the chat (HACK-113).
// It says the delete also removes the chat, because the HACK-80 purge
// (POST /api/session/purge, through requestPurge) deletes the session's
// conversation turns too, and it runs that purge only behind one
// confirming step. The outcome copy follows requestPurge's four outcomes
// exactly: it claims a deletion only when the server confirmed one. When
// the check on load fails, the notice stays hidden: there is nothing true
// to say. When Check again fails after a delete of unknown outcome, the
// notice says it couldn't reach the app, so the press is never silent.
// Only one Check again runs at a time, so a failed check can never land
// after one that reached the app and overwrite what it found.

export const SERVER_ANSWERS_COPY = {
  heading: "Answers saved on the app's server",
  body: (count: number) =>
    `This browser has ${count === 1 ? "1 answer" : `${count} answers`} saved on ` +
    `the app's server. Deleting them also deletes any chat you had with the assistant.`,
  deleteButton: "Delete them from the app's server",
  confirm:
    "This deletes everything this browser saved on the app's server, " +
    "including any chat history and private details. It can't be undone.",
  confirmYes: "Yes, delete them",
  confirmNo: "Keep them",
  deleting: "Deleting…",
  purged:
    "Deleted from the app's server. All it keeps now is a record that this " +
    "browser had a session, with no answers in it.",
  noSession:
    "There was nothing saved on the app's server for this browser, so " +
    "nothing was removed.",
  refused: "The delete was refused, so nothing was removed from the app's server.",
  unknown:
    "We couldn't reach the app to finish the delete, so we can't say " +
    "whether it went through. Check again to see where things stand.",
  checkAgain: "Check again",
  goneAfterCheck: "Nothing from this browser is saved on the app's server now.",
  checkFailed:
    "We still couldn't reach the app, so we can't say whether the delete " +
    "went through. Try again in a moment.",
  checkFailedAgain:
    "Still no answer from the app, so we can't say yet whether the delete " +
    "went through. Try again in a moment.",
} as const;

/**
 * How many answers the state route says this browser's session holds, or
 * null when the payload isn't the route's state shape (an error, a proxy
 * page). Zero means a known empty session, or no session at all.
 */
export function serverAnswerCount(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const answered = (payload as { progress?: { answered?: unknown } }).progress?.answered;
  return typeof answered === "number" && Number.isInteger(answered) && answered >= 0
    ? answered
    : null;
}

/** Ask the state route how many answers this browser has on the server. Null when unknown. */
export async function checkServerAnswers(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const response = await fetchImpl("/api/intake/state");
    if (!response.ok) {
      return null;
    }
    return serverAnswerCount(await response.json());
  } catch {
    return null;
  }
}

const OUTCOME_COPY: Readonly<Record<PurgeRequestOutcome, string>> = {
  purged: SERVER_ANSWERS_COPY.purged,
  no_session: SERVER_ANSWERS_COPY.noSession,
  refused: SERVER_ANSWERS_COPY.refused,
  unknown: SERVER_ANSWERS_COPY.unknown,
};

type Notice =
  | { readonly phase: "checking" }
  | { readonly phase: "hidden" }
  | { readonly phase: "found"; readonly count: number }
  | { readonly phase: "confirming"; readonly count: number }
  | { readonly phase: "deleting"; readonly count: number }
  /** The delete ran; `outcome` says what the server reported. */
  | { readonly phase: "settled"; readonly count: number; readonly outcome: PurgeRequestOutcome };

export function ServerAnswersNotice() {
  const [notice, setNotice] = useState<Notice>({ phase: "checking" });
  const [message, setMessage] = useState("");
  const [focusTarget, setFocusTarget] = useState<{ readonly id: string; readonly seq: number } | null>(
    null,
  );
  const rootRef = useRef<HTMLElement>(null);
  // Set while a Check again waits on the app, so only one runs at a time.
  const checkingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void checkServerAnswers().then((count) => {
      if (!cancelled) {
        setNotice(count !== null && count > 0 ? { phase: "found", count } : { phase: "hidden" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Move focus to the control that replaced the one just pressed, so
  // keyboard and screen-reader users never land on the page body.
  useEffect(() => {
    if (focusTarget !== null) {
      rootRef.current?.querySelector<HTMLElement>(`[data-focus="${focusTarget.id}"]`)?.focus();
    }
  }, [focusTarget]);

  function focusNext(id: string): void {
    setFocusTarget((previous) => ({ id, seq: (previous?.seq ?? 0) + 1 }));
  }

  if (notice.phase === "checking" || notice.phase === "hidden") {
    return null;
  }

  async function deleteFromServer(count: number): Promise<void> {
    setNotice({ phase: "deleting", count });
    setMessage(SERVER_ANSWERS_COPY.deleting);
    const outcome = await requestPurge();
    setNotice({ phase: "settled", count, outcome });
    setMessage(OUTCOME_COPY[outcome]);
    focusNext(outcome === "unknown" ? "check-again" : "heading");
  }

  async function checkAgain(count: number): Promise<void> {
    if (checkingRef.current) {
      // A press while a check is out waits for that check's answer.
      return;
    }
    checkingRef.current = true;
    let latest: number | null = null;
    try {
      latest = await checkServerAnswers();
    } finally {
      checkingRef.current = false;
    }
    if (latest === 0) {
      setNotice({ phase: "settled", count, outcome: "purged" });
      setMessage(SERVER_ANSWERS_COPY.goneAfterCheck);
      focusNext("heading");
    } else if (latest !== null) {
      setNotice({ phase: "found", count: latest });
      setMessage("");
      focusNext("delete");
    } else {
      // The check itself failed (offline, an error, a proxy page). Say so
      // instead of changing nothing, and alternate the wording so a repeat
      // press is announced too: StatusRegion announces only a changed
      // message. Focus stays on Check again for the next try.
      setMessage((previous) =>
        previous === SERVER_ANSWERS_COPY.checkFailed
          ? SERVER_ANSWERS_COPY.checkFailedAgain
          : SERVER_ANSWERS_COPY.checkFailed,
      );
      focusNext("check-again");
    }
  }

  const removedOrNone =
    notice.phase === "settled" && (notice.outcome === "purged" || notice.outcome === "no_session");

  return (
    <section
      ref={rootRef}
      aria-labelledby="server-answers-heading"
      data-server-answers
      className="flex flex-col gap-3 rounded-2xl border border-amber-line bg-amber-soft p-6 text-foreground"
    >
      <h2
        id="server-answers-heading"
        data-focus="heading"
        tabIndex={-1}
        className="font-display text-xl font-semibold"
      >
        {SERVER_ANSWERS_COPY.heading}
      </h2>
      {removedOrNone ? null : <p className="max-w-xl">{SERVER_ANSWERS_COPY.body(notice.count)}</p>}
      <StatusRegion message={message} className="max-w-xl font-medium" />
      {notice.phase === "found" ? (
        <button
          type="button"
          data-focus="delete"
          onClick={() => {
            setNotice({ phase: "confirming", count: notice.count });
            focusNext("keep");
          }}
          className="min-h-11 self-start rounded-full border border-surface-border bg-surface px-6 py-2.5 text-base font-semibold hover:bg-teal-soft"
        >
          {SERVER_ANSWERS_COPY.deleteButton}
        </button>
      ) : null}
      {notice.phase === "confirming" || notice.phase === "deleting" ? (
        <div role="group" aria-labelledby="server-answers-confirm" className="flex flex-col gap-3">
          <p id="server-answers-confirm" className="max-w-xl">
            {SERVER_ANSWERS_COPY.confirm}
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void deleteFromServer(notice.count)}
              disabled={notice.phase === "deleting"}
              className="min-h-11 rounded-full bg-danger px-6 py-2.5 text-base font-semibold text-danger-contrast hover:underline disabled:opacity-50"
            >
              {notice.phase === "deleting" ? SERVER_ANSWERS_COPY.deleting : SERVER_ANSWERS_COPY.confirmYes}
            </button>
            <button
              type="button"
              data-focus="keep"
              onClick={() => {
                setNotice({ phase: "found", count: notice.count });
                focusNext("delete");
              }}
              disabled={notice.phase === "deleting"}
              className="min-h-11 rounded-full border border-surface-border bg-surface px-6 py-2.5 text-base font-semibold hover:bg-teal-soft disabled:opacity-50"
            >
              {SERVER_ANSWERS_COPY.confirmNo}
            </button>
          </div>
        </div>
      ) : null}
      {notice.phase === "settled" && notice.outcome === "unknown" ? (
        <button
          type="button"
          data-focus="check-again"
          onClick={() => void checkAgain(notice.count)}
          className="min-h-11 self-start rounded-full border border-surface-border bg-surface px-6 py-2.5 text-base font-semibold hover:bg-teal-soft"
        >
          {SERVER_ANSWERS_COPY.checkAgain}
        </button>
      ) : null}
    </section>
  );
}
