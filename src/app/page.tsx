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
// Single column on mobile. The content region (sidebar + framed card)
// spreads across the available width up to the generous 85rem maximum
// (VAL-FIX-005) — only intentional outer padding, no dead gutters.
// The honesty/consent copy is NOT redesigned
// here: the consent surface still owns every gate-gated word, and the
// mode choice only picks how the conversation starts — never what may be
// sent.
export default function Home() {
  return (
    <div className="mx-auto w-full max-w-[85rem] flex-1 px-6 py-10 lg:px-10">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-4xl font-bold tracking-tight">
          Benefits Navigator
        </h1>
        <p className="max-w-xl text-lg text-muted">
          A step-by-step companion for benefits applications. We help you
          prepare, keep uncertainty visible, and you decide what gets
          submitted.
        </p>
      </div>
      <div className="mt-8 grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)] md:items-start">
        <JourneyNav />
        <HomeEntryChoice />
      </div>
      <p className="mt-6 text-sm text-muted">
        Prefer step-by-step questions?{" "}
        <Link href="/intake" className="text-teal underline hover:opacity-80">
          Use the form instead
        </Link>
        .
      </p>
    </div>
  );
}
