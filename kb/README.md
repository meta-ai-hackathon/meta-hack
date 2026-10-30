# Knowledge base (BN-04 / HACK-29)

Versioned, source-linked program entries: the knowledge moat. Every fact a
user can see traces to an official source with a retrieval date, and stale
or withdrawn entries can never be cited silently.

## Location: `kb/` at the repo root

Chosen over `src/data/kb/` on purpose:

- Mirrors `specs/` — repo-level data that app code consumes read-only.
- Keeps entries out of the compiled source tree while staying importable:
  `src/lib/kb.ts` imports the JSON files statically (TypeScript
  `resolveJsonModule`), so they are bundled at build time and never read
  from disk at runtime (which would not survive a serverless deploy).

## Layout

| Path | What it is |
|---|---|
| `kb/schema.json` | JSON Schema (draft-07) every entry must satisfy |
| `kb/entries/*.json` | One file per program entry — three pilot-agnostic samples (the base sample plus matching fixtures B and C, so benefit matching has something to rank) |
| `kb/pilot/*.json` | Entries for the decided pilot program (HACK-50): real facts from official sources, kept apart from the samples (see `kb/pilot/README.md`) |
| `kb/glossary.json` | Plain-language glossary terms (BN-30), each with an official source and retrieval date |
| `kb/README.md` | This document |

## Entry format

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Snake_case identifier, unique across the KB |
| `title` | yes | Human-readable program name |
| `version` | yes | Integer, 1 or higher; bump on any fact or source change |
| `status` | yes | `active`, `stale`, or `withdrawn` (rules below) |
| `status_reason` | stale / withdrawn | Why the entry is not current |
| `superseded_by` | optional | Entry id that replaces this one |
| `sources` | yes | One or more official sources: `id`, `title`, `url` (https only), `retrieved_at` (ISO date), `supports` (what it backs) |
| `facts` | yes | Four required fact groups (`rules`, `required_documents`, `official_links`, `deadlines`) plus four optional ones (`steps`, `match_signals`, `renewal_cadence`, `if_coverage_ends`), each source-linked |

Fact groups — `rules`, `required_documents`, `official_links`, `deadlines` —
each carry `items`, a `source_id` naming one of the entry's sources, and a
`retrieved_at` date. Two groups may cite different sources. `rules` and
`required_documents` hold statement strings; `official_links` holds
`label` + `url`; `deadlines` holds `label` + `due`.

Two optional groups (mission v2 M3) follow the same provenance rules:

- `steps` — application steps as statement strings; feeds the match card's
  requirements checklist (BN-15).
- `match_signals` — what the entry's official rules consider about a
  person, expressed over the generic question spec: items carry
  `question_id` (must resolve in `specs/question-spec`), an optional
  `values` list of option values, an optional `weight` (integer 1-9,
  default 1), and the program-side `reason` a match card shows. Benefit
  matching (`src/lib/match.ts`) scores these deterministically; unknown or
  unverified answers never match a signal.

Two more optional groups (BN-22 / HACK-50) follow the same rules:

- `renewal_cadence` — how often the program renews coverage, so the
  renewal tracker can estimate a next renewal date from a date the person
  reports. Items carry `id` (snake_case, unique in the group),
  `interval_months` (integer 1-24), the plain-language `label` and
  `applies_to` the source states, an optional `starts_on` date before
  which the schedule cannot set a renewal, an optional `ages` range
  (`min` and `max`, integers 0-130, inclusive) when the source limits the
  schedule to certain ages, and an optional `source_id` when the schedule
  comes from a different listed source than the group's. Each schedule
  renders with its own source (`citeCadenceSchedule` in `src/lib/kb.ts`),
  and an estimate built from it is always shown as an estimate with that
  source, never as an official date.
- `if_coverage_ends` — statement strings on what happens and where to get
  help if coverage ends (the letter, the appeal window, free help). The
  renewal tracker shows them, labeled and sourced, once a renewal date has
  passed.

## Status rules

| Status | Rule |
|---|---|
| `active` | Facts re-verified against the sources. Citable, with the status and retrieval date shown. |
| `stale` | Sources may have changed since retrieval. Never cited silently: citing requires explicit acknowledgment, and any surfaced fact must display the stale status and the reason. |
| `withdrawn` | Retracted entirely (program ended, source disowned the facts, retraction found). Never cited as fact, only presented as withdrawn, always with the reason. Name `superseded_by` when a replacement entry exists. |

## No silent citation

The rule is encoded twice, on purpose:

- **Schema:** `status` on every entry, `status_reason` required for
  `stale`/`withdrawn`, and a retrieval date on every source and fact group.
- **Code** (`src/lib/kb.ts`): the `KbCitation` type carries `status` as a
  required field, so any consumer displaying facts has the status in hand.
  `citeFactGroup()` refuses to build a citation for a stale or withdrawn
  entry unless the caller passes `acknowledgeNonActive` — and even then the
  citation still carries the status and reason. There is no code path that
  produces a status-free citation.

## Pilot-agnostic placeholders

The shipped sample entries in `kb/entries/` use `{{PILOT_PROGRAM}}`
placeholders and reserved-domain example URLs (`example.org`). Do not fill
in a real program there; they stay matching fixtures. The pytest suite
greps the KB surface for real program names to keep this honest, and
retrieval dates in entries must be real calendar dates (the runtime
validator checks the calendar; JSON Schema checks the shape).

The one exception is `kb/pilot/`, which holds the decided pilot program's
entries (HACK-50). The grep skips that directory, and `TestPilotEntries`
holds it to stricter rules instead. Every file there, the README included,
carries no placeholders and no real program name other than the pilot's
own. Every entry there is also schema-valid, cites official state
government sources over https, and has no future retrieval dates. Entries
there are not part of the matching dataset (`KB_ENTRIES`).

## Validating an entry

```text
python3 -m pytest tests/test_kb_schema.py -q
pnpm test -- src/lib/kb.test.ts
```

The JSON Schema is the machine contract, checked by pytest with the pinned
`jsonschema` package. `src/lib/kb.ts` re-validates with the same rules plus
the semantic checks JSON Schema cannot express, throwing
`KbValidationError` with every problem listed.
