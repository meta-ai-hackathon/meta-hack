# Tenet

Tenet is a benefits navigator that helps a North Carolinian apply for **Medicaid** (the state's DHB-5200 application) and **SNAP** food assistance (the state's DSS-8207 application). Instead of a stack of paper, one guided conversation — spoken or typed — asks plain-language questions, captures each answer once, and prepares both filled applications for you to review, sign, and submit yourself; you can leave and resume anytime. Your answers stay on your device, and nothing is sent anywhere without your explicit consent. Every number that lands on a form is computed by deterministic rules, never an AI guess. And the output stays honest by construction: a prepared application is never a submitted one, Tenet never promises an outcome, and eligibility is decided solely by the agency.

Built for the Meta Global AI Developer Hackathon (Oct 26 – Nov 4, 2026) — see [Status](#status).

## How the app works

A newcomer walks this journey end to end:

1. **Choose how to start.** Voice the whole way, voice with the option to switch to typing at any point, or the step-by-step wizard — all first-class paths through the same journey.
2. **Answer the quick questions.** Tenet computes the questions the applications actually still need, from the field registries of the two real forms — when the computed list is shorter than the full intake, the stage shows an honest "N of M" counter. Questions arrive in small grouped cards; sensitive ones (health, disability, pregnancy, and similar) come last, marked optional, each with a "why we ask" note and a skip affordance. Skipping never blocks the journey.
3. **Talk it through.** One continuous conversation captures the rest — no per-question record/stop ritual; you may answer several questions in one breath, and replies acknowledge what you said before asking the next thing. The step-by-step wizard stays reachable at every point as the typed path.
4. **Add your income.** Type it in yourself — a rough idea is okay — or upload your tax return (IRS 1040): the numbers are read by a deterministic parser, never an AI, the file itself is never stored, and you confirm or correct anything before it saves.
5. **See what may be worth pursuing.** After a few answers, a ranked match (read-only over your stored answers) shows programs that may be worth pursuing — never a determination. Every reason and requirement on a card links to its official source with a retrieval date; stale or withdrawn entries are never presented; unknown answers surface as an explicit to-resolve list, and nothing is inferred from them.
6. **Review the prepared forms.** The review is the prepared-package view: every field with its state (pre-filled / still needed / not applicable) and its provenance, an honest coverage summary of the form's fillable fields, and a to-resolve list of everything still needed. Contradictory answers inside a mapped Yes/No pair or check-one group are flagged for you to resolve — never silently picked.
7. **Preview, sign, download — then submit yourself.** The filled form is generated in your browser, on your device, from the answers the page already holds, and nothing about it is persisted server-side. You type your signature fresh when you sign; it is never stored and never reused. Tenet prepares — you review, sign under your own name, and submit to the county office yourself; Tenet never signs, certifies, or submits on your behalf. When you report that you have submitted, the app purges your session data and shows the purge on screen.

### Privacy, where it matters

- **Consent comes first.** A plain-language consent surface precedes the first send and names what leaves the device, to which provider (the Meta chat model and Meta speech-to-text; ElevenLabs reads the replies aloud), and for what, with links to the vendors' data-handling terms. Voice sits behind its own additional toggle. Declining never blocks you: typed turns with AI sharing declined complete the whole journey with zero sends.
- **Private answers stay private.** Answers to private questions are redacted before anything is stored, shown, or spoken — the mic hears it, the screen keeps it private.
- **The downloaded form is yours.** The download happens only on your action, the filled file is generated on your device, and no copy is kept server-side.

### Two applications from one interview

One interview prepares both applications from the same answers: the Medicaid **DHB-5200** and the SNAP application, North Carolina's official **DSS-8207** (Food and Nutrition Services). Every answered question carries over to both form registries, and no answered question is asked twice. On the results surface, an honest "Also prepare your SNAP application" entry point opens the DSS-8207 review, with the same coverage arithmetic, provenance labels, and to-resolve list as the DHB-5200. SNAP is decided solely by the county DSS office, and the framing stays honest: whether it may be worth pursuing is for you to judge — the app prepares, you review, sign under your own name, and submit.

### Work-requirements questions (Civilla-adapted)

The quick-questions stage carries North Carolina's Medicaid work-requirements questions, worded from Civilla's user-tested public templates — with visible credit on the stage's "About these questions" affordance ("Question wording adapted from Civilla's public work-requirements templates, [civilla.org/work/hr1](https://civilla.org/work/hr1/)"). The same affordance links the state's own resource: the official [Work and Community Engagement Requirement](https://medicaid.ncdhhs.gov/beneficiaries/impact-hr-1-and-federal-changes-medicaid/work-and-community-engagement-requirement) page on the NC Medicaid (NCDHHS) site.

How the stage treats them:

- The exemption screen and the other-situations screen (student status, the $580/month household-income screen, medical travel, hospital care, applied-last-month) ask once in plain language. The work-activity reporting section (who / activity types / hours last month) appears only when no exemption, income, or student path applies — the question spec's skip conditions decide through the same deterministic flow engine as every other question.
- The $580/month screen is pre-answered "Matched for you" from the income answers already captured, by a documented deterministic comparison in the intake engine — never an AI — and you confirm or correct it before anything saves.
- The sensitive items (pregnancy, drug/alcohol treatment and disorder, disability, mental health, serious health condition, incarceration, foster care, 100%-disabled veteran rating) render last in the private group, marked optional, each with a "why we ask" note and a skip affordance.
- HARD LINE: the app helps people report. It never states or implies that anyone is exempt from, or satisfies, a work requirement — the strongest framing it carries is "you may not need to report work activities — the state decides".

## Run it locally

### Prerequisites

- **Node 22** — pinned in `.nvmrc` (CI runs 22)
- **pnpm** 10 — pinned by the `packageManager` field in `package.json` (`corepack enable` provides it)
- **Docker** — for the Postgres database via `docker compose`

### Install and start

```text
docker compose up -d postgres      # Postgres 17 on localhost:5432
pnpm install                       # CI uses --frozen-lockfile
cp .env.example .env               # then fill in the values
pnpm db:migrate                    # apply migrations to DATABASE_URL
pnpm dev --port 3100               # http://localhost:3100
```

Every key lives in `.env` (gitignored — never commit it). `.env.example` documents each one: `DATABASE_URL` for Postgres, `MODEL_API_KEY` for the conversation model, `VAULT_ENC_KEY` for the encrypted answer vault (without it the vault fails closed), and optionally `ELEVENLABS_API_KEY` for spoken replies (without it the app uses the browser's built-in voice and says so).

### Checks

App checks — CI runs them on every PR:

```text
pnpm typecheck                     # tsc --noEmit
pnpm lint                          # ESLint
pnpm test                          # Vitest, single run
pnpm build                         # production build
```

Repo and docs checks (after `python3 -m pip install -r requirements-dev.txt`):

```text
npx markdownlint-cli2 "**/*.md"
python3 -m pytest tests/ -q
python3 -m mypy scripts/ tests/
```

### Smoke-check a deployment

`pnpm walkthrough` drives full user journeys over HTTP against a running app — the local dev server by default, or any deployed URL — and exits nonzero if it sees a banned promise, leaked private data, or a broken step:

```bash
pnpm walkthrough                                    # the step-by-step journey on localhost:3100
pnpm walkthrough --mode conversation                # the typed conversational journey
pnpm walkthrough --mode sprint --consent declined   # the full journey, zero-send path
pnpm walkthrough --url https://your-deployment      # any deployment
```

The four modes, the violation detectors, and the exit codes are described in [docs/status.md](docs/status.md).

## Repo map

| Path | What it is |
|---|---|
| `src/` | **Tenet** — the app (Next.js App Router, TypeScript strict) |
| `specs/question-spec/` | The intake question spec the app and its tests are built from |
| `kb/forms/` | The reviewed form registries for the DHB-5200 and DSS-8207 |
| `migrations/` | Plain-SQL schema migrations, applied by `pnpm db:migrate` |
| `scripts/` | Link checker, Meta API smoke test, walkthrough CLI |
| `docs/` | Deployment, save-and-resume, accessibility baseline, runbooks, and the project [status](docs/status.md) |
| `demo/` | Demo video script and filming materials |
| `info/` | Hackathon event reference material (event guide, links, grading, restrictions) |
| `ideas/` | Historical idea evaluation record (append-only) |
| `skills/` | Agent-runnable repo skills |
| `tests/` | Python checks over repo markdown and the data model |
| `.github/` | CI workflows, the Claude review bot, issue and PR templates |
| `architecture.md` | The build contract: pipeline stages, invariants, quality gates |

## Status

Tenet was built for the Meta Global AI Developer Hackathon (Cerebral Valley), Oct 26 – Nov 4, 2026 — a solo entry on the indie track. The app is feature-complete for the demo; the detailed status, the event timeline, deployment notes, and process references live in [docs/status.md](docs/status.md).

Pointers for agents and contributors:

- Conventions, quality gates, and app commands: [AGENTS.md](AGENTS.md)
- The review-enforced privacy and honesty rubric: [.github/claude-review/rules.md](.github/claude-review/rules.md)

## Legal and privacy

Tenet handles sensitive personal information, so privacy and honesty rules are first-class and review-enforced. This README links the rules rather than restating them: the canonical, review-enforced statement is [`.github/claude-review/rules.md`](.github/claude-review/rules.md), and the product-owner policy is the [Legal section of AGENTS.md](AGENTS.md#legal). Where readings of those rules ever disagree, a person resolves the disagreement.

One open decision, owned by a person, is recorded here for honesty: the consent-based send rule this app ships behind and the stricter no-exception rule in `.github/claude-review/rules.md` conflict and must be reconciled before the consented channels are promoted to real users; until then the zero-send path is the default recommendation.
