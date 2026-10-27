# Ideas evaluated — running scorecard

Every idea considered, scored through `info/idea judge workflow.md`. **Incumbent to beat: footage search ≈8.3.**

| Idea | Impact (30%) | Tooling (25%) | Demo (25%) | Depth (20%) | Weighted | Status |
|---|---|---|---|---|---|---|
| **Footage search** (civilian) | 9 | 7 | 9 | 8 | **8.3** | **Frontrunner** |
| OVERWATCH (military) | 8 | 9 | 8 | 9 | 8.4 | 🔴 Dead — anti-list bans war |
| Sports analyst | 6 | 7 | 7 | 7 | 6.7 | 🔴 Dead — anti-list bans sports analyzers |
| Boxing judge | 5 | 7 | 6 | 8 | 6.4 | 🔴 Dead — sports + demo risk |
| Wildlife camera traps | 6 | 6 | 5 | 6 | 5.8 | Parked — safe but soft |
| Housing blueprint | 7.5 | 4 | 7 | 5 | 6.1 | Pass unless pivoted — see `housing idea.md` |
| Housing photo-remodel pivot | 7 | 7.5 | 8 | 7 | ≈7.5 | The only joinable version |
| Kurt's Codenames spymaster | 2 | 3 | 7 | 6 | ≈4.3 | Declined — zero impact, wrapper tooling, unfalsifiable SOTA claim |
| **Find my dog** (rescue vertical) | 8.5 | 8 | 8.5 | 8 | ≈8.3 | Merged — frontrunner mission + demo spine (Luna case) |

## Notes per idea

- **Footage search**: real pain (scrubbing hours of footage), instant-understanding demo, near-zero demo risk. Two drift-rules in `restrictions.md`: attribute search not face recognition; concrete-event triggers not "suspiciousness" scoring
- **OVERWATCH 8.4 vs footage search 8.3**: within noise because they're the same pipeline with different clothes. Merged plan = civilian product + the object-timeline moment as a demo scene. Anti-list made the decision
- **Kurt's idea details**: ex-Googler recruiting 3 SWEs, claims "advances NLP SOTA" with no shared harness, hardcodes one board to save compute (demo = rigged board), self-admitted impact problem. Counter-offer if he wants in: join the footage search as an engineer
- **Housing idea details**: see `housing idea.md`
- **Find my dog**: rescue vertical merged into the frontrunner — strongest emotional hook in the repo and a direct lift for its weakest column (Tooling 7). Demo spine is the real Luna rescue (Yellowstone, Sept–Oct 2026): sighting fusion + trap placement are the product's exact job, done by hand. Drone demoted to a footage-source footnote per the bucket-4 row in `restrictions.md`; drift rules recorded (animal-only re-ID; the tool finds the pet, never the person). Build adds two platform pillars: reference-photo re-ID and next-search planning. See `find my dog.md`
