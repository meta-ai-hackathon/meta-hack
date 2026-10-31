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
 * The deck container: waveform + caption + the existing session controls
 * (passed through as children so the pause/typing controls keep their
 * validated markup and data attributes unchanged). The deck carries the
 * session state attribute the rest of the surface keys off (active/paused).
 */
export function VoiceDeck(props: {
  phase: VoiceDeckPhase | null;
  sessionState: "active" | "paused";
  caption: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-voice-deck
      data-voice-session={props.sessionState}
      className="flex flex-col items-center gap-3 rounded-2xl border border-surface-border bg-surface px-6 py-4"
    >
      <VoiceWaveform phase={props.phase} />
      <div className="flex flex-col items-center gap-2">{props.caption}</div>
      <div className="flex w-full flex-wrap items-center justify-center gap-2">
        {props.children}
      </div>
    </div>
  );
}
