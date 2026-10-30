"use client";

import {
  CONSENT_PATHS,
  type ConsentPathSpec,
  type ConsentReceipt,
} from "../../../lib/consent";

// The consent surface (Mission v2.1 M5, HACK-81, VAL-CONSENT-002/004).
// Rendered BEFORE anything can be sent: plain language about what leaves
// the device, to which provider, for what purpose — with the zero-send
// alternative (the step-by-step form, where nothing is sent anywhere) and
// the verified vendor terms linked on every consented path.
//
// Honesty rules baked into this copy:
// - The extraction call sees the raw typed sentence before anything is
//   hidden — the copy DISCLOSES that send instead of denying it.
// - Vendor terms are quoted with attribution and dates; no absolute
//   "we keep nothing" claims (the terms do not say that).
// - A path whose terms are not verified renders its toggle disabled with
//   honest copy — no silent enable.

const VOICE_DEPENDENCY_COPY =
  "Turn on sharing of typed answers first — spoken answers reach the same assistant.";

const UNVERIFIED_COPY =
  "We haven't verified this provider's data-handling terms yet, so this stays off.";

export interface ConsentPanelProps {
  /** Current checkbox states (the parent owns the draft decision). */
  readonly aiChecked: boolean;
  readonly voiceChecked: boolean;
  /** The path registry — injectable so tests can fixture an unverified path. */
  readonly paths?: readonly ConsentPathSpec[];
  readonly onToggleAi: (checked: boolean) => void;
  readonly onToggleVoice: (checked: boolean) => void;
  /** Continue with the checkbox states as chosen. */
  readonly onDecide: () => void;
  /** The zero-send alternative: decline everything, keep applying. */
  readonly onDecline: () => void;
}

function PathTerms({
  terms,
}: {
  terms: ConsentPathSpec["terms"];
}) {
  return (
    <span className="flex flex-col gap-1 text-sm text-muted">
      {terms.map((termsEntry) => (
        <span key={termsEntry.url}>
          <a
            href={termsEntry.url}
            target="_blank"
            rel="noreferrer"
            className="text-teal underline hover:opacity-80"
          >
            {termsEntry.label}
          </a>{" "}
          — what the provider does with sent content, verified by us on{" "}
          {termsEntry.verifiedOn}.
        </span>
      ))}
    </span>
  );
}

