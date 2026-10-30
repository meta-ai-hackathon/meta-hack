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
- The Claude review bot comments on every push and its `claude-review` check fails on a P1. Read the comment for your head commit and fix every P1 in the same PR before merging. Never add the `claude-review-override` label yourself; only a person adds it, after reading the finding. A comment that says the push was not reviewed is not an all clear
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
- Legal and privacy rules are non-negotiable: read the Legal section below before touching intake, voice, forms, or submission code

## Legal

Product legal and privacy policy, stated as rules an agent can check. This is the product owner's directed policy, not legal advice and it has not been reviewed by counsel. A change that needs to depart from any rule here first needs the owner's decision recorded on its Linear ticket; never silently relax a rule to make a feature work.

- Never state or imply eligibility determinations or outcome promises: never say or suggest that a person qualifies, will be approved, or will receive anything. Eligibility is decided solely by the agency. Never weaken the banned-claims gate (patterns, copy, or tests) to get a screen to pass; permitted framing is "this may be worth pursuing" with source-linked reasons
- Filling government benefits forms from an on-device vault is permitted; data leaves the device only via the fax at the end, and never anywhere else: no analytics, no error trackers, no logs, no other APIs. The current server-side vault does not satisfy this; never describe it as privacy-preserving until a zero-knowledge store exists (HACK-87)
- Never send PII to any API without explicit user knowledge and consent, and then only for voice and the fax. Consent is a distinct, informed, affirmative step naming what is sent, to whom, and for what, shown before the first send. Reading or filling from the on-device vault is local and needs no API consent. Consent refusal never blocks the application journey (HACK-81). This consent-based rule is the owner's recorded decision; `.github/claude-review/rules.md` states a stricter no-consent-exception rule, and the two texts must be reconciled by a person — never treat one as silently overriding the other, and never enable a voice or fax channel until they agree
- Never act as the applicant's authorized representative. The user previews the filled application, signs it under their own name, and submits it themselves. The fax is only the user's instructed sending mechanism after their own submit action plus explicit third-party-fax consent; the app never signs, certifies, or submits on anyone's behalf (HACK-66 as narrowed, HACK-75)
- Use only an ephemeral fax vendor verified to retain nothing after transmission, with the verification evidence recorded before integration (HACK-89). The fax confirmation is the only artifact retained (plus per-fax cost); after confirmation the app purges the user's answers and shows the purge on screen (HACK-80). Rehearsal and synthetic traffic goes to test destinations only; never transmit it to a real agency number
- Income-verification data is consent-bound end to end: bank and payment pulls happen only after their consent (HACK-92). Statements and transactions are PII: never send them to an LLM, never log them, and never store them anywhere server-side — they are held only on the user's device (or encrypted with a key that exists only there) and leave it only inside the consented fax transmission. Compute every number that lands on a government form with the deterministic rules engine only; an LLM never computes, rounds, classifies, or estimates such a number (HACK-86)
- On camera and in evidence, use synthetic or rights-cleared data only unless a real person's explicit public-use consent is documented (HACK-58). Never present manual help as a delivered product outcome, and never derive current eligibility rules or thresholds from legacy form illustrations. Label rehearsal and synthetic segments as such
- Keep secrets and real people's information out of the repo, PRs, tickets, and logs, including any agency number beyond the publicly published one. This extends the Quality gates secret rule to the legal record
