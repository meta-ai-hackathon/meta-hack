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

## Environments

- Every required key is listed in `.env.example`. Real secrets live only in `.env` (gitignored) or host environment settings
- API-routed models today: Muse Spark (chat), Muse Voice Transcribe (STT), the TTS provider behind the speak route. Serving an open-weight model on a partner (for example Baseten, HACK-18) is tracked separately and does not block the demo

## Quality gates

CI gates every PR (markdownlint, integrity tests, typecheck, lint, and app tests). Rules in `AGENTS.md`, including the Legal section, are non-negotiable.
