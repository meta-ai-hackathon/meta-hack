# Accessibility baseline (BN-07)

Accessibility is core correctness here, not polish: people using Benefits
Navigator may be on borrowed or shared devices, in stressful settings, or
with a caseworker driving the keyboard. The baseline ships in the app shell
and reusable components so every later flow inherits it.

## What ships in the baseline

| Piece | Where | Behavior |
| --- | --- | --- |
| Skip link | `src/components/app-shell.tsx` | First tab stop on every page; jumps focus to `#main-content` (a single `<main>` landmark with `tabindex="-1"` so focus actually moves). |
| Visible focus | `src/app/globals.css` | A `:focus-visible` ring drawn from the theme's foreground token, on every interactive element. No `outline: none` anywhere without a replacement. |
| Heading outline | every page | Exactly one `h1` per page; heading levels never skip (h2 without h1, h3 without h2, and so on). |
| Labeled field | `src/components/field.tsx` | Label/control association via `for`/`id`, help text wired through `aria-describedby`, errors announced with `role="alert"` plus `aria-invalid`/`aria-errormessage` on the control. |
| Status region | `src/components/status-region.tsx` | `role="status"` with `aria-live="polite"` and `aria-atomic="true"`; stays mounted so the first update is announced. |
| Motion | `src/app/globals.css` | `prefers-reduced-motion` collapses animations and transitions. |
| Contrast | theme tokens in `src/app/globals.css` | After the visual-polish pass (VAL-DEMOEXP-008) the default pairing is ink `#0a0a0a` on paper `#f8f4ec` — 18.05:1, at or above the pre-polish 17.93:1 (`#171717` on `#ffffff`); dark mode keeps the pre-polish `#ededed` on `#0a0a0a` (16.91:1). Muted text measures 9.42:1 light (pre-polish muted: 7.81:1). Every token pair is gated by `src/components/contrast-tokens.test.ts`. |

The home page (`src/components/a11y-demo.tsx`) demonstrates the field and
status region until real flows replace the demo.

## PR checklist — attest in the PR body

- [ ] Every page has exactly one `h1` and no skipped heading levels
- [ ] Every interactive control has a visible label or a stable accessible name
- [ ] Tab order reaches all interactive elements in a sensible order; the skip link is the first stop
- [ ] The focus indicator is visible on every interactive element (no focus suppression)
- [ ] Status changes render through `StatusRegion` and are announced
- [ ] UI copy avoids banned-claim language (covered by the CI scan)

## How the baseline is verified

Vitest (static SSR assertions, no extra a11y dependency):

- `src/components/app-shell.test.tsx` — skip link first, targets the single main landmark
- `src/components/field.test.tsx` — `for`/`id` association, help text, error announcement wiring
- `src/components/status-region.test.tsx` — polite atomic live region, stays mounted
- `src/app/page.test.tsx` — one `h1`, hierarchical outline, live region and labeled field present

`vitest-axe` was considered and skipped: it would add a dependency for
coverage that overlaps these static checks, so the behavioral checks below
run manually instead.

agent-browser (behavioral evidence on `http://localhost:3100`; start the dev
server with `pnpm dev --port 3100` — this mission's dev port. Plain
`pnpm dev` defaults to 3000):

1. Keyboard tab-through: screenshot the focused skip link, then the next stops.
2. Heading outline extraction per page (DOM query over `h1`-`h6`).
3. Accessibility-tree snapshot: textbox named by its label; press the demo
   button and observe the live region's announced update.
