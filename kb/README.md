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
| `kb/entries/*.json` | One file per program entry — three pilot-agnostic samples (the base sample plus matching fixtures B and C, so benefit matching has something to rank) plus the locked pilot's real entry, built only from official government sources with per-source claim-verification notes |
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
| `facts` | yes | Four required fact groups (`rules`, `required_documents`, `official_links`, `deadlines`) plus optional ones (`steps`, `match_signals`, and the handoff groups `submission_steps` and `after_you_apply`), each source-linked |

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

## Status rules

| Status | Rule |
|---|---|
| `active` | Facts re-verified against the sources. Citable, with the status and retrieval date shown. |
| `stale` | Sources may have changed since retrieval. Never cited silently: citing requires explicit acknowledgment, and any surfaced fact must display the stale status and the reason. |
| `withdrawn` | Retracted entirely (program ended, source disowned the facts, retraction found). Never cited as fact, only presented as withdrawn, always with the reason. Name `superseded_by` when a replacement entry exists. |

## Handoff step groups

Two more optional groups feed the handoff (BN-24 and BN-26, HACK-46 and
HACK-47) rather than the match card:

- `submission_steps`: what a person does, in order, with a filled
  application form to sign it and send it in themselves.
- `after_you_apply`: what the official sources say happens after it is
  sent.

Unlike the other groups, these carry a source on every item instead of
one per group, because a single list draws on several official pages
(the form itself, a county page, an online portal). Each item has an `id`
(snake_case, unique in its group), a short `label`, a plain-language
`detail` of what its source says, an optional `link` (`label` plus an
https `url`) to the official page for that step, and a `source_id` naming
one of the entry's sources. The group keeps a `retrieved_at` date, and an
optional `form_id` names the form-registry entry (`kb/forms/`) its steps
are written for when they point at that form's pages, so the handoff shows
them only beside that form.
`citeSourcedSteps()` in `src/lib/kb.ts` cites each step with its own
source and refuses a stale or withdrawn entry without acknowledgment, the
same way `citeFactGroup()` does. Steps link official pages instead of
copying addresses, phone numbers, or fax numbers, which can change.

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

## Pilot-agnostic placeholders, and the locked pilot's real entry

The three shipped sample entries use `{{PILOT_PROGRAM}}` placeholders and
reserved-domain example URLs (`example.org`); they remain the test fixtures
after the pilot lock. The real pilot entry landed when the pilot decision
locked (HACK-16 Done, Oct 30): it names its program, carries only official
government sources with retrieval dates, and records claim-verification
notes per source (what was verified, on which page, when). Unresolved
claims stay out of the entry rather than being guessed. The pytest suite
still greps the KB surface: the samples, the schema, this README, and the
consuming module must stay free of program names — only the versioned real
entry is sanctioned to carry them. Retrieval dates in entries must be real
calendar dates (the runtime validator checks the calendar; JSON Schema
checks the shape).

## Validating an entry

```text
python3 -m pytest tests/test_kb_schema.py -q
pnpm test -- src/lib/kb.test.ts
```

The JSON Schema is the machine contract, checked by pytest with the pinned
`jsonschema` package. `src/lib/kb.ts` re-validates with the same rules plus
the semantic checks JSON Schema cannot express, throwing
`KbValidationError` with every problem listed.
