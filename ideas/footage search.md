# Footage search — current frontrunner

=="Google for your cameras."== Still unnamed — candidates: Recall, Rewind, Replay.

## What it is

Businesses sit on thousands of hours of security footage and scrub manually. Upload footage, type what you're looking for in plain English — "guy in red hoodie with a backpack" or "the white van's second visit" — get the exact clips in seconds, then a timeline of where that object appeared across all cameras.

- **Who benefits:** shops, warehouses, insurers, anyone with more cameras than people. Retail shrinkage alone is ~$100B/yr in the US
- **Why it's legal:** retrieval, not judgment. Not advice, doesn't grade people, no war. Private property + owner's own cameras + loss prevention = standard commercial security
- **Why it beats "simple image analyzer":** temporal — tracks objects across time, builds a searchable history, answers questions across clips. The timeline layer is the product

## Pipeline (the one-stack answer)

```
[Perception]  SAM 3.1 (self-hosted on Modal) → masks + tracks per object, cached once per clip
[Labeling]    Muse Spark → one call per object crop → "white SUV, pallets"
[Timeline]    ours → track events into a queryable store (appear/disappear/move/meet)
[Reasoning]   Muse Spark (cheap queries) + Muse Wonder (cross-session memory: "has this van been here before?")
[Reports]     fine-tuned open-weights model (Modal LoRA) → incident summary from track tables
[Delivery]    ours: Next.js → time-scrubber UI, segmentation overlay, query box
```

Meta owns the model rows; the two "ours" rows are the depth score. Voice-in via Muse Voice Transcribe as a demo garnish.

## Demo structure (3 minutes)

1. **0:00** — a person manually scrubbing hours of footage. The pain (15 sec)
2. **0:15** — our tool: type "guy in red hoodie with a backpack" → clips. Latency on screen
3. **0:45** — three more queries, escalating difficulty ("the white van's second visit")
4. **1:30** — click a result → full timeline of that object across every camera (the OVERWATCH moment)
5. **2:15** — vision line: "Every camera you own, searchable like Google."

Recorded video = pre-process everything overnight, search *feels* live. If a clip tracks poorly, pick a different clip — failure mode ≈ zero.

## Competitive read

- 90% of participants: chatbots over documents, study helpers, image-gen apps — one model, one step, no memory
- The SAM users: one-shot segmentation demos, one clip, "isn't this cool"
- Incumbents (Verkada, BriefCam) exist for the market story but not the hackathon — the differentiator here is plain-English temporal search + the fine-tune + demo quality

## Open items

- [ ] Name pick
- [ ] Confirm SAM 3.1 API pricing vs self-host costs (ask at kickoff/office hours)
- [ ] Source demo footage (public datasets / CC clips with people + vehicles)
- [ ] Decide fine-tune target: report writer vs query router
