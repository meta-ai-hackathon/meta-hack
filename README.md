# Meta Hack

Repo for the Meta Global AI Developer Hackathon (Cerebral Valley) — Oct 26 to Nov 4, 2026. $1M prize pool, solo entry, indie track.

**Status: exploring phase. No idea locked.**

## Where we stand

- **Frontrunner:** footage search + the rescue vertical (merged) — "Google for your cameras" gains its mission and demo spine: the real Luna rescue in Yellowstone, with two new pillars landing with the build (reference-photo re-ID, next-search planning). Weighted ≈8.3 on the rubric, civilian framing. See `ideas/footage search.md` and `ideas/find my dog.md`
- **Evaluation rules:** every new idea goes through `info/idea judge workflow.md` before any build talk
- **Hard context:** the anti-projects list killed the military framing (OVERWATCH), sports analyst, and boxing judge. Read `info/restrictions.md` before proposing anything

## Timeline

| Date | Thing |
|---|---|
| Wed Oct 26, 12 PM ET | Kickoff |
| Tue Oct 27 – Fri Oct 30 | Workshops (agents 101/102, Fireworks) |
| **Wed Nov 4, 9 PM ET** | **Submission due + last day to claim API credits** |
| Nov 5–8 | Judging |
| Mon Nov 9, 12 PM | Closing ceremony, top 10 live final |

## Repo map

| Path | What it is |
|---|---|
| `info/event guide.md` | Full event brief (copied from the vault — single source of truth) |
| `info/links.md` | Every URL: platform, API docs, billing, models, partners |
| `info/grading criteria.md` | Pass/fail gate + scored rubric + bonus prizes |
| `info/restrictions.md` | Anti-projects list, the four banned logics, gray zones |
| `info/idea judge workflow.md` | Reusable template to score any new idea in minutes |
| `info/stack and credits.md` | The Muse family, what each model does, credit budget plan |
| `ideas/` | One file per idea considered, plus the running scorecard |
| `skills/` | Agent-runnable skills — `skills/evaluate-idea/SKILL.md` scores any new idea end to end |
| `demo/` | Demo video script and filming materials — `demo/demo-script-v0.md` is the 3-minute storyline draft |
| `architecture.md` | The build contract: pipeline stages, invariants, quality gates |
| `src/` | **Benefits Navigator** — the app (Next.js, App Router, TypeScript strict) |
| `specs/question-spec/` | The intake question spec the app and its tests are built from |
| `migrations/` | Plain-SQL schema migrations, applied by `pnpm db:migrate` |
| `scripts/` | Standalone checks — link checker, Meta API smoke test, walkthrough CLI |

## Benefits Navigator

The repo builds **Benefits Navigator**: a benefits-application companion that
surfaces uncertainty instead of hiding it. It never promises an outcome, keeps
private answers out of prompts, logs, and payloads, and lets a person leave
and resume anytime. Run it locally with Postgres on Docker:

```text
docker compose up -d postgres      # Postgres 17 on localhost:5432
pnpm install --frozen-lockfile
cp .env.example .env               # then fill in the values
pnpm db:migrate                    # apply migrations to DATABASE_URL
pnpm dev --port 3100               # http://localhost:3100
```

### Walkthrough CLI

`pnpm walkthrough` drives a full user journey over HTTP against a running app —
the local dev server by default, or any deployed URL (Vercel production or a
PR preview). No browser and no extra dependencies:

```bash
pnpm walkthrough                                              # localhost:3100
pnpm walkthrough --url https://meta-hack-omega.vercel.app     # production
pnpm walkthrough --url https://<preview-deployment-url>       # a PR preview
```

The walk: create a session, answer the intake questions with a realistic mix
(known answers that trigger skips and follow-ups, "I'm not sure" answers, and
best-guess "not verified" answers), observe the skip behavior after every
answer, save, exit, resume from the session token, and print a timestamped
transcript whose labels match the app's own honest statuses ("You told us",
"You're not sure", "Answered but not verified").

While it walks, the CLI scans every response for violations: banned promise
language and client-visible private (`pii: true`) content — a value shipped
under a private question, or a submitted private value echoed back. Exit
codes: `0` clean journey, `1` violation detected (the transcript names what
and where), `2` journey error (bad URL, failed request, unexpected question).
The detectors are unit-tested with fixtures in
`scripts/walkthrough-detectors.test.mjs`, so the checks provably bite.
Teammates can run it against any preview URL without a browser.

## Rules that shape everything

- **New work only** — demo shows only what was built during the event. Unclear contribution = disqualification
- **Public repo**, max team of 4, one submission per team
- Must fit a problem statement AND genuinely use Meta Model API / open-weight models — pass/fail gate before scoring
- 3-minute demo video is the primary judging artifact

## For agents

- `AGENTS.md` has the conventions, quality gates, and validation commands
- `main` is PR-gated: CI (markdownlint + integrity tests) must pass to merge. Direct pushes are rejected
- Droid auto-review (GLM 5.3 Flash, max reasoning) comments on every non-draft PR; `@droid <instruction>` in a PR comment triggers an agent run (currently against the default branch, not the PR head — tracked in hack-10)
- New ideas go through `skills/evaluate-idea/SKILL.md` before any build talk
- `ideas/evaluated.md` is append-only history, never rewrite past rows

## Related

Obsidian vault notes: `my knowledge base/meta hackathon/` (homepage, event guide, links — mirrored here).
