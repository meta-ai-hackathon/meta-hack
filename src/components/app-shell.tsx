import Link from "next/link";
import type { ReactNode } from "react";

/**
 * App shell (BN-07): the skip link is the first tab stop on every page and
 * jumps focus to the single main landmark. Pages render exactly one h1
 * inside it.
 *
 * The brand header (frontend-polish) sits after the skip link and gives
 * every page the same anchor: a wordmark linking home. It renders no
 * heading (the page's h1 stays the only one) and adds no copy beyond the
 * app's name.
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
        <div className="mx-auto flex w-full max-w-5xl items-center px-6 py-4">
          <Link
            href="/"
            data-brand-link
            className="flex items-center gap-2.5"
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
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="flex flex-1 flex-col">
        {children}
      </main>
    </>
  );
}
