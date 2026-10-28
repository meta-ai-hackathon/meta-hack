# BlueBricks feature map — draft

**Status:** Draft v0.1 for team review. Documentation only — this authorizes no build work.
**As of:** 2026-10-27
**Source contract:** BlueBricks product & engineering specification v0.1 (not yet vendored into this repo; F-ID references point at its Section 3 feature catalog)
**Build window:** Oct 27 – Nov 4, 2026 (submission 9:00 PM ET; internal target 6:00 PM ET)

**Decisions applied (Oct 27):** BlueBricks locked as the hackathon build · Fastify + React stack · no open-weight/Muse add-ons · core demo only, public preview cut · synthetic/rights-cleared demo data only.

The P0 spine is M0–M6. The controlled demo story: enter an illustrative kitchen scenario, declare scope, explicitly confirm "remove a wall", observe a new revision carrying a source-linked professional-plans requirement that stays unresolved, review, and export a draft packet.

## M0 — Foundations and guardrails

| ID | Feature | Implements |
|---|---|---|
| BM-01 | App scaffold: TS-strict Fastify server + React client, ESLint, test runner, CI wiring | QSD-09 start |
| BM-02 | DB schema v1 + forward-only migrations (core tables) | Spec §4.5 |
| BM-03 | Contract enums and shared types (TriState, FactStatus, ProvenanceKind, FindingStatus, WorkflowState, DerivedStatus, JobStatus) | Spec §4.3 |
| BM-04 | Demo session adapter: server-provisioned isolated session/workspace, no real login | ADR-002 |
| BM-05 | Authorization boundary: deny-by-default, server-derived workspace scoping, neutral 404s, IDOR negative tests | ADR-001, QSD-01 |
| BM-06 | Error envelope + request IDs + error-code taxonomy | Spec §5.1 |
| BM-07 | Idempotency framework: idempotency records, normalized-body hash, replay vs 409 | Spec §5.1 |
| BM-08 | Append-only audit/event log + outbox | Spec §4.5 |
| BM-09 | Telemetry redaction rules: no addresses, prompts, image bytes, or secrets in logs | QSD-07 |

## M1 — Project and revision core

| ID | Feature | Implements |
|---|---|---|
| BM-10 | POST /projects: project + revision 1 atomically, idempotent | Spec §5.2 |
| BM-11 | GET /projects/{id}: current snapshot, workflow state, findings summary, optional paginated history | Spec §5.2 |
| BM-12 | Revision commit endpoint: If-Match + expected_revision, 409 STALE_REVISION, no silent merge | QSD-04 |
| BM-13 | Snapshot hash + append-only immutability | Spec §4.4 |
| BM-14 | Workflow-state derivation: computed, never client-set | Spec §4.6 |
| BM-15 | Race and idempotency test suite (concurrent commits yield exactly one revision; replay returns prior response; key/body conflict) | Spec §9.1 |
| BM-16 | Stale-revision banner + reconcile flow in UI | F21 |

## M2 — Intake

| ID | Feature | Implements |
|---|---|---|
| BM-17 | Upload intents + presigned single-object capability: bounded JPEG/PNG/WebP, 10 MiB / 12 MP caps | QSD-02 |
| BM-18 | verify_upload job: magic signature, checksum, decode limits, quarantine invalid files | QSD-02 |
| BM-19 | Download intents: short-lived, purpose-bound asset access | Spec §5.3 |
| BM-20 | /projects/new UI: brief, photo-or-explicit-skip, unknowns entry | F01 |
| BM-21 | Address + applicant-role self-declaration: unverified stays visibly unverified | F02 |
| BM-22 | Clarifying-questions engine: allowlisted questions, "I do not know" is a valid answer, conflicts captured | F03 |
| BM-23 | Meta scope-proposal adapter: strict schema output, minimized context, provenance labels, one attempt per action. Eligibility gate — pending live Meta Model API verification; muse-spark-1.3 candidate | QSD-03 |
| BM-24 | Proposal-to-confirm flow: AI proposes, human confirms, only the revision endpoint writes | F23 |

## M3 — Concept and facts

