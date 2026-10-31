"use client";

import { useState, type JSX } from "react";

// The entry mode choice (HACK-106 natural conversation, VAL-NCF-002) —
// the calm mode-choice moment at conversation entry, ported from the
// approved Lovable design round 2 (evidence/lovable-design/
// round2-mode-choice-entry-desktop.png) onto the repo's warm
// paper/ink/deep-teal token system. EXACTLY TWO voice entry modes:
// (A) "voice-only" — talk the whole way; (B) "voice-plus-typing" — talk
// with the switch-to-typing control available at any point. Nothing is
// sent by choosing: the consent surface has already decided what may be
// sent, and this choice only picks how the conversation starts.
//
// Styling stays on the approved tokens (font-display headings, surface
// cards, teal-deep primary); the reduced-motion preference kills any
// transition via the global rule; radios are native inputs so the group
// is keyboard operable with visible focus out of the box.

export type ConversationEntryMode = "voice-only" | "voice-plus-typing";

const MODE_OPTIONS: readonly {
  readonly mode: ConversationEntryMode;
  readonly title: string;
  readonly description: string;
}[] = [
  {
    mode: "voice-only",
    title: "Talk the whole way",
    description: "Speak freely. We'll listen and reply aloud.",
  },
  {
    mode: "voice-plus-typing",
    title: "Talk, with typing anytime",
    description: "Start with voice. Type whenever you like.",
  },
] as const;

export function ModeChoice(props: {
  /** Begin the conversation in the chosen mode. */
  readonly onBegin: (mode: ConversationEntryMode) => void;
}): JSX.Element {
  // The design frame shows the typing-available mode pre-selected: the
  // safer default (typing stays reachable). This is a UI-mode choice,
  // NOT a consent decision — nothing about what is sent.
  const [selected, setSelected] = useState<ConversationEntryMode>(
    "voice-plus-typing",
  );
  return (
    <section
      data-mode-choice
      aria-labelledby="mode-choice-heading"
      className="flex flex-col items-center gap-6 rounded-2xl border border-surface-border bg-surface p-8 text-center"
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-teal">
        Let&apos;s make this feel easier
      </p>
      <div className="flex flex-col gap-2">
        <h2 id="mode-choice-heading" className="font-display text-3xl font-bold">
          How would you like to talk?
        </h2>
        <p className="text-muted">
          You bring your story. We&apos;ll take it from there.
        </p>
      </div>
      <fieldset className="flex w-full flex-col gap-3 border-0 p-0">
        <legend className="sr-only">
          Choose how you want to answer: voice the whole way, or voice with
          typing available.
        </legend>
        {MODE_OPTIONS.map((option) => (
          <label
            key={option.mode}
            data-mode-option={option.mode}
            className="flex min-h-12 cursor-pointer items-center gap-3 rounded-2xl border border-surface-border bg-background p-4 text-left hover:border-teal has-[:checked]:border-teal has-[:checked]:bg-teal-soft"
          >
            <input
              type="radio"
              name="conversation-entry-mode"
              value={option.mode}
              checked={selected === option.mode}
              onChange={() => setSelected(option.mode)}
              className="h-5 w-5 shrink-0 accent-teal"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-semibold">{option.title}</span>
              <span className="text-sm text-muted">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        data-mode-begin
        onClick={() => props.onBegin(selected)}
        className="min-h-12 rounded-full bg-teal-deep px-8 py-3 text-base font-semibold text-teal-contrast hover:bg-teal"
      >
        Let&apos;s begin
      </button>
      <p className="text-sm text-muted">
        Live subtitles are always here.
      </p>
    </section>
  );
}
