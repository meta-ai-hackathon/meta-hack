# Meta Hack

Repo for the Meta Global AI Developer Hackathon (Cerebral Valley) — Oct 26 to Nov 4, 2026. $1M prize pool, solo entry, indie track.

**Status: Benefits Navigator built and validated — 111/111 validation assertions green, all demo-day fixes merged with CI. Submission due Wed Nov 4, 9 PM ET (internal target 6 PM ET).**

## Where we stand

- **Product:** Benefits Navigator (app contract in `architecture.md`; feature map in `feature.md`) — a guided North Carolina **initial MAGI Medicaid** application journey. One persona anchors the demo: a North Carolina resident with current self-employment (LLC) income and no tax return showing it yet, plus stale prior-year internship W-2 income. Earlier footage-search and rescue-vertical ideas (`ideas/`) are historical, not the build.
- **Two problems, one product:** applicants face high-stakes, paperwork-heavy applications; state offices face H.R. 1 six-month redeterminations with income verification funded at roughly $200M across all 50 states. At that budget neither a legacy system nor manual caseworker review is affordable, so the product automates consented income verification and form preparation instead.
- **Privacy rules that shape every build decision** (recorded as agent rules in the Legal section of `AGENTS.md`): answers live on the user's device and fill forms from an on-device vault; the only way form data leaves the device is the user-consented fax at the end; PII goes to an API only with explicit informed consent (voice and the fax); the app never acts as the applicant's authorized representative; after the fax confirmation, the app shows it purging the user's answers. All mission milestones are validated (111/111 assertions), and the demo-day fix round of Oct 31 is merged to main with CI green (PRs #87, #89, #90, #92): researched prompt endpointing for the voice journey, honest per-turn pipeline timing, a fixed-height auto-scrolling transcript pane, and the three-stage journey shell as the entry/home.

## Timeline

| Date | Thing |
|---|---|
| Wed Oct 26, 12 PM ET | Kickoff |
| Tue Oct 27 – Fri Oct 30 | Workshops (agents 101/102, Fireworks) |
| **Wed Nov 4, 9 PM ET** | **Submission due + last day to claim API credits** |
| Fri Oct 31 | Demo-day fix round merged to main (PRs #87, #89, #90, #92), all validation green |
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
| `docs/` | Deployment, save and resume, the accessibility baseline, and [`docs/runbooks.md`](docs/runbooks.md), what to do when something fails during a demo |

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

`/intake/conversation` is the primary path through the intake: a natural
voice conversation. Two entry modes — voice the whole way, or voice with the
option to switch to typing at any point; the step-by-step wizard below
remains a first-class path for anyone who declines voice. Both input modes
hit the same route (`/api/conversation/turn`), share the same extraction
and persistence, and redact private values before anything is stored,
shown, or spoken — the mic hears it, the screen keeps it private. One
continuous voice session covers the whole
sitting: no per-question record/stop ritual; utterances end by prompt
endpointing — a researched 400 ms hangover after speech ends, with the
endpoint decision landing within about a second — and the user may answer
several questions in one breath, with queued continuations carried into the
next turn. Every turn logs per-segment pipeline timings, so latency is
measured rather than guessed (a measured parallel-split probe was not
faster, so the combined per-turn call stayed). The talk stage shows the
transcript as a fixed-height scrollable pane that auto-scrolls to the
latest turn, and the entry/home page is the three-stage journey shell with
engine-gated locks.
Spoken turns are captured in-browser (`MediaRecorder`), decoded and
downsampled to 16 kHz mono PCM WAV in-browser, and transcribed server-side
by Meta's `muse-voice-transcribe-1.0`. Assistant replies acknowledge what
the person said before asking the next question; when an answer looks
unclear the model may propose a short follow-up, but a deterministic engine
validates it (banned-claims scan) and the next question stays
spec-decided. Replies are subtitled in the transcript and spoken: through
a human-sounding ElevenLabs voice (`eleven_multilingual_v2`, "Sarah"
prebuilt; configurable via `ELEVENLABS_TTS_MODEL`/`ELEVENLABS_TTS_VOICE`
env overrides; set `ELEVENLABS_API_KEY` in `.env` — it replaced Gemini TTS
on Oct 31, whose free tier allowed only 10 requests/day and silently
degraded to the OS voice), with the browser's built-in
`speechSynthesis` as the honest fallback — and a visible built-in-voice
notice when that fallback is in use. Each voice turn runs one combined
model call per turn. All of this sits behind the consent gate described
below, and the same redaction applies to what is spoken as to what is
shown. The conversation is
accessible by design: prominent live subtitles for the deaf/HoH path,
keyboard operable, reduced-motion respected. The
step-by-step wizard stays reachable as the fallback from the chat and from
every error state.

**Consent comes first** (HACK-81): a plain-language consent surface precedes
the first send. It names what leaves the device, to which provider (the
Meta chat model and Meta STT; ElevenLabs TTS for replies), and for what, with
links to the vendors' verified data-handling terms. A typed conversation
turn goes to the Meta chat model, and the consent copy says so; the
zero-send path that still completes the whole journey is the step-by-step
form with AI consent declined. Voice sits behind its own additional
toggle. A declined consent never blocks the application. (Open decision,
owned by a person: the consent-based rule above and the stricter
no-exception rule in `.github/claude-review/rules.md` conflict and must
be reconciled before this channel is promoted to real users; until then
the zero-send path is the default recommendation.)

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
delivered transcript. The value matching is exact-string (a partially
redacted or paraphrased free-text answer can pass); deep-nested payloads
fail closed as unscanned. Exit codes: `0` clean journey, `1` violation
detected (the transcript names what and where), `2` journey error (bad URL,
failed request, unexpected question). The detectors are unit-tested with
committed fixtures in `scripts/fixtures/walkthrough/`, so the checks
provably bite. Teammates can run it against any preview URL without a
browser.

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

The `claude-review` check fails only when the review finds a P1 and the `claude-review-override` label does not count. The label counts only when someone other than the PR's author adds it, after reading the P1 and deciding the PR can merge anyway. Agents never add it. The bot reads who added the label last from the PR's events and ignores it unless that was a person's own account (GitHub's account type User) other than the PR's author's, acting directly rather than through an app that uses their token, so a label from the author's account, a bot, or an app never counts. Agents act under their owner's GitHub account, so a label from the author's account could be the author's agent. On a PR a bot opened (Dependabot, an agent's app, or any workflow's `github-actions[bot]`) the label never counts either, since whoever is behind that PR could add it from their own account, so a P1 there needs a fix. When the label does not count, the comment says so and why, and the P1 keeps failing the check. For it to count, someone other than the author has to remove the label and add it again. If the bot cannot read the PR's events, or who opened the PR, the label does not count on that run, the comment says so, and re-running the workflow checks it again. Removing the label makes the check fail again. Adding or removing any label, editing the PR, reopening it, or re-running the job checks the stored verdict for the head commit again without calling the model, as long as the PR still targets the base branch that review was made against. Changing the base branch changes the PR's diff, so it gets a fresh review, and the result for a commit only changes with a new push, a new base branch, or a change to the reviewer itself.

