---
name: evaluate-idea
description: Score a hackathon idea against the anti-project ban list, the pass/fail gate, and the weighted rubric, then log the verdict to the leaderboard. Use before spending any build time on a new idea or team-up pitch.
---

# Evaluate an idea

Executable form of `info/idea judge workflow.md`. Turn a raw idea (one line to a paragraph) into a scored verdict and a leaderboard row in under five minutes. Run from the repo root. Do not skip steps, do not soften scores.

## Inputs

- The idea, in the user's own words
- Who's building it: solo, existing team, or external pitch (external pitches also get a team-fit judgment)

## Step 1 — Ban test (10 seconds)

Open `info/restrictions.md`. Every banned idea falls in one of four logics:

1. Advises a body (medical, mental health, nutrition, legal, financial)
2. Grades a human (hiring, dating, personality, emotion, credit)
3. Wrapper (basic RAG, one-shot image analysis, edu chatbot — one API call + a UI)
4. Politics or war

- Any yes → dead. Log the row (Step 5) with the bucket number and stop.
- Gray zones count as yes: face recognition / identity search, "suspicious behavior" scoring, public-space or cross-city tracking. Attribute search ("red hoodie") and concrete-event triggers (line crossed, after-hours motion) are the safe forms.

## Step 2 — Gate check (30 seconds)

1. Which problem statement: **Build for Your World** or **Push the Frontier**? Name the fit in one sentence. If it takes a paragraph to justify, that's a red flag.
2. Which Meta models does it genuinely need at runtime — SAM 3.1, Muse Spark, Muse Wonder, Muse Image, Muse Voice Transcribe, open weights? Name them per pipeline stage. "Could use an LLM" is not genuine use.

Fail either → dead or reshape before scoring.

## Step 3 — Score the rubric (0–10 each, be honest)

| Criterion | Weight | Ask |
|---|---|---|
| Impact | 30% | Who exactly benefits? Would a stranger care in 10 seconds? Could it become a product? |
| Meta tooling | 25% | Is a Meta model load-bearing or decoration? Could someone build the same thing without Meta's stack? |
| Demo | 25% | What's the 10-second hook? Does the wow survive being recorded? Can it fail on camera? |
| Technical depth | 20% | What part is hard? What would a judge inspect and respect? |

Weighted total = 0.30·Impact + 0.25·Tooling + 0.25·Demo + 0.20·Depth, one decimal, `≈` prefix when subjective.

Score anchors: **10** nobody can rebuild this with the same models · **8** clearly differentiated, small weaknesses · **6** solid but generic, execution-dependent · **4** someone shipped it, or the wow is fakeable · **2** judges forget it immediately.

## Step 4 — Compare against the incumbent

Read `ideas/evaluated.md` and take the highest weighted score among ideas that are not 🔴 Dead.

| Score | Verdict |
|---|---|
| < 6.0 | Park it. Log it, move on |
| 6.0 – 7.5 | Alive only if it merges into the incumbent or fixes the incumbent's weakest column |
| 7.5 – incumbent | Serious contender — pressure-test the 10-day build before committing |
| > incumbent | New frontrunner — re-plan |

## Step 5 — Log it (always, even for dead ideas)

1. Append one row to `ideas/evaluated.md`: name, four scores, weighted, one-line why, status (`🔴 Dead — reason` / Parked / Frontrunner).
2. Create `ideas/<idea name>.md` only if it scored 7.5+. One file per idea: what it is, pipeline, demo structure (3 minutes), open items.
3. If the incumbent changed, update the "Incumbent to beat" line in `info/idea judge workflow.md` and the "Where we stand" section in `README.md`.

## Report back

Always end with: the four-row scorecard table, the weighted total, the verdict in one line, and what was logged where.
