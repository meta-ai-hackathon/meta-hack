# AGENTS.md

Guidance for any agent or human working in this repo. See the [README](README.md) for what the repo is.

## Repo map

- `README.md` — status, timeline, repo map, rules
- `AGENTS.md` — this file, agent conventions
- `info/` — hackathon reference material copied from the vault (event guide, links, grading, restrictions, workflow, stack)
- `ideas/` — one file per idea plus the running scorecard
- `skills/` — agent-runnable skills (`skills/evaluate-idea/SKILL.md` scores any idea)
- `demo/` — demo video script and filming materials (`demo/demo-script-v0.md` is the 3-minute storyline draft)
- `tests/` — pytest checks over repo markdown plus SQL-level data model checks (VAL-DM) against the Docker Postgres
- `scripts/` — standalone checks (link checker)
- `migrations/` — plain-SQL schema migrations, numbered and append-only, applied by `src/lib/migrate.ts` (`pnpm db:migrate`)
- `.github/` — CI workflows, issue/PR templates, dependabot, codeowners

## Markdown conventions

- GitHub-flavored markdown only. No `==highlight==`, no `[[wikilinks]]`, no other Obsidian-only syntax
- Use tables for tabular data
- One H1 per file

## Validation

One-time setup from a fresh clone:

```text
python3 -m pip install -r requirements-dev.txt
```

Run both before committing:

```text
npx markdownlint-cli2 "**/*.md"
python3 -m pytest tests/ -q
python3 -m mypy scripts/ tests/
```

## App commands (Benefits Navigator, `src/`)

The web app is Next.js (App Router, TypeScript strict) with pnpm, Vitest, and ESLint. Requires Node 22 (`.nvmrc`) and pnpm (pinned by the `packageManager` field in `package.json`). Run from the repo root:

```text
pnpm install --frozen-lockfile   # install (CI uses this; plain pnpm install locally)
pnpm dev                         # dev server
pnpm typecheck                   # tsc --noEmit
pnpm lint                        # ESLint
pnpm test                        # Vitest, single run
pnpm build                       # production build
```

The `app` job in `.github/workflows/ci.yml` runs typecheck, lint, test, and build on every PR.

## Quality gates (non-negotiable)

- Never bypass checks: no `--no-verify`, no skipped CI runs, no deleting or weakening tests to make a run green
- A failing test means fix the code. Change the test only when it encodes outdated behavior, and explain why in the PR body
- `main` is protected: all work lands via PR with CI green. Red CI = stop and fix before any new work
- The Claude review bot comments on every push and its `claude-review` check fails on a P1. Read the comment for your head commit and fix every P1 in the same PR before merging. Agents never add the `claude-review-override` label, on any PR. It counts only when someone other than the PR's author adds it after reading the finding. The bot ignores it when the author's account (which the author's agents also use) or a bot added it, and the P1 keeps failing the check. A comment that says the push was not reviewed is not an all clear
- No new dependencies without a pinned version and a one-line rationale in the PR description. Never edit lockfiles by hand
- Secrets live in `.env` only (copy `.env.example`, gitignored). Never commit keys, never log them. A task that needs a new secret documents it in `.env.example` in the same PR
- Stay in scope: no opportunistic refactors, no touching `ideas/` history

## When app code lands

The first PR that adds application code must, in that same PR: set up the project (Next.js, TypeScript strict), wire `tsc --noEmit` + ESLint + the app test runner into `ci.yml`, and record its install/build commands here. App code that CI cannot validate does not get committed.

## Rules

- Commit in small, logical units: one concern per commit (agent guidance, lint config, tests, CI, templates). Never one giant batch
- `ideas/evaluated.md` is append-only history. Never rewrite past rows or scores
- `info/restrictions.md` ban list governs any new idea content
- Use `skills/property-based-testing/SKILL.md` for any commit that touches production code or fixes a bug
- New ideas go through `skills/evaluate-idea/SKILL.md` before any build talk
- Never commit secrets. This is a public repo
