# Architecture — footage search (working title)

The build contract for the hackathon project. Sub-agents: read this before writing any code. A PR that changes pipeline semantics must update this doc in the same PR, or it gets rejected.

## Product contract

Upload security footage, type what you're looking for in plain English ("guy in red hoodie with a backpack", "the white van's second visit"), get the exact clips in seconds, plus a timeline of where that object appeared across all cameras. Retrieval, not judgment.

## Pipeline stages

| Stage | Model / owner | Runs where | Output |
|---|---|---|---|
| Perception | SAM 3.1 (self-hosted) | Modal GPU | Masks + persistent track IDs per clip, cached once |
| Labeling | Muse Spark (API) | Meta Model API | One call per object crop → short label ("white SUV, pallets") |
| Timeline | ours | app service | Track events → queryable store (appear / disappear / move / meet) |
| Reasoning | Muse Spark + Muse Wonder | Meta Model API | Answers over compressed track tables, never raw video |
| Reports | fine-tuned open-weights (LoRA) | Modal | Incident summary from track tables |
| Delivery | ours | Next.js | Time-scrubber UI, segmentation overlay, query box |

Meta owns the model rows; the two "ours" rows are the technical-depth score.

## Invariants (agents do not break these)

- Perception is cached per clip. The LLM never re-watches raw video — that burns the $150 credit budget
- Reasoning reads only compressed track data
- Track IDs persist across frames and cameras. No per-frame re-identification, no identity search ("find John"), no suspiciousness scoring — attribute search and concrete-event triggers only (see `info/restrictions.md` gray zones)
- Every stage runs locally against fixtures before demo recording; a stage that only works live is a broken stage

## Environments

- Every required key is listed in `.env.example`. Real secrets live only in `.env` (gitignored)
- API-routed models: Spark, Wonder, Image, Voice Transcribe. Self-hosted: SAM 3.1, the LoRA report writer (Modal)

## Quality gates

CI gates every PR (markdownlint + integrity tests; typecheck and app tests are added by the PR that introduces app code). Rules in `AGENTS.md` are non-negotiable.
