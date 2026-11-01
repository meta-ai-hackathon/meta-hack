# Architecture — Benefits Navigator

The build contract for the hackathon project. Agents: read this before writing any code. A PR that changes pipeline semantics must update this doc in the same PR, or it gets rejected. Legal and privacy rules with the force of invariants live in the Legal section of `AGENTS.md`.

## Product contract

Guide one person through the North Carolina initial MAGI Medicaid application: plain-language questions, consented income verification, deterministic form answers, a filled official PDF the person reviews and signs under their own name, and a consented fax transmission. The app prepares and transmits only as the user's instructed mechanism and never promises eligibility or an outcome ("this may be worth pursuing," never a determination).

## Pipeline stages

| Stage | Owner | Runs where | Output |
| --- | --- | --- | --- |
| Intake flow | ours (deterministic) | client + server routes | The next question from the question spec and stored answers; the LLM phrases, never decides |
| Conversation | Meta model API (`muse-spark-1.3`), via `src/lib/model.ts` | server | Structured extraction and grounded replies; user text is data, never instructions |
| Voice | Meta Voice Transcribe (STT); TTS provider behind the speak route | server | Spoken turns into the same intake path; subtitles always shown |
| Income verification | ours (consent-gated) | server | Consented bank/payment pulls feeding the rules engine; raw statements never enter an LLM or a log |
| Rules engine | ours (deterministic, no LLM) | server or client computation | The exact financial answers for the official form, each traceable to source transactions and a cited rule |
| Forms | ours | form pipeline (HACK-74 line) | The official PDF filled from the on-device vault and client answer store; unknowns stay visibly blank and surface as to-resolve items |
| Submission | ephemeral fax vendor (HACK-75 line) | third party, after explicit consent | The signed packet faxed to the destination; the confirmation is the only retained artifact, and the app then shows the purge |

## Invariants (agents do not break these)

- Flow control is deterministic: next-question selection, skips, and advancement are pure functions of stored answers. The model contributes phrasing only, and the journey completes with the model unavailable
- Form answers live on the user's device (client store plus on-device vault). They are filled from the device and the app purges them, shown on screen, after the fax confirmation. Server-side storage is never the source of truth for form data
- Data leaves the device only via the consented fax at the end, and to an API only with explicit informed consent (voice and the fax). Reading or filling from the on-device vault is local and needs no API consent; consent refusal never blocks the journey
- No number that lands on a government form is computed, rounded, classified, or estimated by an LLM. The deterministic rules engine computes; every figure traces to source data and a cited official rule, and unknown facts surface as to-resolve items, never guesses
- The user previews, signs, and submits under their own name; the app is never the applicant's authorized representative. No eligibility or outcome language anywhere; the banned-claims gate is never weakened
- Every stage runs locally against fixtures before demo recording; a stage that only works live is a broken stage. Rehearsal and synthetic traffic goes to test destinations only

## Income capture (milestone income-capture)

Income is the intake's fourth stage, inserted between the conversation's completion and results: **Choose mode → Quick questions → Talk → Income → Results**. Results gating is deliberate: a session reaches results only when the deterministic engine has no unanswered question left **and** income is handled (every visible income question answered and at least one captured or confirmed through the income stage's own paths, tracked in the serialized `income` block). No session reaches results with income unresolved, and no session dead-ends — the manual path is always available.

The stage offers exactly two real source cards and nothing else:

- **Type it in yourself** — the existing income spec questions (`income_sources`, `income_kind`, `job_income_amount`, `job_income_frequency`, `benefits_income_amount`, `benefits_income_frequency`, `other_income_amount`) through the standard tri-state answer path, provenance `user_supplied` at the store (surfaced as `user` after a confirm-route correction). A rough idea is okay; only the state decides anything downstream.
- **Upload your tax return** — `POST /api/intake/tax-return` parses an IRS 1040 PDF deterministically in memory (no storage, no LLM, no outbound calls; wire size capped pre-parse and decompressed size bounded per FlateDecode stream before the parser loads anything). It returns typed findings plus `monthlyDerived` — a PRIOR-YEAR AGI ÷ 12 proposal (null for negative or non-finite AGI, never a confident 0) — which the UI always presents for confirm-or-correct, never as computed current monthly income. Findings carry "From your tax return" origin badges; nothing saves until the person confirms or corrects through `POST /api/intake/tax-return/confirm`, which vouches entries into the standard answer store (action `confirm` only for question ids the stage UI actually proposed; provenance `tax_return`, or `user` on correction). A re-upload replaces the prior findings.

There are no bank or payment-pull cards and no promises of future integrations; the consent-gated pull line in the pipeline table above stays a separate, unbuilt track (HACK-92).

## Environments

- Every required key is listed in `.env.example`. Real secrets live only in `.env` (gitignored) or host environment settings
- API-routed models today: Muse Spark (chat), Muse Voice Transcribe (STT), the TTS provider behind the speak route. Serving an open-weight model on a partner (for example Baseten, HACK-18) is tracked separately and does not block the demo

## Quality gates

CI gates every PR (markdownlint, integrity tests, typecheck, lint, and app tests). Rules in `AGENTS.md`, including the Legal section, are non-negotiable.