export function ConsentPanel(props: ConsentPanelProps) {
  const paths = props.paths ?? CONSENT_PATHS;
  const aiPath = paths.find((path) => path.id === "ai-conversation");
  const voicePath = paths.find((path) => path.id === "voice");
  const aiEnabled = aiPath?.termsVerified === true;
  // Voice is its own additional toggle, and it needs the typed sharing on
  // first (spoken answers reach the same extraction path as typed ones).
  const voiceEnabled = voicePath?.termsVerified === true && props.aiChecked;
  // The help span only exists when we show the dependency or unverified
  // copy — never point aria-describedby at a missing element.
  const showVoiceHelp = !voicePath?.termsVerified || !props.aiChecked;

  return (
    <section
      data-consent-surface
      aria-labelledby="consent-surface-heading"
      className="flex flex-col gap-5 rounded-2xl border border-surface-border bg-surface p-6"
    >
      <div className="flex flex-col gap-2">
        <h2 id="consent-surface-heading" className="font-display text-2xl font-bold">
          Before anything is sent: your choice about sharing
        </h2>
        <p className="text-muted">
          No AI provider receives anything from you until you allow it. Your
          answers save on the app&apos;s server so you can finish later —
          that is separate, and it is the only place they go while sharing is
          off. You can change this at any time, and turning sharing off stops
          sends immediately. The choice itself is stored on this device, with
          you — it never carries your answers.
        </p>
      </div>

      {aiPath ? (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="consent-ai-toggle"
            className="flex flex-col gap-1 font-medium"
          >
            <span className="flex items-start gap-2">
              <input
                id="consent-ai-toggle"
                type="checkbox"
                data-consent-ai-toggle
                checked={props.aiChecked}
                disabled={!aiEnabled}
                onChange={(event) => props.onToggleAi(event.target.checked)}
                className="consent-switch mt-0.5"
              />
              <span>
                Share the words you type with {aiPath.provider},{" "}
                {aiPath.purpose}. What is sent: {aiPath.sends.join(" and ")}.
              </span>
            </span>
          </label>
          {aiEnabled ? (
            <PathTerms terms={aiPath.terms} />
          ) : (
            <span
              data-honest-unverified-copy
              className="text-sm font-medium text-amber-ink"
            >
              {UNVERIFIED_COPY}
            </span>
          )}
          <p className="text-sm text-muted">
            To be fully honest: with sharing on, each message you type is sent
            to Meta once — the step that pulls your answer out of your
            sentence sees your words before anything is hidden. That is
            exactly what this toggle allows; nothing is sent until you allow
            it. Meta&apos;s commitments for the standard service say content
            is not used to train its models, and that content is kept as
            Meta&apos;s terms describe — that is not a promise that nothing
            is kept.
          </p>
        </div>
      ) : null}

      {voicePath ? (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="consent-voice-toggle"
            className="flex flex-col gap-1 font-medium"
          >
            <span className="flex items-start gap-2">
              <input
                id="consent-voice-toggle"
                type="checkbox"
                data-consent-voice-toggle
                checked={props.voiceChecked}
                disabled={!voiceEnabled}
                onChange={(event) => props.onToggleVoice(event.target.checked)}
                aria-describedby={
                  showVoiceHelp ? "consent-voice-help" : undefined
                }
                className="consent-switch mt-0.5"
              />
              <span>
                Also share your voice: recordings go to {voicePath.provider}{" "}
                {voicePath.purpose}. What is sent:{" "}
                {voicePath.sends.join(" and ")}.
              </span>
            </span>
          </label>
          {voicePath.termsVerified ? (
            <>
              <PathTerms terms={voicePath.terms} />
              {props.aiChecked ? null : (
                <span
                  id="consent-voice-help"
                  data-voice-dependency-copy
                  className="text-sm text-muted"
                >
                  {VOICE_DEPENDENCY_COPY}
                </span>
              )}
            </>
          ) : (
            <span
              id="consent-voice-help"
              data-honest-unverified-copy
              className="text-sm font-medium text-amber-ink"
            >
              {UNVERIFIED_COPY}
            </span>
          )}
          <p className="text-sm text-muted">
            With voice sharing off, the microphone is never started and no
            audio is ever transmitted. Gemini&apos;s free-tier terms say
            submitted content may be used to improve Google&apos;s products
            and ask that personal information not be submitted — so only the
            assistant&apos;s own reply text ever goes there for reading
            replies aloud, never anything you said or typed.
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          data-consent-continue
          onClick={props.onDecide}
          disabled={!aiEnabled}
          className="rounded-full bg-teal-deep px-6 py-2.5 text-base font-semibold text-teal-contrast hover:bg-teal disabled:opacity-50"
        >
          Continue with these choices
        </button>
        <button
          type="button"
          data-consent-decline
          onClick={props.onDecline}
          className="rounded-full border border-teal bg-surface px-6 py-2.5 text-base font-semibold text-teal hover:bg-teal-soft"
        >
          Don&apos;t send anything — use the step-by-step form
        </button>
      </div>
      <p className="text-sm text-muted">
        The step-by-step form asks the same questions, and no AI provider
        receives anything: you still get the same questions, honest status
        labels, your benefit match, the review screen, and the filled PDF to
        download. Your answers save on the app&apos;s server so you can pick
        up later.
      </p>
    </section>
  );
}

export interface ConsentReceiptPanelProps {
  readonly receipt: ConsentReceipt;
  /** Turn sharing off right now — stops further sends immediately. */
  readonly onRevoke: () => void;
  /** Re-open the consent panel to change the choices. */
  readonly onReopen: () => void;
}

/**
 * The inspectable, revocable receipt (VAL-CONSENT-002/005): what the user
 * decided, when, and how to take it back — plus the raw receipt itself,
 * which carries the decision and nothing else (no answer data).
 */
export function ConsentReceiptPanel(props: ConsentReceiptPanelProps) {
  const { receipt } = props;
  return (
    <section
      data-consent-receipt
      aria-labelledby="consent-receipt-heading"
      className="flex flex-col gap-2 rounded-2xl border border-surface-border bg-surface p-4 text-sm"
    >
      <h2 id="consent-receipt-heading" className="font-display text-xl font-bold">
        Your privacy choices
      </h2>
      <p>
        Sharing what you type with the assistant is:{" "}
        {receipt.ai ? "on" : "off"}. Voice sharing is:{" "}
        {receipt.voice ? "on" : "off"}. Decided on{" "}
        {new Date(receipt.at).toLocaleString()}. Stored on this device.
      </p>
      <details data-consent-receipt-json>
        <summary className="cursor-pointer underline">
          The receipt, exactly as stored
        </summary>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs text-muted">
          {JSON.stringify(receipt)}
        </pre>
      </details>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-consent-revoke
          onClick={props.onRevoke}
          disabled={!receipt.ai && !receipt.voice}
          className="rounded-full border border-surface-border bg-surface px-4 py-2 font-medium hover:bg-teal-soft disabled:opacity-50"
        >
          Turn off sharing
        </button>
        <button
          type="button"
          data-consent-reopen
          onClick={props.onReopen}
          className="rounded-full border border-surface-border bg-surface px-4 py-2 font-medium hover:bg-teal-soft"
        >
          Change your choices
        </button>
      </div>
    </section>
  );
}
