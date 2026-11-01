import Link from "next/link";
import { HomeEntryChoice } from "./home-entry-choice";
import { JourneyNav } from "./journey-nav";

// The entry/home surface (VAL-FIX-003): the approved Lovable round-2
// shell — the three-stage journey sidebar (mode choice -> talk ->
// results; reached stages navigate, not-yet-reached stages locked — the
// journey engine's rules still govern) beside the framed paper-card
// content (the approved mode-choice card, per
// evidence/lovable-design/round2-mode-choice-entry-desktop.png). The
// brand mark lives in the app header; the card echoes the waveform mark.
// Single column on mobile.
//
// The surface is the prototype's ENTRY frame geometry, copied literally
// (VAL-FIX-006): the framed surface spans edge-to-edge — no centered
// max-width column, no dead gutters (the VAL-FIX-005 85rem cap is
// superseded) — and the entry content (the mode-choice card, which
// carries the prototype's .voice-entry metrics itself) is centered
// INSIDE the full-width frame at 490px. The honesty/consent copy is NOT
// redesigned here: the consent surface still owns every gate-gated
// word, and the mode choice only picks how the conversation starts —
// never what may be sent.
export default function Home() {
  return (
    <div className="flex w-full flex-1 flex-col">
      <div className="flex flex-col gap-2 px-5 pt-7 min-[761px]:px-9 min-[761px]:pt-9">
        <h1 className="font-display text-4xl font-bold tracking-tight">
          Benefits Navigator
        </h1>
        <p className="max-w-xl text-lg text-muted">
          A step-by-step companion for benefits applications. We help you
          prepare, keep uncertainty visible, and you decide what gets
          submitted.
        </p>
      </div>
      <div className="flex w-full flex-1 flex-col gap-6 px-5 pt-4 pb-8 min-[761px]:grid min-[761px]:grid-cols-[14rem_minmax(0,1fr)] min-[761px]:items-start min-[761px]:px-9 min-[761px]:pb-10">
        <JourneyNav />
        <HomeEntryChoice />
      </div>
      <p className="px-5 pb-8 text-sm text-muted min-[761px]:px-9 min-[761px]:pb-10">
        Prefer step-by-step questions?{" "}
        <Link href="/intake" className="text-teal underline hover:opacity-80">
          Use the form instead
        </Link>
        .
      </p>
    </div>
  );
}
