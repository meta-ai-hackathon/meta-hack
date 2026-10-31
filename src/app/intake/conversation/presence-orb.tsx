import type { JSX } from "react";
import { useSyncExternalStore } from "react";
import type { VoiceDeckPhase } from "./voice-deck";

// The presence orb (VAL-VJS-005, owner demo-day directive 2026-10-31: "a
// moving ball that … will float and move off of the conversation"). The
// talk stage's ambient decorative presence, bound to the same voice-session
// phase the state bar and the voice deck consume: listening floats gently,
// transcribing shimmers quickly, thinking wanders on a slow orbit, speaking
// bounces rhythmically, and with no phase running (mode-B typing, between
// turns) it keeps the slowest ambient drift.
//
// Decorative and never load-bearing: aria-hidden, no text of its own, and
// every state it depicts is ALSO carried by the state bar caption and the
// StatusRegion notice — the orb is never the only signal. Pure CSS (the
// ball and halo are styled divs; no images, no dependencies); the frame is
// a fixed square the ball moves inside via transform only, so states can
// never shift layout, and it contains nothing focusable. Motion is defined
// ONLY inside the prefers-reduced-motion: no-preference block of
// globals.css — reduced-motion users get the static glow variant (ball +
// halo, no animation). The frame mirrors document.hidden into
// data-document-hidden so the same block can pause every orb animation
// while the document is hidden.

const documentVisibility = {
  subscribe(onChange: () => void): () => void {
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  },
  getSnapshot(): boolean {
    return document.hidden;
  },
  getServerSnapshot(): boolean {
    // Server render and hydration start from the visible default; the
    // first visibilitychange corrects it.
    return false;
  },
};

export function PresenceOrb(props: {
  phase: VoiceDeckPhase | null;
}): JSX.Element {
  const documentHidden = useSyncExternalStore(
    documentVisibility.subscribe,
    documentVisibility.getSnapshot,
    documentVisibility.getServerSnapshot,
  );
  return (
    <div
      aria-hidden="true"
      data-presence-orb
      data-orb-phase={props.phase ?? "idle"}
      data-document-hidden={documentHidden ? "true" : "false"}
      className="presence-orb-frame"
    >
      <span className="presence-orb-halo" />
      <span className="presence-orb-ball" />
    </div>
  );
}
