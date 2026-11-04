"use client";

import type { ReactNode } from "react";
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
//
// The panel is a layered notice (HACK-165). The first layer is what makes
// the choice informed: each toggle's label (what is sent, to whom, for
// what, from the registry), the line that Meta sees typed words before
// anything is hidden and may keep them, the line that the microphone never
// starts with voice off, any unverified or dependency notice, and both
// buttons. Each path's
// verified terms and its retention or data-use line sit in that path's
// FinePrint, a closed native disclosure on the same panel, one tap away
// before anything is sent.

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
          — verified by us on {termsEntry.verifiedOn}.
        </span>
      ))}
    </span>
  );
}

/**
 * One path's fine print: its verified terms and its retention or data-use
 * line, closed by default under the path's toggle (HACK-165). The toggle
 * label above already names what is sent, to whom, and for what.
 */
function FinePrint({
  pathId,
  summary,
  children,
}: {
  pathId: ConsentPathSpec["id"];
  summary: string;
  children: ReactNode;
}) {
  return (
    <details data-consent-details={pathId} className="text-sm text-muted">
      <summary className="w-fit cursor-pointer py-1 font-medium text-teal underline hover:opacity-80">
        {summary}
      </summary>
      <div className="mt-1 flex flex-col gap-2">{children}</div>
    </details>
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
          No AI provider receives anything until you allow it. Answers save
          on the app&apos;s server so you can finish later. Change this at
          any time — the choice stays on this device; turning sharing off
          stops sends immediately.
        </p>
      </div>

      {aiPath ? (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="consent-ai-toggle"
            className="flex flex-col gap-1 font-medium"
          >
            <span className="flex flex-wrap items-start gap-x-2 gap-y-2">
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
                Share {aiPath.sends.join(" and ")} with {aiPath.provider},{" "}
                {aiPath.purpose}.
              </span>
            </span>
          </label>
          {aiEnabled ? null : (
            <span
              data-honest-unverified-copy
              className="text-sm font-medium text-amber-ink"
            >
              {UNVERIFIED_COPY}
            </span>
          )}
          <p className="text-sm text-muted">
            With sharing on, each typed message reaches Meta once — the step
            that reads your answer sees your words before anything is hidden.
            Meta may keep them per its terms.
          </p>
          <FinePrint
            pathId={aiPath.id}
            summary={aiEnabled ? "Meta's terms and data use" : "Meta's data use"}
          >
            {aiEnabled ? <PathTerms terms={aiPath.terms} /> : null}
            <p>
              Meta says content is not used to train its models — not a
              promise that nothing is kept.
            </p>
          </FinePrint>
        </div>
      ) : null}

      {voicePath ? (
        <div className="flex flex-col gap-2">
          <label
            htmlFor="consent-voice-toggle"
            className="flex flex-col gap-1 font-medium"
          >
            <span className="flex flex-wrap items-start gap-x-2 gap-y-2">
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
                Also share your voice with {voicePath.provider},{" "}
                {voicePath.purpose}. What is sent:{" "}
                {voicePath.sends.join(" and ")}.
              </span>
            </span>
          </label>
          {voicePath.termsVerified ? (
            props.aiChecked ? null : (
              <span
                id="consent-voice-help"
                data-voice-dependency-copy
                className="text-sm text-muted"
              >
                {VOICE_DEPENDENCY_COPY}
              </span>
            )
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
            With voice off, the microphone never starts and no audio is ever
            sent.
          </p>
          <FinePrint
            pathId={voicePath.id}
            summary={
              voicePath.termsVerified
                ? "ElevenLabs' terms and data use"
                : "ElevenLabs' data use"
            }
          >
            {voicePath.termsVerified ? <PathTerms terms={voicePath.terms} /> : null}
            <p>
              Only the assistant&apos;s reply text goes to ElevenLabs, which
              may use it to improve its services (training opt-out in your
              account) — never anything you said or typed.
            </p>
          </FinePrint>
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
        receives anything. Your answers save on the app&apos;s server so you
        can pick up later.
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
 * The revocable receipt (VAL-CONSENT-002/005): what the user decided and
 * how to take it back. HACK-150 / VAL-UX-010: the on-screen presentation is
 * a short, friendly, non-technical privacy reassurance — no raw JSON on
 * screen. The stored record itself is UNCHANGED: the per-device receipt
 * keeps its exact wire format (parseConsentReceipt still consumes it
 * verbatim); this panel renders strictly from the stored fields and never
 * writes — presentation only.
 */
export function ConsentReceiptPanel(props: ConsentReceiptPanelProps) {
  const { receipt } = props;
  // Friendly provider naming derives from the enforcement registry so copy
  // and enforcement cannot drift apart (the consent gate rejects receipts
  // for any other provider, so this line never names a provider the
  // decision was not made with). The registry string's parenthetical is
  // technical detail; the full naming lives on the consent panel above.
  const aiPath = CONSENT_PATHS.find((path) => path.id === "ai-conversation");
  const providerName =
    aiPath?.provider.replace(/\s*\(.*\)$/, "") ?? "the assistant";
  return (
    <section
      data-consent-receipt
      aria-labelledby="consent-receipt-heading"
      className="flex flex-col gap-2 rounded-2xl border border-surface-border bg-surface p-4 text-sm"
    >
      <h2 id="consent-receipt-heading" className="font-display text-xl font-bold">
        Your privacy choices
      </h2>
      <p data-consent-receipt-summary>
        You&apos;re in control of your information: sharing what you type
        with the AI assistant ({providerName}) is {receipt.ai ? "on" : "off"},
        and voice sharing is {receipt.voice ? "on" : "off"}. This choice was
        saved on this device on {new Date(receipt.at).toLocaleString()}.
      </p>
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
