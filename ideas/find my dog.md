# Find my dog

The rescue vertical for the footage-search frontrunner (`footage search.md`), merged into it per the Oct 26 dialogue: the rescue becomes the platform's flagship mission and the spine of the 3-minute demo, and it funds two new pipeline capabilities the platform did not have. The demo spine is the real Luna rescue in Yellowstone (Sept–Oct 2026). Scored ≈8.3 on the rubric and logged as a merged verdict (see `evaluated.md`).

**Raw capture (Oct 26):** "Program a drone to search an area, and stream camera footage back or post-process it. Use photos of a lost dog to determine its location."

## What it is

When a pet goes missing, the search is blind: forty volunteers, clips scattered across the neighborhood, sightings phoned in to whoever answers, and no idea where to look tomorrow morning. This vertical ingests every piece of footage contributors voluntarily hand over, finds the dogs in it, decides **which one is yours** from your own photos, and answers the real question: **where should the search go next?**

- **Who benefits:** the hard cases of pet loss — and the volunteer recovery organizations already working them. Roughly 10M pets go missing per year in the US and only about 1 in 5 strays entering shelters are reclaimed; most recoveries happen fast and without software, so the wedge is the days-long search. Today that work runs on paper leaflets, phone calls, and one hand-built sighting log (see the Luna case below)
- **Problem statement:** Build for Your World — the pet-recovery world. Demo spine: the real, press-documented Luna rescue (AP, Guardian, NBC, October 2026)
- **Why it is ban-safe:** footage is contributed by each camera's owner (private property, owners' own cameras — the incumbent's safe form); retrieval and decision support, never judgment; attribute matching on an animal, never person re-ID; no live public-space patrol
- **Why it is a platform play, not a one-off:** both new capabilities generalize. Reference-photo re-ID is "find *this specific* object"; search planning is "where and when to look next"

## The Luna case — the demo spine

Luna, a 10-year-old Jack Russell terrier, escaped her family's cabin at Canyon Village in Yellowstone on September 10, 2026. For five weeks she was spotted across the park — crossing roads, wandering employee housing, slipping into lodges through automatic doors — while people who chased her drove her deeper into the wild. Volunteer Katie Boucher and the Norris Ark Training and Recovery Center tracked the sightings by hand, built a live trap scented with the family's clothing (no food — it attracts bears), and caught Luna on October 14. She was underweight but healthy, and reunited.

Why it is the right spine:

- **It is the product's exact job, done by hand.** Boucher fused scattered sightings into a movement model — "Luna retraced her family's steps" — and the tool's two new pillars are precisely that work: re-identification ("a dog matching Luna's features" → this is Luna) and planning (where to put the trap)
- **It resolves, on national news, weeks before submission.** The video ends on a real reunion, and shows the tool's place: decision support for the searchers, never a replacement
- **The real failure mode is in it.** Chasing drove Luna deeper; the tool's plan output includes operational posture (observe, don't approach) — true to the case and to recovery best practice

## What it adds to the frontrunner

Two new load-bearing stages:

- **Pillar A — reference-photo re-ID plus "why not this dog" verification.** SAM 3.1 prompted with "dog" finds every dog in every clip; the pillar decides *is this Luna*. Each dog track gets embedded and compared against the owner's reference photos, then Muse Spark checks an attribute list ("white coat? pointed ears? gray collar?") and returns accept/exclude reasons. The trust moment of the demo is **rejecting a lookalike with reasons**
- **Pillar B — next-best-search planning.** Muse Wonder reasons over the sighting history with Active Memory, plus time of day, terrain, and temperament notes, and outputs likely zones, the next search window, and operational posture (watch vs. trap vs. do-not-approach). Retrieval becomes a decision

