# Housing idea — "describe your dream home, AI builds it"

Not my idea — evaluated it for a potential team-up. Verdict: pass unless they make the pivot in §4.

## The idea, end to end

1. Buyer describes the home they want — budget, location, rooms, preferences. For *building new*, not buying existing
2. AI turns that into a design: floor plan / CAD blueprint, rotatable 3D model, suggested materials + prices, estimated build time, location-adjusted. All proposed, nothing built yet
3. Buyer explores it — phone/computer view first, AR glasses as the ambitious version. Wow moment: your personalized dream home appears fast
4. Platform connects the project to builders and trades (HVAC, plumbing, roofing); longer-term, bring homeowners back for repairs/upgrades
5. Revenue undecided — homeowner subscription and/or business-side leads, data, access

Proposed 3-min demo: enter a request → generate and explore a design → show homeowner connecting with a builder. Open question they flagged: is an AI-generated *buildable blueprint* a legal/screening problem (asked an organizer on Discord, no ruling back).

## Scorecard

| Criterion | Weight | Score | Why |
|---|---|---|---|
| Impact | 30% | 7.5 | Housing is a real, huge market; buyers + small builders genuinely benefit. Strongest column |
| Meta tooling | 25% | 4 | ==The core artifact — a *buildable* floor plan — is constrained geometry (walls, plumbing, code compliance). That's CAD math, not an LLM task==. Meta's stack only contributes decoration (renders, chat) |
| Technical depth | 20% | 5 | Real generative design = months. In 10 days: templates + pretty renders, or fake. Marketplace half is a CRUD app |
| Demo | 25% | 7 live / 4 pre-baked | "Walk through your home" is great cinema — but they don't know yet what generates live vs is PowerPoint |
| **Weighted** | | **≈6.1** | Below incumbent (8.3) |

## Three structural problems

1. **Three products in one trench coat** — design generator + 3D/AR viewer + marketplace. Hackathons reward one sharp demo. The marketplace adds zero wow and zero AI — cut it
2. **The wow moment depends on the weakest column** — live floor-plan generation is exactly what they can't do honestly
3. **The safety worry is a distraction** — a "concept design" that still needs a licensed architect is none of the four banned logics. One-line disclaimer ("concept only, requires licensed professionals") closes it. Waiting on the Discord ruling wastes days. Their real problem is tooling fit, not eligibility

## The fix that makes it honest

Flip the input: start from **photos of your existing home**, not a text prompt.

- SAM 3.1 segments rooms/features from the photos
- LLM reasons about constraints ("that wall is load-bearing")
- Muse Image renders the remodeled after-state

Same wow ("see your home transformed"), but every step runs on Meta's stack for real — and nobody can accuse the demo of faking geometry, because the model is visualization, not structural engineering. That version scores ≈7.5–8, comparable to the incumbent.

## Verdict

- Blueprint version (≈6.1): don't join. Send them the photo-remodel suggestion
- Photo-remodel version (≈7.5–8): only version worth joining — and only if the team commits to the cut
