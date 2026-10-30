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

### Conversational intake

`/intake/conversation` is the primary path through the intake: talk or type,
one question at a time. Both input modes hit the same route
(`/api/conversation/turn`), share the same extraction and persistence, and
redact private values before anything is stored or shown — the mic hears it,
the screen keeps it private. Spoken turns are captured in-browser
(`MediaRecorder`), decoded and downsampled to 16 kHz mono PCM WAV in-browser,
and transcribed server-side by Meta's `muse-voice-transcribe-1.0`. Assistant
replies are subtitled in the transcript and spoken: through Gemini TTS
(`gemini-2.5-flash-preview-tts`, set `GEMINI_API_KEY` in `.env`) when
configured, otherwise through the browser's built-in `speechSynthesis`. The
step-by-step wizard stays reachable as the fallback from the chat and from
every error state.

### Benefit match

After a few answers, the conversation page shows the ranked match
(`/api/match`, read-only over the session's stored answers): programs that
**may be worth pursuing**, never a determination. Every reason and every
requirement on a card (documents, steps, deadlines, renewals) links to its
official source with a retrieval date and the knowledge-base entry version.
Unknown or unverified answers surface as an explicit "to resolve" list —
nothing is inferred from them — and stale or withdrawn knowledge-base
entries are never presented. A plain-language explanation of the top match
is generated from that entry's facts alone and passes the banned-claim and
grounding checks before it renders.

### Renewal tracker

`/renewal` (linked from the end of the conversation, the wizard's review
screen, and the home page, each asking "Already have coverage?") keeps track
of a renewal. It shows what the program publishes about renewal, from the
pilot's knowledge-base entry in `kb/pilot/`: how often renewal happens, the
January 1, 2027 change and who it does not affect, how long a person has to
answer a renewal letter, what happens if coverage ends, the steps, and the
official links, each labeled "From NC Medicaid" with its source, retrieval
date, and entry version. The person can enter a due date or deadline from a
renewal letter, the date on a letter that said their coverage was approved
or renewed, or say they don't know. Their date is labeled "You told us"; a
date worked out from an approval date and the published schedules is
labeled "Estimate, not an official date". For an approval date the page
asks one optional question, whether the person is between ages 19 and 64,
and leaves out the 6 month estimate when the answer is no.

The saved reminder never leaves the device. The date is sealed with AES-GCM
in the browser under a non-extractable key kept in IndexedDB, and read back
only after every layer validates; key and reminder are always read and
written together, so several open tabs cannot corrupt each other. From 30
days before a date, on the day, and from the moment any date has passed
until the person changes it, a banner at the top of every page except the
tracker, which shows the same status, says so. The banner does not name the
program, since anyone who uses the device can see it, and once a date has
passed it says the person can change the date or remove the reminder in the
tracker if their renewal is done. A saved reminder that cannot be read is
announced, never dropped silently. Browsers can clear site data
on their own, so the page also builds a calendar file (`.ics`) in the
browser, the reminder that lasts: alerts at 9 AM 30, 7, and 1 days before,
marked private, and no program name or link in its title, notes, or alerts,
so a synced event carries only the neutral title, the date, and a pointer
to the tracker on the device where the file was made. The file is a plain
copy of the date that the person chooses to download, and their calendar
app may sync it. Each event keeps one UID with a SEQUENCE that
rises with every file, so a calendar app that honors UIDs can update it;
events a newer file leaves out are not removed, so the download notice asks
people to delete old ones. No route, log, analytics call, or model call
receives the date; `src/lib/renewal/no-network.test.ts` scans for and traps
every way it could.

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

### Production

The production deployment (https://meta-hack-omega.vercel.app) runs on Vercel
with a managed Vercel Postgres store. Its DSN lives only in the Vercel project
env (`DATABASE_URL`, set through the Vercel dashboard), and env changes apply
to new deployments only. Apply schema migrations to it from a machine that has
the DSN — the same idempotent runner, pointed at production. Load the DSN from
a file rather than pasting it inline, so it never lands in shell history:

```bash
DATABASE_URL="$(cat /path/to/prod-dsn.txt)" pnpm db:migrate
```

Keep the DSN out of the repo: never commit, log, or paste it anywhere.

## Rules that shape everything

- **New work only** — demo shows only what was built during the event. Unclear contribution = disqualification
- **Public repo**, max team of 4, one submission per team
- Must fit a problem statement AND genuinely use Meta Model API / open-weight models — pass/fail gate before scoring
- 3-minute demo video is the primary judging artifact

## For agents

- `AGENTS.md` has the conventions, quality gates, and validation commands
- `main` is PR-gated: CI (markdownlint + integrity tests) must pass to merge. Direct pushes are rejected
- Droid auto-review (GLM 5.3 Flash, max reasoning) comments on every non-draft PR; `@droid <instruction>` in a PR comment triggers an agent run (currently against the default branch, not the PR head — tracked in hack-10)
- The Claude review bot reviews every push to a PR and owns the `claude-review` check (see below)
- New ideas go through `skills/evaluate-idea/SKILL.md` before any build talk
- `ideas/evaluated.md` is append-only history, never rewrite past rows

## Claude review bot

`.github/workflows/claude-review.yml` runs `scripts/claude_review.py`, which reviews every push to a pull request with Claude Opus 5.5, including the later pushes that the Droid review never sees. It keeps one comment per PR up to date with the commit it reviewed, the P1, P2, and P3 findings, every file it did not review, and the token count and cost. While a push is being reviewed, that comment says the push is not reviewed yet, so an old all clear never stands for new code.

The rubric is `.github/claude-review/rules.md` (P1 must fix before merge, P2 should fix soon, P3 nit), and the model also reads `AGENTS.md`. The workflow runs on `pull_request_target`, so GitHub always takes the workflow, the script, and the rules from the base branch, and a PR cannot change the reviewer that judges it. Rule changes take effect once they merge. The job never checks out or runs PR code and reads the PR only through the GitHub API, which is what makes `pull_request_target` safe here, since the job holds the review key. Keep it that way. The PR text and diff go to the model as untrusted data. Lockfiles, binaries, generated assets, data files, and secret files are never sent, and values that look like secrets or personal data are redacted before anything leaves the runner.

### The check and the override label

The `claude-review` check fails only when the review finds a P1 and the PR does not have the `claude-review-override` label. Add the label only after a person has read the P1 and decided the PR can merge anyway. Removing it makes the check fail again. Adding or removing any label, editing the PR, reopening it, or re-running the job checks the stored verdict for the head commit again without calling the model, so the result for a commit only changes with a new push or a change to the reviewer itself.

Errors the script can handle (an Anthropic or GitHub error, a timeout, a refusal, malformed output, a missing key) never fail the check. The job passes with a warning, and the comment says the push was NOT reviewed. A failure before the script starts (checkout, Python setup, or the SDK install) or the 20 minute job timeout does fail the job, so re-run it. Drafts are not reviewed until they are marked ready. PRs from forks are skipped, and GitHub counts that skipped check as passing, so a person has to review fork PRs.

### Setup and cost

The workflow reads the `ANTHROPIC_REVIEW_KEY` repo secret (Settings, Secrets and variables, Actions). Create the key in an Anthropic Console workspace with a monthly spend limit. Without the secret the job passes with a warning and posts no new comment. Runs that Dependabot starts get Dependabot secrets instead, so add the same key under Dependabot secrets too, or Dependabot PRs pass without a review.

A review of a typical PR here costs about $0.10 to $0.40, based on dry runs of PRs 21, 33, and 37 (9k to 30k input tokens at $4 per million, plus an assumed 3k to 12k output tokens at $20 per million). The diff budget of about 150k tokens and the 32k output limit keep one model attempt under about $1.40. If a refusal hands the review to the fallback model, both attempts together stay under about $3. Checking a stored verdict again costs nothing. Every comment shows the real token count and cost.

To try it on an existing PR, open Actions, pick Claude Review, and run the workflow with the PR number. A manual run reviews the PR and updates its comment, but it always passes and never changes the PR's own check, because GitHub reports a manual run on the default branch. Locally, a dry run fetches the real PR, prints the prompt size, the cost estimate, and the comment it would post, and never calls the model or writes to GitHub:

```text
python3 scripts/claude_review.py --repo meta-ai-hackathon/meta-hack --pr 37 --dry-run
```

To make agents wait for the review before they merge, add `claude-review` to the required status checks in the branch protection for `main`.

## Related

Obsidian vault notes: `my knowledge base/meta hackathon/` (homepage, event guide, links — mirrored here).
