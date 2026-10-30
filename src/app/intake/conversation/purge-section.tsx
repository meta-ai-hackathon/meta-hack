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
// Sequence: the person clicks "Delete my information" — a deliberate,
// explicit action (nothing purges without it, VAL-DEMOEXP-007) — the
// StatusRegion announces the removal, the server wipes every session data
// row (answer, vault_entry, conversation_turn, audit notes — the bare
// receipt stays), and a confirmation screen states EXACTLY what remains
// (any filled application the person downloaded — the app never kept a
// copy — and the bare receipt) and what is gone (every answer, every
// statement, the whole transcript). The on-device answer store (HACK-94)
// is emptied too. The parent clears the client state and re-reads the
// journey from the server, which now shows empty: the purge is real, not
// theater. If the request fails, NOTHING was removed (the server purge is
// transactional) and the notice says so — answers stay intact and
// resumable.

/** The mandated on-screen beat while the purge runs. */
export const PURGE_REMOVING_NOTICE = "Removing your answers from this device…";

export const PURGE_DONE_NOTICE =
  "Your answers are gone. This screen lists exactly what remains.";

export const PURGE_FAILED_NOTICE =
  "The delete didn't go through. Nothing was removed — your answers are " +
  "still saved. Try again.";

/**
 * The purge request's wiring, injectable-fetch like the voice path: the
 * manual control always sends the explicit confirmation. Returns whether
 * the purge happened — a refusal or a network error is false, never a
 * thrown surprise for the click handler.
 */
export async function requestPurge(
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl("/api/session/purge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const ERASED_ITEMS = [
  "Your answers",
  "The filled PDF",
  "Your chat history",
] as const;

/**
 * The ready/purging surface — the approved cleanup design. Exported for
 * tests; the detector scans render this markup for banned claims.
 */
export function PurgeSurface({
  busy,
  onDelete,
}: {
  busy: boolean;
  onDelete: () => void;
}) {
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
        <p>
          Ready? Take your time — a download you&apos;ve saved stays yours.
        </p>
        {busy ? (
          <p data-purge-removing className="font-semibold">
            {PURGE_REMOVING_NOTICE}
          </p>
        ) : null}
        <button
          type="button"
          data-purge-button
          disabled={busy}
          onClick={onDelete}
          className="self-start rounded-full bg-danger px-6 py-2.5 text-base font-semibold text-danger-contrast hover:underline disabled:opacity-50"
        >
          {busy ? "Removing…" : "Delete my information"}
        </button>
      </div>
    </div>
  );
}

/**
 * The done phase: the exact retention statement. Exported for tests.
 */
export function PurgeConfirmation() {
  return (
    <div
      data-purge-confirmation
      className="flex flex-col gap-5 rounded-2xl border border-surface-border bg-surface p-6"
    >
      <h2 className="font-display text-3xl font-bold tracking-tight">
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
 * The interactive wrapper: click → announce → purge → confirm, or the
 * honest failure notice (nothing removed). onPurged lets the parent empty
 * the client state and re-read the now-empty journey from the server.
 */
export function PurgeSection({ onPurged }: { onPurged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState("");
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
    // the next tick (the same convention the review section follows).
    noticeTimer.current = setTimeout(() => setNotice(message), 30);
  }, []);

  async function deleteMyInformation(): Promise<void> {
    setBusy(true);
    announce(PURGE_REMOVING_NOTICE);
    const purged = await requestPurge();
    if (purged) {
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
      announce(PURGE_FAILED_NOTICE);
    }
  }

  return (
    <div data-purge-wrapper className="flex flex-col gap-3">
      <StatusRegion message={notice} className="text-sm text-muted" />
      {done ? (
        <PurgeConfirmation />
      ) : (
        <PurgeSurface
          busy={busy}
          onDelete={() => void deleteMyInformation()}
        />
      )}
    </div>
  );
}
