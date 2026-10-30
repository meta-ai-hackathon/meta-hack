# Pilot knowledge-base entries

This directory holds knowledge-base entries for the pilot the team settled on
Oct 29, 2026: NC Medicaid in Mecklenburg County (Charlotte). Unlike the
pilot-agnostic samples in `kb/entries/`, these entries carry real facts, each
traced to an official North Carolina source with a retrieval date.

| File | What it backs |
|---|---|
| `nc-medicaid-renewal.json` | The renewal tracker (BN-22 / HACK-50): how often NC Medicaid renews coverage, the January 1, 2027 change for most adults ages 19 through 64, who the change does not affect, how long a person has to answer a renewal letter, what happens if Medicaid ends, and the steps and links NC Medicaid gives for renewal time |

## Rules for entries here

- Every source is an official NC government page (`ncdhhs.gov`, `nc.gov`),
  https only, with the date it was read. `tests/test_kb_schema.py` checks the
  domains, the schema, and that no placeholder or example URL slipped in.
- Facts are restated close to the source wording. When a page changes, update
  the fact, bump `version`, and set `retrieved_at` to the day you re-read it.
  When a source can no longer be confirmed, mark the entry `stale` with a
  `status_reason` instead of leaving it `active`.
- Entries here are not part of the benefit-match dataset (`KB_ENTRIES` in
  `src/lib/kb.ts`), so they never change match ranking or the chat
  assistant's grounding. The renewal tracker loads its entry directly.
- The pilot seam (`src/lib/pilot.ts`) still holds placeholders until the
  HACK-16 flip lands. Routing this entry through `PILOT_CONFIG.kbEntryIds`
  belongs to that flip.
- Do not list a page that contains political statements, even uncited. A
  cited source renders as a link on the tracker, and a later edit could cite
  any listed source.

## Where the sources disagree

Read these before changing the renewal schedules.

- **Who renews every 6 months.** The Medicaid is Changing page says the 2027
  changes only affect adults ages 19 through 64, people who are not U.S.
  citizens, and people applying, and that for everyone else Medicaid does not
  change. The September 1, 2026 NCDHHS press release and the toolkit flyer
  aim the 6 month renewal at adults ages 19 through 64 (the press release says
  people with Medicaid expansion; the flyer is written for adults in that age
  group without a disability). The Work and Community Engagement Requirement
  page, which the `renewal_cadence` group cites, tells everyone who is exempt
  from the work rule, a list that includes people younger than 19 and older
  than 64, that they will renew every 6 months. The entry follows the
  majority reading: the 6 month schedule carries `ages` 19 through 64, the
  tracker asks one question that stays on the device, and it leaves that
  estimate out when the answer is outside those ages. The press release is
  not listed because it contains political statements.
- **When the 6 month schedule starts.** Mecklenburg County's Medicaid
  changes page lists December 31, 2026; the state's pages say January 1,
  2027. The entry uses the state date. No estimate can land on December 31,
  2026, so the difference does not change any date the tracker shows.
- **Whether a 12 month period granted in 2026 is shortened.** No cited page
  says. The tracker shows both estimates and says that the first renewal on a
  new schedule may come at the next scheduled renewal, and that the letter
  has the real date.

## Re-verifying

```text
python3 -m pytest tests/test_kb_schema.py -q
pnpm test -- src/lib/kb.test.ts src/lib/renewal
```

Then open each source URL and compare it with the facts in the entry.