| Stage | Model / owner | Change vs frontrunner |
|---|---|---|
| Perception | SAM 3.1, self-hosted on Modal | prompt narrows to "dog"; probe attribute prompts at office hours |
| Re-ID + verification | open embedding model on Modal + Muse Spark | **new** — Pillar A |
| Timeline | ours | sightings map across contributed sources: lodge and porch cameras, visitor phones, trail cams, the owner's drone |
| Planning | Muse Wonder | **new** — Pillar B |
| Voice | Muse Voice Transcribe | phoned-in sightings and the owner's description become structured input; in the real case sightings arrived by calls from locals and tourists |
| Report / poster | fine-tuned open weights (LoRA) + Muse Image | recovery-org hand-off summary; shareable last-sighting poster (the dog's real photo, never a generated one) |

The frontrunner's credit-budget invariant applies unchanged: perception is cached once per clip, and the LLM never re-watches video. When the build starts, `architecture.md` gets the two new stages and the drift rules folded in.

## The drone's place

Deliberately the smallest scope in the plan. `info/restrictions.md` lists "Drones, target recognition, ISR, anything defense" under bucket 4, and a drone sweeping an area is ISR-shaped even when the target is a dog. So the drone is a footage source only: the owner flying their own drone over their own or permitted land, same as any contributor's phone. Never the headline, one clause in the video at most. In the reconstruction, any drone clip is filmed outside the park — NPS rules prohibit drone flights in Yellowstone.

## Demo structure (3 minutes)

Every recreation is labelled on screen; the Luna facts are cited to press coverage.

1. **0:00 — the real story.** "On September 10, 2026, Luna slipped out of her family's cabin in Yellowstone. For five weeks: sightings — but never a plan." Poster, the park on a map
2. **0:30 — search.** The owners hand over what a search like this collects: lodge and porch camera clips, visitor phone videos, a drone pass over the canyon edge (recreations, labelled). Luna's description arrives by voice note; candidates light up across sources; three lookalikes rejected with reasons; one sighting confirmed — "Luna, 0.87"
3. **1:15 — the timeline.** The object-timeline moment: her trail across the park on a map, and the insight the search actually had — she is retracing her family's steps
4. **1:50 — the plan.** "Where do we put the trap?" Likely zones, the next search window, and posture: watch, don't chase — chasers drove her deeper. Scent bait from the family's clothing, not food
5. **2:20 — the resolution.** October 14: the trap works. Underweight, healthy, reunited — credited to the volunteers who did it by hand
6. **2:45 — platform line.** "Every camera you can get, searched for the one that matters" — then one beat that this is a product for any footage, shops included. The rescue is the mission; the platform is the product

## Demo footage plan

No search footage from the real cases is public and press media is not reusable without clearance, so the video reconstructs everything:

- **Reconstruct, label, repeat.** A stand-in dog, a porch/lodge-style camera, a trail cam, phone clips from a "search day", one drone pass on private or permitted land. On-screen "Recreation" labels throughout
- **Cite the press story in narration** (AP/Guardian/NBC, October 2026) — facts are citable, media is not reusable without permission
- **Optional stretch, permission-only:** ask the Norris Ark recovery center for a quote — only with their consent, and never implying partnership or endorsement

## Drift rules (non-negotiable)

- Animals and objects only. Never person re-ID, never "find whoever took the dog" — that turns retrieval into an investigation, and investigations are judgment. If a pet was taken rather than lost, the tool still finds only the pet; humans decide what happens next
- Every camera's owner contributes its own footage; no scraping public cameras, no patrol framing
- Outputs are "candidate sighting" with confidence and reasons until a human confirms; planning is likely zones and decision support, never a guarantee
- The demo labels every recreation, and the real story's resolution is attributed to the people who actually did it

## Competitive read

- Petco Love Lost already does pet facial recognition, but only photo-to-database matching for *reported* found pets — it cannot search raw footage and does not plan a search
- Thermal-drone pet searches exist as services: human-flown, one asset, no re-ID, no cross-source timeline
- Volunteer recovery orgs (like Norris Ark) are users, not competitors — they do the sighting fusion and trap planning by hand today
- Enterprise video search (Verkada, BriefCam) is the incumbent platform's market story; none of it serves a family with a missing pet

## Open items

- [ ] Confirm the Luna coverage to cite (AP/Guardian/NBC; check for a first-source piece)
- [ ] Reconstruction shot list: stand-in dog, camera setups, locations, "Recreation" labelling design
- [ ] Motivation framing for the written submission (pending decision)
- [ ] Office hours: SAM 3.1 attribute prompting; embedding model choice for re-ID (open weights on Modal preferred)
- [ ] Fine-tune target: re-ID verifier vs. report writer (one LoRA for the hackathon, not two)
- [ ] Fold the two new stages and the drift rules into `architecture.md`; update the mission line in `footage search.md`
- [x] Scored through `skills/evaluate-idea/SKILL.md`: ≈8.3, merged verdict logged to `evaluated.md`
