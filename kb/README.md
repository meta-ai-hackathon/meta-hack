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
| `kb/entries/*.json` | One file per program entry — three pilot-agnostic samples (the base sample plus matching fixtures B and C, so benefit matching has something to rank) plus the locked pilot's real entries, built only from official government sources with per-source claim-verification notes: the application entry (id `nc_medicaid`) and the renewal entry (id `nc_medicaid_renewal`, HACK-50) |
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
| `facts` | yes | Four required fact groups (`rules`, `required_documents`, `official_links`, `deadlines`) plus optional ones (`steps`, `match_signals`, the renewal groups `renewal_cadence` and `if_coverage_ends`, and the handoff groups `submission_steps` and `after_you_apply`), each source-linked |

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
  `applies_to` the source states, an optional `starts_on` date, the first
  date a renewal under the schedule can fall on (omitted when the schedule
  is already in effect), an optional `ages` range (`min` and `max`,
  integers 0-130, inclusive) when the source limits the schedule to
  certain ages, and an optional `source_id` naming the listed source that
  states the schedule when it is not the group's source (omitted, the
  group's source applies). A group can draw its schedules from different
  pages: each schedule renders with the page that states it
  (`citeCadenceSchedule` in `src/lib/kb.ts`), and an estimate built from
  it is always shown as an estimate with that source, never as an
  official date.
- `if_coverage_ends` — statement strings on what the source says happens
  and what a person can do if their coverage ends (the letter, the appeal
  window, free help). It has the same shape as `rules`. The renewal
  tracker shows it, labeled and sourced, once a renewal date has passed.

`kb/schema.json` declares draft-07, which ignores any keyword written next
to a `$ref`, so the schema keeps its descriptions on definition objects or
on objects without a `$ref`, and notes about a referenced field live here.
The pytest suite checks that nothing sits beside a `$ref`.

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
one of the entry's sources. The group keeps a `retrieved_at` date for when
the list was last checked, and an optional `form_id` names the
form-registry entry (`kb/forms/`) its steps are written for when they
point at that form's pages, so the handoff shows them only beside that
form. `citeSourcedSteps()` in `src/lib/kb.ts` cites each step with its own
source and that source's retrieval date, and refuses a stale or withdrawn
entry without acknowledgment, the same way `citeFactGroup()` does. Steps
link official pages instead of copying addresses, phone numbers, or fax
numbers, which can change.

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

## Pilot-agnostic placeholders, and the locked pilot's real entries

The three shipped sample entries use `{{PILOT_PROGRAM}}` placeholders and
reserved-domain example URLs (`example.org`); they remain the test fixtures
after the pilot lock. The real pilot entry landed when the pilot decision
locked (HACK-16 Done, Oct 30): it names its program, carries only official
government sources with retrieval dates, and records claim-verification
notes per source (what was verified, on which page, when). Unresolved
claims stay out of the entry rather than being guessed. The pytest suite
still greps the KB surface: the samples, the schema, this README, and the
consuming module must stay free of program names — only the versioned real
entries are sanctioned to carry them. Retrieval dates in entries must be real
calendar dates (the runtime validator checks the calendar; JSON Schema
checks the shape).

Real entries live in `kb/entries/` beside the samples, one pattern for all
of them (the team's decision, which a reviewer recorded
[on PR #55 on Oct 31](https://github.com/meta-ai-hackathon/meta-hack/pull/55#discussion_r4431007644)).
The renewal entry (`nc_medicaid_renewal`) joins the application entry on
the grep's sanctioned list, by file, so no directory is skipped.

## The renewal entry

The renewal entry backs the renewal tracker (BN-22 / HACK-50): how often
the pilot program renews coverage, the January 1, 2027 change for most
adults ages 19 through 64, who that change does not affect, how long a
person has to answer a renewal letter, what happens if coverage ends, and
the steps and links the program gives for renewal time.

- Every source is an official North Carolina government page (`ncdhhs.gov`,
  `nc.gov`), https only, with the date it was read. `TestRenewalEntry` in
  `tests/test_kb_schema.py` checks the domains, the schema, that no
  placeholder or example URL slipped in, and that the entry names no
  program other than the pilot's own.
- Facts are restated close to the source wording. When a page changes,
  update the fact, bump `version`, and set `retrieved_at` to the day you
  re-read it. When a source can no longer be confirmed, mark the entry
  `stale` with a `status_reason` instead of leaving it `active`.
- The entry is not part of the benefit-match dataset (`KB_ENTRIES`, built
  from `PILOT_CONFIG.kbEntryIds`), so it never changes match ranking or the
  chat assistant's grounding. The renewal tracker imports it directly
  (`src/lib/renewal/renewal-facts.ts`).
- Do not list a page that contains political statements, even uncited. A
  cited source renders as a link on the tracker, and a later edit could cite
  any listed source.

### Where the sources disagree

Read these before changing the renewal schedules. Sources are named by
their `id` in the entry.

- **Who renews every 6 months.** `ncm_medicaid_is_changing` says the 2027
  changes only affect adults ages 19 through 64, people who are not U.S.
  citizens, and people applying, and that nothing changes for everyone else
  as long as they still meet the program's eligibility requirements. Keep
  that condition with the fact: without it the line reads as a promise of
  continued coverage. The September 1, 2026 state press release and the
  toolkit flyer (`ncm_changes_flyer`) aim the 6 month renewal at adults
  ages 19 through 64 (the press release says people covered through the
  expansion; the flyer is written for adults in that age group without a
  disability). `ncm_work_requirement` tells everyone who is exempt from the
  work rule, a list that includes people younger than 19 and older than
  64, that they will renew every 6 months. The entry follows the majority
  reading: the 6 month schedule carries `ages` 19 through 64 and its own
  `source_id`, `ncm_medicaid_is_changing`, so the scope always shows with a
  page that states it. The `renewal_cadence` group still cites
  `ncm_work_requirement`, the source for the once-a-year line for members
  eligible for Indian Health Services. The tracker asks one question that
  stays on the device and leaves the 6 month estimate out when the answer
  is outside those ages, showing that schedule and its source in its
  place. The flyer is listed for the record, but no fact group or schedule
  cites it, so it does not render. The press release is not listed because
  it contains political statements.
- **When the 6 month schedule starts.** Mecklenburg County's changes page
  lists December 31, 2026; the state's pages say January 1, 2027. The
  entry uses the state date. No estimate can land on December 31, 2026, so
  the difference does not change any date the tracker shows.
- **Whether a 12 month period granted in 2026 is shortened.** No cited page
  says. The tracker shows both estimates and says that the first renewal on
  a new schedule may come at the next scheduled renewal, and that the
  letter has the real date.

To re-verify, run the commands below, then open each source URL and
compare it with the facts in the entry.

## Validating an entry

```text
python3 -m pytest tests/test_kb_schema.py -q
pnpm test -- src/lib/kb.test.ts src/lib/renewal
```

The JSON Schema is the machine contract, checked by pytest with the pinned
`jsonschema` package. `src/lib/kb.ts` re-validates with the same rules plus
the semantic checks JSON Schema cannot express, throwing
`KbValidationError` with every problem listed.
