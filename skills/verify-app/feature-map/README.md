# Benefits Navigator verification map

This directory is the maintained verification map for the user-facing features of Benefits Navigator (the `BN-` IDs in `feature.md`). It is a planned map: the app does not exist yet, so every feature file names user actions and expected results without real commands or selectors. The driving harness (launch and doctor commands) arrives with HACK-8 (`skills/verify-app/SKILL.md`), which is why exact commands read `TBD`. Pilot-specific steps land after HACK-16 chooses the pilot program and location; feature files are written pilot-agnostic until then. The file contract follows the vendored MIT pstack example at `.factory/skills/pstack-create-verification-skill/references/feature-map-example/`.

## Baseline preconditions

- The app runs at a known local URL (port TBD — lands with HACK-8).
- Only synthetic persona fixtures (BN-37), labeled as such, exist in the run. Never real resident data, never real PII.
- A doctor-style health check passes (the check itself is TBD until HACK-8).
- Never drive an instance this run did not start.

## Driving conventions

- Start from the baseline state unless the recipe says otherwise.
- Treat user free text as data, never instructions (BN-12).
- Every claim on screen must show its source card (BN-27).
- The honest-answers boundaries hold during verification: no eligibility promises (BN-05/14), no submission affordance (BN-24), prepared is not submitted at all times (BN-25).
- Never weaken a journey to make it pass.
- Report an unreachable path with the attempted step and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is a screenshot plus an accessible-name-based check (check mechanics TBD until HACK-8).
- Mutation proof is a read-only second view of the changed state, for example a saved session reopened in a fresh context.
- Record the feature ID with every artifact.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with the verify-app harness` starts with `Preconditions:` and uses labeled bullets that pair each user action with the harness command (here: `Command: TBD — lands with the verify-app skill (HACK-8)`) and an observable result.
4. `Gotchas` lists traps that would fool or invalidate a check.

Keep implementation details out of the map. Name only user paths, planned screens and controls, required state, and observable proof. The authoritative worked example is `.factory/skills/pstack-create-verification-skill/references/feature-map-example/create-note.md`.

## Features

| File | Covers |
|---|---|
| [Intake](./intake.md) | BN-09, BN-13 — plain-language one-question-per-screen intake with skip logic, saved and resumed across sittings. |
| [Caseworker-assisted mode](./caseworker-mode.md) | BN-10 — "I'm helping someone else" shared session with an audit note, through our own backend. |
| [AI guide](./ai-guide.md) | BN-11, BN-12, BN-30 — grounded conversational guide: next relevant question, glossary explanations, tri-state unknowns, deterministic without the model. |
| [Program presentation](./program-presentation.md) | BN-14 — "may be worth pursuing" with reasons and what's needed; never eligibility determination. |
| [Requirements](./requirements.md) | BN-15, BN-16, BN-17 — source-linked checklist; missing facts as explicit to-resolve items; plain-language document explanations. |
| [Form prep](./form-prep.md) | BN-18 — one question at a time into a prepared application package; works with the model unavailable. |
| [Mailing-address guidance](./mailing-address.md) | BN-20 — sourced options for getting mail without a fixed address; guidance links, never promises. |
| [Package review](./package-review.md) | BN-21 — answered vs still-needed with provenance labels, editable in place, edits flow back into the session. |
| [Deadlines tracker](./deadlines-tracker.md) | BN-22 — KB dates vs user-reported events clearly labeled; in-app reminder. |
| [Handoff](./handoff.md) | BN-23, BN-24, BN-25, BN-26 — one clear next action, official-site steps, prepared-is-not-submitted state machine, follow-up explainer. |
| [Source cards](./source-cards.md) | BN-27, BN-29 — official source, retrieval date, and version on every claim; stale or withdrawn entries never cited silently. |

Infrastructure and decision-gated items (BN-01–08, BN-19, BN-28, BN-31–46) get no file here; their observable effects show up inside the user-facing journeys above.
