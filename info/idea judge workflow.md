# Idea judge workflow

Paste any new idea through this before spending a minute building. An agent can run it end to end.

## Step 1 — Ban test (10 seconds)

Check against `restrictions.md`: does it advise a body, grade a human, need one API call, or touch war/politics?

- **Any yes** → dead. Write one line in `ideas/evaluated.md` and stop
- **All no** → continue

## Step 2 — Gate check (30 seconds)

1. Which problem statement does it fit — Build for Your World or Push the Frontier? (Name the specific fit in one sentence. If it takes a paragraph to justify, that's a red flag)
2. Which Meta models does it genuinely need at runtime — SAM 3.1, Spark, Wonder, Image, Voice Transcribe, open weights? (Name them. "Could use an LLM" ≠ genuine use)

Fail either → dead or reshape.

## Step 3 — Score against the rubric (0–10 each, be honest)

| Criterion | Weight | Ask yourself |
|---|---|---|
| Impact | 30% | Who exactly benefits? Would a stranger care in 10 seconds? Could it become a product people use? |
| Meta tooling | 25% | Is a Meta model doing load-bearing work, or decoration? Could someone else build the same thing without Meta's stack? (If yes → low score) |
| Demo | 25% | What's the 10-second hook? Does the wow survive being recorded? Can it fail on camera? |
| Technical depth | 20% | What part is hard? What would a judge inspect and respect? |

Weighted total = 0.30·I + 0.25·T + 0.25·D + 0.20·Depth.

## Step 4 — Compare and decide

**Incumbent to beat: footage search, ≈8.3.** (Update this number if the incumbent changes.)

| Score | Verdict |
|---|---|
| < 6.0 | Park it. Log it, move on |
| 6.0 – 7.5 | Only alive if it merges into the incumbent or fixes its weakest column |
| 7.5 – 8.3 | Serious contender — pressure-test the 10-day build |
| > 8.3 | New frontrunner. Re-plan |

## Step 5 — Log it

Add one row to `ideas/evaluated.md`: name, score, one-line why, status. One MD file per idea only if it scores 7.5+.

## Score anchors (what a number means)

- **10** — nobody else can build this even with the same models
- **8** — clearly differentiated, small weaknesses
- **6** — solid but generic; execution-dependent
- **4** — someone else has shipped this; or the wow is fakeable
- **2** — judges would forget it immediately
