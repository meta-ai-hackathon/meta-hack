# pstack skills (vendored)

## Provenance

- Upstream: <https://github.com/cursor/plugins> (`pstack/skills/` subtree)
- License: MIT
- Author: Lauren Tan (@poteto)
- Upstream commit copied from: `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`
- Copy date: 2026-10-27

Skill folders were copied verbatim (content unedited) and renamed with a `pstack-` prefix to avoid collisions with other skills.

## Copied skills

| Skill | Description |
|---|---|
| pstack-create-verification-skill | Generator that scaffolds a project-specific verification skill (the HACK-8 piece) |
| pstack-maintain-verification-skill | Refreshes an existing verification skill as the project evolves |
| pstack-correct | Workflow for correcting verified mistakes without over-correcting |
| pstack-interrogate | Systematic questioning of a codebase/claim before acting on it |
| pstack-prove-it-works | Demands executable proof that a change works before declaring done |
| pstack-fix-root-causes | Fixes the underlying cause of a bug rather than its symptoms |
| pstack-blast-radius | Assesses what a change can break before and after making it |
| pstack-show-me-your-work | Requires an auditable trail of decisions and evidence |
| pstack-subtract-before-you-add | Prefers removing complexity before adding new mechanisms |

## Host caveats

These skills were written for Cursor/Claude Code. In Droid they work as plain prompt instructions, but Cursor-only pieces do not apply: there is no model-role assignment, no `/loop`, no Cursor automations, and any references to `control-cli` / `cursor-team-kit` are out of reach. Multi-model review skills degrade to single-model (GLM-pinned) review in this environment.

## Deliberately skipped

- `poteto-mode` (and the other `principle-*` router skills not listed above): the router overlaps Droid's own orchestration.
- `babysit` / `shipping`-style workflows: overlap existing repo workflows.
- Benny-related skills: Cursor-automations-only.
