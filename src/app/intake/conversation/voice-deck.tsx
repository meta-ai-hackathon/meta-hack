import type { JSX, ReactNode } from "react";

// The bottom voice deck (VAL-VJS2-001, owner master spec adjudicated): the
// talk stage's voice presence strip. It hosts the existing state captions
// (the four phases, word-identical copy) and the 15-bar animated waveform —
// heights [3,5,9,16,11,22,28,17,11,23,15,7,12,5,3]px with alternating-scale
// keyframes — that FLATTENS while the turn is being transcribed or thought
// through (the assistant is working; the deck goes quiet) and animates
// while listening or speaking.
//
// The waveform is decorative: aria-hidden, no text of its own, and every
// state it depicts is ALSO carried by the caption text and the StatusRegion
// notice. All motion is defined only inside the prefers-reduced-motion:
// no-preference block in globals.css — reduced-motion users see the static
// bar strip (heights intact), never the animation.

/** The spec's exact bar heights, in px, left to right. */
export const WAVEFORM_HEIGHTS: readonly number[] = [
  3, 5, 9, 16, 11, 22, 28, 17, 11, 23, 15, 7, 12, 5, 3,
];

export type VoiceDeckPhase = "listening" | "transcribing" | "thinking" | "speaking";

/** The deck goes quiet exactly while the turn is in flight. */
export function waveformIsFlat(phase: VoiceDeckPhase | null): boolean {
  return phase === "thinking" || phase === "transcribing";
}

/* The session bar's inline glyphs (prototype iconography): decorative —
   every state they depict is also carried by the caption text and the
   StatusRegion notice. */
function IconGlyph(props: { children: ReactNode }): JSX.Element {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

function MicIcon(): JSX.Element {
  return (
    <IconGlyph>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </IconGlyph>
  );
}

function AudioLinesIcon(): JSX.Element {
  return (
    <IconGlyph>
      <path d="M2 10v3" />
      <path d="M6 6v11" />
      <path d="M10 3v18" />
      <path d="M14 8v7" />
      <path d="M18 5v13" />
      <path d="M22 10v3" />
    </IconGlyph>
  );
}

function SparklesIcon(): JSX.Element {
  return (
    <IconGlyph>
      <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
    </IconGlyph>
  );
}

function VolumeIcon(): JSX.Element {
  return (
    <IconGlyph>
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a10 10 0 0 1 0 14" />
    </IconGlyph>
  );
}

/** The 44px pause circle's glyph. */
export function PauseIcon(): JSX.Element {
  return (
    <IconGlyph>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </IconGlyph>
  );
}

/** The 44px resume circle's glyph. */
export function PlayIcon(): JSX.Element {
  return (
    <IconGlyph>
      <polygon points="6 3 20 12 6 21 6 3" />
    </IconGlyph>
  );
}

/**
 * The session bar's 44px status icon (VAL-FIX-006, the prototype's
 * `.voice-session-icon`): per-phase glyph, decorative, in a 44px circle.
 */
export function SessionStatusIcon(props: {
  phase: VoiceDeckPhase | null;
}): JSX.Element {
  return (
    <span
      data-voice-session-icon
      aria-hidden="true"
      className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-surface-border bg-background text-teal"
    >
      {props.phase === "speaking" ? (
        <VolumeIcon />
      ) : props.phase === "thinking" ? (
        <SparklesIcon />
      ) : props.phase === "transcribing" ? (
        <AudioLinesIcon />
      ) : (
        <MicIcon />
      )}
    </span>
  );
}

/**
 * The 15-bar waveform. Bars carry their exact px height; the alternating
 * scale keyframes (voice-wave-a / voice-wave-b in globals.css) animate
 * them, and the flat state scales the whole strip down to a resting line.
 */
export function VoiceWaveform(props: { phase: VoiceDeckPhase | null }): JSX.Element {
  const flat = waveformIsFlat(props.phase);
  return (
    <div
      aria-hidden="true"
      data-voice-waveform
      data-waveform-flat={flat ? "true" : "false"}
      className="flex h-9 items-center justify-center gap-1.5"
      style={flat ? { transform: "scaleY(0.15)" } : undefined}
    >
      {WAVEFORM_HEIGHTS.map((height, index) => (
        <span
          key={index}
          data-wave-bar={height}
          style={{ height: `${height}px` }}
          className={`voice-wave-bar w-1 rounded-full bg-teal ${
            index % 2 === 0 ? "voice-wave-bar-a" : "voice-wave-bar-b"
          }`}
        />
      ))}
    </div>
  );
}

/**
 * The bottom session deck (VAL-VJS2-001 host, VAL-FIX-006 geometry): the
 * prototype's session bar — 44px status icon, title/caption, waveform
 * pushed to the right edge (margin-left: auto), 44px pause circle — with
 * the tools row beneath (status text left, typing switch right). The
 * caller renders this inside the full-width bottom wrapper
 * (`data-voice-bottom`, padding 15px 32px 0) with the honesty strip
 * bleeding to the frame edges after it.
 *
 * The waveform is decorative: aria-hidden, no text of its own, and every
 * state it depicts is ALSO carried by the caption text and the
 * StatusRegion notice. All motion is defined only inside the
 * prefers-reduced-motion: no-preference block in globals.css —
 * reduced-motion users see the static bar strip (heights intact), never
 * the animation. The 760px breakpoint rule hides the waveform and pushes
 * the pause circle right (margin-left: auto), per the prototype.
 */
export function VoiceDeck(props: {
  phase: VoiceDeckPhase | null;
  sessionState: "active" | "paused";
  caption: ReactNode;
  /** The bar's right-anchored control (the 44px pause/resume circle). */
  controls: ReactNode;
  /** The tools row beneath the bar (status text, typing switch). */
  tools: ReactNode;
}): JSX.Element {
  return (
    <div
      data-voice-deck
      data-voice-session={props.sessionState}
      className="flex flex-col"
    >
      <div className="flex items-center gap-4 rounded-[7px] border border-surface-border bg-surface p-[15px]">
        <SessionStatusIcon phase={props.phase} />
        <div className="flex min-w-0 flex-col gap-1">{props.caption}</div>
        <div
          data-voice-wave-slot
          className="ml-auto hidden min-[761px]:block"
        >
          <VoiceWaveform phase={props.phase} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 min-[761px]:ml-0">
          {props.controls}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 pt-[5px]">
        {props.tools}
      </div>
    </div>
  );
}
