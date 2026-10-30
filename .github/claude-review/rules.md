# Claude review rules

The Claude review bot (`scripts/claude_review.py`) sends this file to the model on every push, together with `AGENTS.md`. Edit it like any other doc. The bot always reads the copy on the PR's base branch, so a change here takes effect once it merges, never inside the PR that makes it.

## Severities

### P1, must fix before merge

A P1 fails the `claude-review` check. Use P1 only when the change does one of these things.

- Leaks PII or breaks the PII boundary described below.
- Exposes a secret: a key, token, password, or connection string that is committed, logged, sent to a client, or put in a prompt.
- Opens a security hole, such as injection, a route that skips authentication or authorization, trusting client input for identity, or unsafe deserialization.
- Loses data or ships a broken migration. Migrations in `migrations/` are numbered and append only, so editing, renumbering, or deleting an applied migration is a P1, and so is a destructive change with no guard.
- Deletes or weakens tests or quality gates: removed or loosened assertions, skipped tests, CI steps removed, or a change that weakens this reviewer (its workflow, its script, or this file). The review workflow holds the review key, so making `.github/workflows/claude-review.yml` check out, install, or run code from the PR head is a P1, and so is moving it off `pull_request_target` or adding a job-level skip beyond the fork check, since a skipped run counts as a passing check.
- Breaks the honesty rules described below.
- Would break `main`: code that cannot build, typecheck, or pass the existing tests, or a required file removed.

### P2, should fix soon

Real bugs and risks that do not need to block the merge. Examples are a wrong result on an edge case, a missing error path that users will hit, new logic with no test, an accessibility regression, docs that now say the wrong thing, or a new dependency without a pinned version and a stated reason.

### P3, nit

Naming, small cleanups, and suggestions. Keep these few, and skip anything markdownlint, ESLint, or mypy already enforces.

## PII boundary

These come from `specs/question-spec/README.md` and the vault module, `src/lib/vault.ts`.

- A question marked `pii: true` in `specs/question-spec/generic-questions.json` stays on the server. Its answer never goes into a model prompt, a log line, an error message, or a client payload outside the user's own session.
- Every free text answer (`type: text` or `type: address`) is `pii: true` by rule, because people type identifying details into them.
- Only `src/lib/vault.ts` touches the `vault_entry` table, and `src/lib/intake/store.ts` is the one module allowed to use the vault API. A new importer of the vault is a P1 unless the PR explains why and updates `src/lib/vault-boundary.test.ts` to match.
- `CROSSING_ALLOWLIST` in `src/lib/vault.ts` is empty, so no vault field reaches model context. Adding a field to it is a product decision for a person, never an agent, and a `pii: true` field may never be added.
- `src/lib/intake/serialize.ts` strips every pii value before anything reaches a page, a payload, or a log.
- Logs carry no identifying fields. The ids of pii fields count as identifying, so they stay out of logs too (`src/lib/telemetry.ts`).

## Real data rules

The team adopted these on Oct 29 2026, when the demo moved to real people and real data. They apply to every change.

- No PII hits any API except a voice model and a fax API that doesn't retain any data, both with explicit user knowledge and consent. That includes the Meta Model API the app itself uses: PII never reaches any cloud LLM. A prompt builder that could include an answer, a document, or anything a user typed is a P1 unless it uses only allowlisted fields that are not PII. A voice-model or fax send without the user's explicit, informed consent — or to any other API — is a P1.
- Sensitive answers, meaning every answer plus anything from income verification, are stored or sent nowhere except the consented voice and no-retention fax APIs above. The one other exception is data encrypted on the client with a key that exists only on the user's device. New storage, logging, caching, analytics, or a third party endpoint for that data beyond those consented paths is a P1.
- The user previews and signs the application. A flow that submits, faxes, or signs for the user without that step is a P1.
- The team never acts as the applicant's authorized representative. Copy, forms, or code that makes the team or the app the authorized representative is a P1.

## Honesty rules

These come from `src/lib/honesty.ts`.

- The app never promises an outcome. Eligibility or approval determinations ("you are eligible", "you will be approved", "you qualify", "guaranteed") are a P1. Hedged uncertainty such as "you may be eligible" is fine. The banned shapes are in `BANNED_CLAIM_PATTERNS`.
- Every answer carries one of three statuses: `known`, `unknown`, or `unverified`. Hiding uncertainty, for example showing an unverified answer as confirmed, is a P2.
- Prepared is never submitted. The app sets only `draft`, `prepared`, and `handed_off`, and submission exists only as the user reported states (`user_reported_submitted`, `user_reported_decided`). Copy or code that says the app submitted an application, or that sets a user reported state itself, is a P1.

## What not to flag

- Style that the linters already enforce.
- Files the bot did not send (lockfiles, binaries, generated assets, data files, secret files, files over the budget), beyond saying they were not reviewed.
- Hypothetical problems with no path through the changed code.
