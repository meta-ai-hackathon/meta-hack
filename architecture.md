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
- **Upload your tax return** — `POST /api/intake/tax-return` parses an IRS 1040 PDF deterministically in memory (no storage, no LLM, no outbound calls; wire size capped pre-parse and decompressed size bounded per FlateDecode stream before the parser loads anything). It returns typed findings plus `monthlyDerived` — a PRIOR-YEAR AGI ÷ 12 proposal (null for negative or non-finite AGI, never a confident 0) — which the UI always presents for confirm-or-correct, never as computed current monthly income. Findings carry "From your tax return" origin badges; nothing saves until the person confirms or corrects through `POST /api/intake/tax-return/confirm`, which vouches entries into the standard answer store (action `confirm` only for question ids the stage UI actually proposed; provenance `tax_return`, or `user` on correction). A re-upload replaces the prior findings. The parser keeps two failure layers apart: a genuine content verdict (scanned / non-1040 / garbage bytes) gets the honest-unreadable fallback, while a failure to LOAD the PDF engine itself (module or worker chunk — bundler/runtime breakage) surfaces as the distinct internal taxonomy error, never as "we couldn't read it"; `pdfjs-dist` is a server-external package precisely so its worker chunk resolves from node_modules.

There are no bank or payment-pull cards and no promises of future integrations; the consent-gated pull line in the pipeline table above stays a separate, unbuilt track (HACK-92).

## Work-requirements questions (milestone work-requirements)

Medicaid work requirements (CMS IFR June 2026, effective 2027-01-01) have no DHB-5200 rev 2020 fields, so the questions are spec-only: 19 questions in `specs/question-spec/generic-questions.json` (v0.2.0), listed for `nc_medicaid` in `program-requirements.json` (v1.1.0) with the IFR rationale, not linked to any forms-registry field — the state decides what they become. Wording is Civilla's plain-language, user-tested insert (credited in the PR; retrieved 2026-11-01).

The questions follow Civilla's two-section design, encoded entirely as spec `skip_conditions` so the existing `isQuestionVisible` flow engine does the hiding — no flow fork: the work-activity reporting section (`wr_work_activity_who`/`types`/`hours`) is asked only when no exemption path applies (none of the exemption/screen options selected, not a full- or half-time student, and no "yes" on any sensitive situation) and the $580/month income screen says income is below the threshold. The screen itself (`wr_income_580`) has its match DEFINED by `src/lib/intake/work-requirements.ts` — a pure, deterministic `matchIncome580` over already-captured income answers that proposes only what is certain in BOTH directions: "yes" when the counted sources' minimum month (floor factors) crosses $580; "no" only when every source is accounted for (nothing unconvertible, no income_sources option the amount questions never read) and even the average-month conversion (ceiling factors) stays under — and asked directly whenever certainty is missing. The matcher is engine-only in this milestone: no stage surfaces it yet; part 2 wires the "Matched for you" confirm-or-correct surface. It is never an LLM call (HACK-86) and never a compliance statement: the app never says anyone is exempt or meets the requirement; the answers only feed the form. Sensitive questions are `pii: true` in the spec, route through the vault, and are redacted in telemetry (the new digit-bearing ids also tightened `normalizeKey`'s camelCase redaction). The sensitive questions are captured through the select surfaces that carry no model in the loop (the quick-questions stage and the wizard, via the wizard's answer route); the rehearsal harness captures them the same way in its quick-questions phase. The screens are household-level (Civilla's own simplification): one member's exemption hides the reporting section for the household, recorded in the program-requirements rationale — per-person exemption modeling is deferred to the state's own decision.


## Environments

- Every required key is listed in `.env.example`. Real secrets live only in `.env` (gitignored) or host environment settings
- API-routed models today: Muse Spark (chat), Muse Voice Transcribe (STT), the TTS provider behind the speak route. Serving an open-weight model on a partner (for example Baseten, HACK-18) is tracked separately and does not block the demo

## Quality gates

CI gates every PR (markdownlint, integrity tests, typecheck, lint, and app tests). Rules in `AGENTS.md`, including the Legal section, are non-negotiable.