Errors the script can handle (an Anthropic or GitHub error, a timeout, a refusal, malformed output, a missing key) never fail the check. The job passes with a warning, and the comment says the push was NOT reviewed. The one exception is an error reading the PR's events to see who added the override label. The run logs a warning and the review still stands, but the label does not count on that run, so a P1 fails the check. A failure before the script starts (checkout, Python setup, or the SDK install) or the 20 minute job timeout does fail the job, so re-run it. Drafts are not reviewed until they are marked ready. PRs from forks are skipped, and GitHub counts that skipped check as passing, so a person has to review fork PRs.

### The bot's approval

When a push to an open PR gets a review with no P1 that covered every changed file, the bot also approves that exact commit as `github-actions[bot]`, with a fixed note that points to its comment. The diff it reviews is GitHub's comparison of the exact base and head commits it read from the PR, so a push or a retarget while it works cannot put another diff under that approval. Re-checking the stored verdict on a label, edit, or reopen never approves, because anyone who can edit comments on the PR can edit the verdict the comment stores. A re-check withdraws the bot's approvals only when the stored verdict is not an all clear, and otherwise leaves an approval the review gave in place. The bot never adds a second approval to a commit it already approves. A commit whose approval did not land, for example while the org setting below was off, stays unapproved. Only a later review approves: the next push's review (for the new commit), or a fresh review of the same commit after the reviewer itself changes.

Any other result on the PR's own events withdraws every approval the bot has on the PR: a P1, even with the override label (that label is a person's call, not the bot's all clear), a review that left any changed file out (a lockfile, an image, a generated or minified file, a file over the budget), or a push that was not reviewed for any reason, including a draft, a missing key, or a run that could not read the PR or update its comment. A new review also withdraws the bot's approvals as it starts, so a run that is cancelled or times out partway leaves none standing. That includes the review a retarget starts, since the old approval was for another diff. The one exception is a fresh look at a commit whose finished review against the same base branch the comment still shows (after a reviewer change), which keeps that commit's approval until the new verdict is in.

Manual runs and dry runs never approve or withdraw. Withdrawals still follow the PR's events: when a manual run's review finds a P1 or leaves a changed file out, the bot withdraws its approval on the PR's next event. A clean verdict from a manual run never brings an approval, because the next event only re-checks it; the next push's review does. Re-running an old workflow run runs the reviewer from that run's base commit, so a run from before approvals existed never approves or withdraws.

GitHub refuses these approvals until an org owner turns on "Allow GitHub Actions to create and approve pull requests" (organization settings, Actions, General). Until then a clean run logs one notice and nothing else changes. No approval failure ever changes the check or the comment, and near the job's time limit the bot skips the approval step rather than let the job time out.

That setting is not this bot's alone. Once it is on, every workflow in the repo can approve pull requests and open them as `github-actions[bot]` with its own token. That includes workflows a PR can change, since a `pull_request` workflow such as the Droid review runs the PR's own copy of its file, with `pull-requests: write`. So with the setting on, an approval from `github-actions[bot]`, or a PR it opened, proves nothing about who decided anything. The bot treats every `github-actions[bot]` approval as its own: it withdraws them all when a review finds a P1, but it cannot stop another workflow from approving afterwards.

Branch protection on `main` requires the `lint` and `test` checks, but not approvals or the `claude-review` check, so the approval is informational today. It must never count toward required reviews. If `main` ever requires approvals while the setting is on, any workflow's `github-actions[bot]` approval would count toward them, a clean Claude review included, so the rule could be met without a person reading the PR. Keep required approvals off while the setting is on, and decide that before turning on either. Required approvals also need "Dismiss stale pull request approvals when new commits are pushed", because the bot can only withdraw an approval once its run for the new push has started.

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
