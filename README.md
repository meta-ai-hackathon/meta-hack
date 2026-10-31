# Meta Hack

Repo for the Meta Global AI Developer Hackathon (Cerebral Valley) — Oct 26 to Nov 4, 2026. $1M prize pool, solo entry, indie track.

**Status: Benefits Navigator build in progress. Submission due Wed Nov 4, 9 PM ET (internal target 6 PM ET).**

## Where we stand

- **Product:** Benefits Navigator (app contract in `architecture.md`; feature map in `feature.md`) — a guided North Carolina **initial MAGI Medicaid** application journey. One persona anchors the demo: a North Carolina resident with current self-employment (LLC) income and no tax return showing it yet, plus stale prior-year internship W-2 income. Earlier footage-search and rescue-vertical ideas (`ideas/`) are historical, not the build.
- **Two problems, one product:** applicants face high-stakes, paperwork-heavy applications; state offices face H.R. 1 six-month redeterminations with income verification funded at roughly $200M across all 50 states. At that budget neither a legacy system nor manual caseworker review is affordable, so the product automates consented income verification and form preparation instead.
- **Privacy rules that shape every build decision** (recorded as agent rules in the Legal section of `AGENTS.md`): answers live on the user's device and fill forms from an on-device vault; the only way form data leaves the device is the user-consented fax at the end; PII goes to an API only with explicit informed consent (voice and the fax); the app never acts as the applicant's authorized representative; after the fax confirmation, the app shows it purging the user's answers. Current work queue: HACK-17 (verified NC Medicaid facts), HACK-74 (PDF pipeline), HACK-75–76 (fax and income-verification lines), HACK-80–82 (purge, consent gate, on-device store), HACK-86 (rules engine) in Linear.

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

**Consent comes first** (HACK-81): a plain-language consent surface precedes
the first send. It names what leaves the device, to which provider (the
Meta chat model and Meta STT; Gemini TTS for replies), and for what, with
links to the vendors' verified data-handling terms — and typed-only +
subtitles is the zero-send path that still completes the whole journey.
Voice sits behind its own additional toggle. A declined consent never
blocks the application.

### Prepared forms

The application form itself is part of the conversation. A committed,
reviewable form-registry entry (source URL + retrieval date + version)
drives three surfaces:

- **Form-driven questions** join the conversation; fields mapped to
  questions you already answered pre-fill from the session's answers ("we
  already know this"), and the flow's skip logic applies to them.
- **Review** (`GET /api/forms/<formId>/review`) is the prepared-package
  view: every field with its state (pre-filled / still needed / not
  applicable) and provenance, a to-resolve list of everything still needed,
  and the ordered handoff steps — the app prepares, you review and submit
  yourself.
- **Download** (`POST /api/forms/<formId>/fill`) fills the registered
  template and returns the PDF as an attachment, generated on the fly and
  never persisted server-side. Unknown answers stay visibly blank and are
  listed as to-resolve.

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

### Walkthrough CLI

`pnpm walkthrough` drives full user journeys over HTTP against a running app —
the local dev server by default, or any deployed URL (Vercel production or a
PR preview). No browser and no extra dependencies:

```bash
pnpm walkthrough                                              # wizard, localhost:3100
pnpm walkthrough --mode conversation                          # the v2 conversational journey
pnpm walkthrough --mode form                                  # the v2 form-driven journey
pnpm walkthrough --url https://meta-hack-omega.vercel.app     # any mode, production
```

Three modes:

- **wizard** (default): create a session, answer the intake questions with a
  realistic mix (known answers that trigger skips and follow-ups, "I'm not
  sure" answers, and best-guess "not verified" answers), observe the skip
  behavior after every answer, save, exit, resume from the session token, and
  print a timestamped transcript whose labels match the app's own honest
  statuses ("You told us", "You're not sure", "Answered but not verified").
- **conversation** (v2, text mode): the full journey through the
  conversation — typed turns driving the real extraction model with the same
  tri-state mix, the benefit match, the prepared-form review with the skip
  behavior, save, exit, resume via the session token (the stored transcript
  and state must agree), then the PDF download leg. Typed turns send the AI
  consent receipt (voice off) — the same grant the consent surface's typed
  path gives — and the turns pace themselves under the server's per-minute
  turn cap. Use `--timeout 90000` semantics (the default for this mode):
  each typed turn runs two live model calls.
- **form** (v2): the committed sample form's questions asked through the
  conversation, mapped fields pre-filled from the session's answers, the
  review's to-resolve list asserted consistent with the served state, then
  the filled-PDF download.

While it walks, the CLI scans every response for violations: banned promise
language (including on assistant turns specifically — a reply that promises
an outcome means the app's own gate failed to fire), client-visible private
(`pii: true`) content — a value shipped under a private question, a submitted
private value echoed back in any payload field (subtitles, transcripts,
state, cards), or a typed private value that survived redaction into the
delivered transcript. Exit codes: `0` clean journey, `1` violation detected
(the transcript names what and where), `2` journey error (bad URL, failed
request, unexpected question). The detectors are unit-tested with committed
fixtures in `scripts/fixtures/walkthrough/`, so the checks provably bite.
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
