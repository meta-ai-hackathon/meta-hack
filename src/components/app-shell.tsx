import type { ReactNode } from "react";

/**
 * App shell (BN-07): the skip link is the first tab stop on every page and
 * jumps focus to the single main landmark. Pages render exactly one h1
 * inside it.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border-2 focus:border-zinc-900 focus:bg-white focus:px-4 focus:py-2 focus:text-base focus:font-semibold focus:text-zinc-900 dark:focus:border-zinc-100 dark:focus:bg-zinc-900 dark:focus:text-zinc-50"
      >
        Skip to main content
      </a>
      <main id="main-content" tabIndex={-1} className="flex flex-1 flex-col">
        {children}
      </main>
    </>
  );
}