| ID | Feature | Implements |
|---|---|---|
| BM-25 | Concept selection: exactly one active concept per revision, provenance labels, generated image is a candidate and never evidence | F05 |
| BM-26 | Retained constraints carried through findings and export ("Keep the existing window") | F05 |
| BM-27 | Measurement intake: value/unit/provenance (measured, estimated, or unknown), positive-finite validation, allowlisted units | F06 |
| BM-28 | Measurement conflict items: duplicates and conflicts become visible review items, never auto-resolved | F06, F11 |

## M4 — Guidance and findings

| ID | Feature | Implements |
|---|---|---|
| BM-29 | Source registry + reviewed excerpts: versioned SF DBI source, activation states, stale/withdrawn handling | QSD-05 |
| BM-30 | Source cards UI: every finding exposes source, retrieval date, and version | F09 |
| BM-31 | Ruleset v1 + deterministic evaluator: the single professional-plans rule, tri-state resolution, honest does_not_apply | F10 |
| BM-32 | Evaluation endpoint + evaluate_preparation job + fingerprint computation | Spec §5.4 |
| BM-33 | Findings model: status, severity, required_evidence_items, non_conclusions | F10, F11 |
| BM-34 | Conflict and missing-item checks: conflicting confirmed claims stay preserved, never auto-resolved | F11 |
| BM-35 | Stale invalidation: ruleset/source change invalidates current derivatives; historical stays labeled historical | F21 |

## M5 — Dossier, review, export

| ID | Feature | Implements |
|---|---|---|
| BM-36 | Dossier assembly: current revision only, unresolved items visible, banned-language enforcement (no "permit-ready", "approved", "compliant") | F12 |
| BM-37 | /prepare UI: facts, proposals, questions, source cards, findings, stale banner | Spec §2.3 |
| BM-38 | /review UI: read-only dossier, revision history, acknowledgement step | F12, F13 |
| BM-39 | Owner review endpoint: fingerprint-bound, 422 without unresolved-items acknowledgement | F13 |
| BM-40 | Export job: renders only the reviewed revision/fingerprint, immutable artifact | QSD-06 |
| BM-41 | Export labels + download intent: "draft preparation packet", unresolved list included | F13 |
| BM-42 | Historical export handling: later changes never relabel an old export as current | F13, F21 |

## M6 — Demo ops and evaluation

| ID | Feature | Implements |
|---|---|---|
| BM-43 | Curated fixtures manifest: 10 synthetic scenarios including injection, IDOR, stale-job, and source-unavailable cases | QSD-08 |
| BM-44 | Evaluation report: denominator, negative cases retained, bounded claims only | F24 |
| BM-45 | Failure runbooks: model unavailable, source changed/unavailable, stale job/export | Spec §9.3 |
| BM-46 | Demo script + seed + rehearsal: the controlled story end-to-end | QSD-11 |
| BM-47 | Release gate + submission freeze: repo/video/credits verification before the 6 PM buffer | QSD-12 |

## Deliberately cut from this build

| Item | Reason |
|---|---|
| M7 public preview (DataSF snapshot loader, public list UI, isolation tests; spec F17–F18) | Conditional P1; demo story does not need it; QSD-10 allows cut |
| Open-weight add-ons: SAM 3.1 region highlight, Muse Image concept candidate, agentic explanation loop | User decision Oct 27: core demo only; credits reserved for Muse Spark |
| F04 voice/video intake, F07 material costs, F08 3D/AR, F14 contractor handoff, F15 manual project state, F16 staff workspace, F19 NL queries, F20 aggregate analytics | Design contracts in spec Section 3, not commitments for the ten-day build |

## Open decisions

1. Meta Model API smoke test: credits claimed but unverified — one live call against muse-spark-1.3 before Oct 29 (owner: Yifu). Pass/fail gate for the whole build.
2. Export format: PDF (spec default) vs accessible HTML (spec-permitted; no renderer dependency). Recommendation: HTML.
3. Team commitments: confirm Kurt/Umang/Caleb availability through Nov 4 and the QSD owner split (Kurt owns 6 of 12); confirm Caleb as source-review owner (QSD-05/08).
