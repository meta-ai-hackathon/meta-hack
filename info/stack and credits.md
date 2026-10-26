# Stack and credits — the ingredients

## The Muse family (all under one brand)

"Muse" is Meta's brand for all its AI models. Different models for different jobs:

| Model | Job | Similar to | Open weights? |
|---|---|---|---|
| Muse **Spark** (1.3) | LLM — text in/out, fast, cheap | GPT-4o-mini | Yes — "Muse Spark Open" |
| Muse **Wonder** | Also an LLM — bigger, newer (Oct 12 launch), frontier agent model with "Active Memory" | Claude Opus | No |
| Muse **Image** | Generates images | DALL-E | No |
| Muse **Voice Transcribe** | Speech → text | Whisper | No |
| **SAM 3.1** | Sees video — detect + segment + track any object from a text prompt, keeps IDs across frames | no equivalent | Yes — code + checkpoints on GitHub |
| Muse **Glimmer** | Open-weight model | — | Yes |
| Muse **Code** | Not a model — CLI coding agent that uses Spark under the hood | Claude Code | n/a |

Key mental models:

- **Spark vs Wonder:** same job (text reasoning), different size. Spark = fast/cheap, Wonder = frontier/smart
- **SAM 3.1 is not image recognition.** It returns masks + persistent track IDs — *where* everything is and went. It never tells you *what it means* — that's the LLM's job
- **Muse Code helps you write code; it never runs in the product.** Judges score tooling on what's IN the app

## Credits and compute

| Source | Amount | Catch |
|---|---|---|
| Meta Model API | ==$150 per person== | Everyone claims individually (can't claim for teammates), card pre-auth required, ==deadline Nov 4, 9 PM ET==. Set a spend limit on the Billing page |
| Baseten | $100 + 2M TPM | First 2,000 participants, use-case review. ==🔴 Docs default to `meta-models/muse-spark-open` — hackathon requires `meta-models/muse-spark-open-1026`== |
| Modal | $100 | First 1,000 participants — serverless GPUs, Endpoints, sandboxes, fine-tuning |
| Fireworks | $25 | Shortlisted teams only |

Baseten/Modal/Fireworks all do the same job: rent GPUs to run open-weight models yourself, outside Meta's API.

## Budget plan (the strategy)

1. **$150 is a reasoning budget, not a perception budget.** SAM 3.1 over raw video burns credits. Cache tracks once per clip; the LLM only reasons over compressed track data, never re-watches video
2. **SAM 3.1 is open weight** → self-host on Modal GPUs. Perception becomes a flat ~$5–10 instead of per-call. Saves the $150 for Spark/Wonder
3. **The fine-tune play** — LoRA a small open-weights model (on Modal) to do one job well. Checks "beyond a basic integration" and the $10K open-weight bonus at once
4. **Contributor tier trap** — Muse Code's cheap tier ($0.72/1k steps) lets Meta train on your code. ==Fine for hackathon code, never for TASC repos==

## Muse Code quality check (researched Oct 26)

- 2nd place on every benchmark Meta published (82.9 vs Claude Opus 5's 86.7 on Terminal-Bench) — vendor-run, not independently verified
- Built-in reviewer agent catches bad edits; 1M token context; crash-safe event log; ran a 24-hour unattended job in Meta's demo
- CLI-only, macOS/Linux, beta
- Verdict: use it for the hackathon ("built with Meta's own agent" reads well), keep Cline as backup
