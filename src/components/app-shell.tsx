import Link from "next/link";
import type { ReactNode } from "react";
import { DisplayControls } from "./display-controls";

/**
 * App shell (BN-07): the skip link is the first tab stop on every page and
 * jumps focus to the single main landmark. Pages render exactly one h1
 * inside it.
 *
 * The brand header (frontend-polish) sits after the skip link and gives
 * every page the same anchor: a wordmark linking home. It renders no
 * heading (the page's h1 stays the only one) and adds no copy beyond the
 * app's name. The same header carries the display controls (HACK-84:
 * huge-text zoom + high contrast) so they are reachable from every page —
 * including the intake, review, consent, and purge surfaces — before any
 * content needs reading.
 *
 * The header IS the product frame's header (VAL-FIX-006, the literal
 * Lovable prototype geometry): the frame spans edge-to-edge — no centered
 * max-width, no dead gutters — and the header takes the prototype's exact
 * shape: 84px tall with 24px 36px padding, brand left and controls right.
 * The height is set in rem (`h-[5.25rem]` = 84px at the default text
 * size) so the HACK-84 huge-text zoom grows the header WITH its content
 * instead of clipping it (claude-review P2); the 760px breakpoint rule
 * drops the paddings to 18px 20px with a 75px height floor (the controls
 * wrap on phones — the height grows, it never clips).
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:border-2 focus:border-foreground focus:bg-surface focus:px-4 focus:py-2 focus:text-base focus:font-semibold focus:text-foreground"
      >
        Skip to main content
      </a>
      <header
        data-app-header
        className="border-b border-surface-border bg-background"
      >
        <div className="flex min-h-[75px] w-full flex-col justify-center gap-3 px-5 py-[18px] min-[761px]:flex-row min-[761px]:items-center min-[761px]:justify-between min-[761px]:gap-8 min-[761px]:px-9 min-[761px]:py-6 min-[1101px]:h-[5.25rem]">
          <Link
            href="/"
            data-brand-link
            className="flex items-center gap-2.5 self-start"
          >
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-teal font-display text-lg font-bold text-teal-contrast"
            >
              B
            </span>
            <span className="font-display text-xl font-bold text-foreground">
              Benefits Navigator
            </span>
          </Link>
          <DisplayControls />
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="flex flex-1 flex-col">
        {children}
      </main>
    </>
  );
}
