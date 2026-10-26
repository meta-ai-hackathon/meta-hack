# Idea brainstorm pool — 50 candidates scored

First-pass exploration pool from a two-lens sweep (Push the Frontier + Build for Your World), ban-tested against `info/restrictions.md` and quick-scored with the rubric anchors from `info/idea judge workflow.md`. These are triage scores for conversation, not judge-workflow verdicts. Anything worth pursuing gets the full treatment in `skills/evaluate-idea/SKILL.md` and a row in `ideas/evaluated.md`.

Incumbent anchor: footage search, 9/7/9/8 = **8.3**. Bands: 7.5 and above = serious contender, pressure-test the 10-day build. 6.0 to 7.5 = alive only if merged into the incumbent. Below 6.0 = park. G marks a gray zone with the framing discipline that keeps it safe.

## The pool, best first

### 1. House-Twin — 8/9/8/8 → **8.25**

**What it is.** A homeowner films short walkthrough videos of their house on their phone over weeks or months, pointing the camera at rooms, closets, and shelves as they go. The system ingests all of that footage, and Wonder's Active Memory fuses it across sessions so every object gets a persistent identity that survives between videos. When the user later asks a question in plain language, like "show me everywhere the red extension cord has been", the system returns a montage of clips; ask "when did we last paint the deck?" and it answers with the actual footage. The demo's 10-second moment is asking a months-spanning question and getting a sourced clip back instantly.

- **S:** Both SAM 3.1 at scale and Wonder's cross-session memory are load-bearing, so the build is clearly differentiated. The demo is fully pre-recordable, which drives demo risk near zero.
- **W:** The scope of a 10-day build is huge, and it needs a fabricated months-long footage archive to demo at all. Two hard systems have to both work for the pitch to land.
- **O:** Merge path into the incumbent's stack: it is the footage-search moat extended from a single archive into a living memory. Credit ask: large Wonder memory quota plus Modal GPU hours for bulk segmentation.
- **T:** Ring and Nest sell event timelines, but they are shallow, single-camera, and have no cross-video fusion. The strongest judge objection is "you clearly faked the archive"; counter it by showing the ingestion pipeline live on a fresh clip.

### 2. Grandma-Tales — 8/8/9/6 → **7.85**

**What it is.** A family records an oral-history interview with an elder, say a grandparent, using their phone. Muse Voice Transcribe turns the conversation into text, and Wonder's Active Memory remembers every prior session. So when session three opens, the interviewer's copilot says "last time you mentioned the flood of '78, what happened to the boat?", continuing a story arc no human could keep track of across dozens of sessions. The demo's moment is hearing the system recall a detail from two hours of earlier tape and watching the elder light up because it remembered.

- **S:** Fully pre-recordable, so live-failure risk is zero. Emotional continuity across sessions is the wow, and Wonder's memory is not a bolt-on, it is the product.
- **W:** Technical depth is the weak column: this is mostly orchestration and UX around an existing memory engine, so judges may score the build as light.
- **O:** A vertical that lifts Impact: elder-care and memory-care institutions. Credit ask: Wonder memory quota, which is the raw material of the product.
- **T:** StoryWorth (human-prompted, no memory engine) and HereAfter AI (static recordings) are real competitors. The judge objection is "a cron job and a prompt does this"; counter by showing retrieval of a specific cross-session callback.

### 3. TouchGraph — 8/8/8/7 → **7.80**

**What it is.** Anyone assembling flat-pack furniture points their phone camera at the table with scattered parts on one side and a half-built project on the other. SAM 3.1 identifies and tracks every part across frames, while Spark has already parsed the printed manual into discrete steps. The screen then labels each part in place and pulses a "grab me" highlight on the next piece needed. The demo's moment is pointing the phone at chaos and watching it light up the exact bracket you are missing.

- **S:** Universal pain, since everyone assembles furniture badly. The fusion of perception, manual parsing, and live AR is clearly differentiated.
- **W:** Competitors exist: IKEA's AR manuals are shipped, though only for IKEA kits with published 3D models, while this is any kit. The live AR tracking must not jitter on camera, which is a real demo risk.
- **O:** Merge into the incumbent's stack as "point the camera at anything and it explains it". Credit ask: Modal GPU hours for near-real-time handheld tracking.
- **T:** IKEA's AR manuals are the named threat, with the rebuttal that they cover only their own catalog. The judge objection is "the tracking will drift mid-demo"; mitigate with a pre-recorded fallback.

### 4. MoltCam — 6/9/8/8 → **7.65**

**What it is.** A beekeeper mounts a cheap camera over the entrance of a beehive. SAM 3.1 tracks hundreds of individual bees by wing pattern and body marks, never by faces, across days of footage. The system counts traffic in and out of the hive and flags a robbing raid when intruder bees suddenly swarm the entrance. The demo's moment is watching a live counter of hundreds of separately identified bees and then seeing the raid alarm fire on playback.

- **S:** Tiny-fast-multi-object tracking is a genuine perception frontier, and the Meta tooling column scores honestly high. Animals only, so there is no people-tracking gray zone.
- **W:** Beekeeping is a niche market, which caps the Impact column no matter how good the perception is.
- **O:** The tracking engine merges straight into the incumbent's footage-search stack for any many-small-objects domain. Credit ask: Modal GPU for multi-hour sustained inference.
- **T:** Academic bee-tracking papers exist, but no consumer tool does. The judge objection is "great for bees, but who pays"; answer with the generalizable tracking layer.

### 5. Fridge Physics — 6/8/9/8 → **7.65**

**What it is.** A user uploads any video of a physical event, such as a ball rolling off a table or two mugs colliding. SAM 3.1 extracts the objects and their trajectories frame by frame, and Wonder fits physics parameters to what it sees. The system then pauses the video right before the outcome and predicts what will happen, before revealing the truth. The demo's moment is the predict-then-reveal beat: the system calls "the mug tips and rolls left" and the video confirms it.

- **S:** The predict-then-reveal demo is deterministic and pre-renderable, arguably the best pure demo moment in the pool. Real-video prediction is something nothing consumer-grade attempts.
- **W:** Reads education-adjacent to judges, and the hackathon's banned zone includes edu chatbots; this must be framed as a prediction engine, not a tutoring tool. Impact scores modestly because the audience is unclear.
- **O:** None by way of credits; the pipeline merges into the incumbent's stack as a "what happens next" module over any footage.
- **T:** No direct competitor: PhET sims are synthetic, and nothing does prediction over real video. The judge objection to pre-empt is the edu framing; lead with prediction, never with learning outcomes.

### 6. Plumber's Ghost — 7/8/9/6 → **7.55**

**What it is.** A homeowner points a phone camera at a wall while someone else turns a shutoff valve elsewhere in the house. SAM 3.1 watches the fixtures and pressure-sensitive cues on video, and Wonder reasons about the plumbing topology behind the surface. The result is a probability heatmap of hidden pipe routes that paints itself onto the wall in AR. The demo's moment is flipping a valve and watching the pipe map bloom across the wall.

- **S:** Spectacular demo and a universal homeowner pain. No consumer-grade competitor exists; stud finders are the nearest object.
- **W:** The underlying physics is partly speculative, so the wow is somewhat fakeable, and honest judges will probe how the inference actually works.
- **O:** Merges into the incumbent's stack as "X-ray vision for the house", a vertical that lifts Impact for contractors. Credit ask: none.
- **T:** No named competitor, so the strongest judge objection is "the heatmap is theater"; counter with a calibration segment showing the map matching a real pipe on camera.

### 7. Language of Machines — 6/8/8/7 → **7.20**

**What it is.** A user points a phone at any appliance, such as a washing machine or furnace, and hears its "diary". A Glimmer model fine-tuned on appliance manuals and failure corpora reads the model plate, listens to sounds and vibration captured on video, SAM 3.1 isolates the relevant parts, and Spark narrates a guessed maintenance history plus one sensible next check. The demo's moment is filming a rattling appliance and hearing it tell you what is probably loose.

- **S:** The fine-tune play hits the $10K open-weight bonus. Multi-signal input (vision plus audio plus text) gives real technical depth.
- **W:** Must be framed strictly as diagnostic hints, never repair advice, or it crosses into regulated territory. Impact is capped because the audience needs the framing to land.
- **O:** Merges into the incumbent's demo as "point at anything, get its story". Credit ask: Baseten headroom for the fine-tune.
- **T:** iFixit forums are the human-powered incumbent, but no appliance-listening product exists. The judge objection is "this is a manual lookup with extra steps"; counter with the audio-inference beat.

### 8. Sound of Structure — 6/8/8/7 → **7.20**

**What it is.** A person taps or knocks along a shelf, a table, or a guitar body while a microphone records. A fine-tuned open-weights model maps the acoustic signatures to internal structure, and SAM 3.1 maps the surface geometry from video at the same time. A live heat map of "hollow" versus solid spots appears over the object on screen. The demo's moment is dragging a finger along a cracked shelf and watching red bloom where the void is.

- **S:** The live heat-map demo is strong and fully pre-recordable. Fine-tuning hits the open-weight bonus.
- **W:** Must be framed as an inspection aid, never structural certification, to stay clear of liability. Impact is capped by the niche audience.
- **O:** Pairs with the incumbent's stack as a "point the camera, learn the truth" module for home inspection. Credit ask: Baseten for the audio fine-tune.
- **T:** Professional acoustic inspection exists but is industrial-only, so no consumer competitor. The judge objection is "the heat map is vibes"; mitigate with a known-void calibration object on camera.

### 9. Babel Fish for Animals — 6/8/8/7 → **7.20**

**What it is.** A pet owner points a camera at their dog or cat and gets a live caption of what the animal is doing: play bow, soliciting food, stress signals. A Glimmer model fine-tuned on labeled ethology corpora, which are scientific animal-behavior datasets, classifies the behavior from video, while SAM 3.1 tracks the body parts across frames. The demo's moment is two dogs play-fighting on camera while the system captions each move in real time.

- **S:** Delightful demo with a huge audience of pet owners, and the fine-tune plus multi-object tracking gives honest depth.
- **W:** This is a gray zone: the system must stay on observable behavior categories, never diagnose feelings or health, and never "grade" the animal. Impact depends on the audience buying behavior captioning as useful.
- **O:** Merges into the incumbent's stack as "search and understand anything on camera", animals included. Credit ask: Baseten plus behavior dataset labeling time.
- **T:** No consumer-grade competitor exists. The judge objection is "captioning pets is a toy"; counter with the ethology-grounded dataset story and the gray-zone discipline line.

- **Gray-zone discipline:** Keep to observable behavior categories only; never diagnose feelings or health and never "grade" the animal.

### 10. Robot Gardener's Eyes — 6/8/7/8 → **7.15**

**What it is.** A gardener installs a cheap camera rig over a garden bed and lets it watch for weeks. SAM 3.1 gives every plant a persistent ID and tracks its growth curve over the whole period, and Wonder's Active Memory flags stress days, such as a droop or discoloration onset, before a human would notice. The demo's moment is a time-lapse where each plant carries a sparkline and the system points at the day one plant started failing, weeks before anyone saw it.

- **S:** Long-horizon re-identification of individual plants is genuinely hard, which scores depth honestly. Plant health is not medical advice, so the regulatory risk is low.
- **W:** Needs weeks of real footage, so the demo must be pre-recorded. The Impact column is capped by a hobbyist audience.
- **O:** Merges into the incumbent's demo as "persistent identity over long footage", the same moat footage search has. Credit ask: Modal GPU for a continuous low-rate stream.
- **T:** Nature cams and garden cameras exist, but none with per-plant identity. The judge objection is "you sped up footage you staged"; show the pipeline on a fresh two-hour segment.

### 11. Robot Hand Teacher — 6/8/7/8 → **7.15**

**What it is.** A user shows a cheap robotic arm a pick-and-place task a handful of times: put the red block in the tray. SAM 3.1 tracks the grasp target from the camera, Spark decomposes the task into steps, and the system learns the motion well enough to generalize to objects it has never seen. The demo's moment is showing it a mug and watching it pick up a bowl it has never touched.

- **S:** Classic robotics wow with a clean "Push the Frontier" framing. Generalization from few demonstrations is real technical depth.
- **W:** Hardware reliability on camera is the standing risk, so the safe take must be pre-recorded. Impact is limited because nobody in the audience owns a robot arm.
- **O:** Merges into the incumbent's stack as "SAM tracks the object, the system acts on it". Credit ask: Modal GPU for the learning loop.
- **T:** Research demos exist in labs, but no consumer product. The judge objection is "the arm fails on camera"; always pair the live attempt with the pre-recorded success.

### 12. Time-Lapse Augury — 5/8/8/8 → **7.10**

**What it is.** A user uploads years of footage from a fixed webcam, such as a backyard or a street corner. SAM 3.1 segments decades of change across the archive, and Wonder narrates the invisible forces: erosion, repainting, plant species moving in and out, structures appearing and vanishing. The demo's moment is compressing five years of a backyard into 60 seconds while the system calls out each change as it happens.

- **S:** Structural and environmental change narration is a memorable, novel use of the stack, and the depth column scores honestly for a long-archive pipeline.
- **W:** This is a gray zone: people must be masked and never re-identified, and only structural and environmental change is described. Sourcing years of footage is a real data problem.
- **O:** No credits needed; the pipeline merges into the incumbent's stack as "search a long archive for change". Credit ask: none.
- **T:** No direct competitor exists. The judge objection is "where did the archive come from"; have a licensed or self-shot source ready to name.

- **Gray-zone discipline:** Structural and environmental change only; people are masked and never re-identified.

### 13. Scaffold-Counter — 7/7/8/6 → **7.05**

**What it is.** A trade contractor films a single walk through a jobsite with a phone. SAM 3.1 counts materials, such as studs, drywall sheets, and pallets, and gives each one a persistent ID so a pallet filmed twice is never counted twice. Spark then drafts the material report from the tally. The demo's moment is walking one aisle once and watching a live tally build up on screen.

- **S:** Clean, low-risk demo: walk an aisle, get a number. The system counts objects, never people, which keeps the privacy story clean.
- **W:** Impact is capped by a B2B-niche audience, and the counting pipeline itself is not deep science.
- **O:** Merges into the incumbent's stack as "search and audit footage with persistent IDs". Credit ask: Modal for self-hosted SAM on long video.
- **T:** Manual counting apps exist, but none use video persistent IDs. The judge objection is "a spreadsheet does this"; counter with the one-walk no-double-count beat.

### 14. Handy-Replay — 7/7/8/6 → **7.05**

**What it is.** A DIYer films the broken faucet while narrating the problem, then films the repair. Wonder's Active Memory builds a running house repair history from these clips, and months later the user can voice-recall it: "when did I fix the upstairs valve?" The system answers with the date and the actual video clip as a receipt. The demo's moment is asking a months-old repair question and getting the clip back on the spot.

- **S:** Documentation-not-coaching framing keeps it clear of advice bans. The recall-with-receipts beat is a strong, easily staged demo.
- **W:** Impact is capped: a personal repair diary is useful but narrow. The pipeline is mostly orchestration around Wonder's memory.
- **O:** Merges directly into the incumbent's stack; it is footage search with a household vertical. Credit ask: Wonder quota.
- **T:** Home inventory apps exist, but all require manual entry. The judge objection is "just write it down"; counter with the zero-effort capture story.

### 15. Lobby-Transcribe — 7/8/7/6 → **7.05**

**What it is.** A town clerk or HOA board member records public meetings: town halls, HOA sessions, planning commission hearings. Muse Voice Transcribe handles the audio, and Wonder's Active Memory remembers every prior meeting. When a topic comes up again, the system surfaces "this was tabled twice already" with citations to the exact earlier meetings. The demo's moment is a live remark triggering an instant citation to a meeting from months back.

- **S:** Institutional memory is a real, underserved pain for small governments and associations. The Meta tooling column scores well because memory plus transcription are both load-bearing.
- **W:** Transcription must stay strictly neutral on political content, which constrains the product surface. Impact depends on a slow-moving buyer.
- **O:** Merges into the incumbent's stack as "search across long audio-video archives with memory". Credit ask: Wonder runtime quota.
- **T:** Granicus and CivicPlus sell meeting transcription to municipalities, but without memory across meetings. The judge objection is "too boring to win a hackathon"; the citation moment is the rebuttal.

### 16. MotionSeed — 6/7/9/6 → **7.00**

**What it is.** A child or creator draws a creature on paper, then points a phone camera at the desk. SAM 3.1 segments the sketch out of the camera feed, Muse Image generates a set of walk poses for it, and the doodle then "walks" across the real desk in AR as the user tilts the phone. The demo's moment is watching your own drawing come to life and stroll across your actual desk.

- **S:** Pure magic demo with universal appeal to kids and creators. The live AR beat is the kind of moment judges remember.
- **W:** Technical depth is thin: it is pipeline glue around segmentation and image generation, and judges may notice.
- **O:** No credits needed; the sketch-to-AR beat merges into the incumbent's demo as a crowd-pleaser. Credit ask: none.
- **T:** No consumer-grade competitor exists. The judge objection is "this is a weekend hack"; lean into polish and the end-to-end flow instead of depth.

### 17. Choreography Copier — 6/7/9/6 → **7.00**

**What it is.** A dancer films any 10-second dance move or physical skill from the front. SAM 3.1 tracks the body parts frame by frame, and the system composites a translucent "ghost" of that performer alongside the user's own live camera view, so they can mirror the movement in real time. The demo's moment is learning a move off a ghost of a pro dancer standing right next to you on screen.

- **S:** The dance audience is enormous, and the ghost-mirror demo is instantly legible. Nine on demo is honest.
- **W:** This is a gray zone: positional ghosting only, never scores or grades the human. Depth is thin, mostly tracking plus compositing.
- **O:** No credits needed; it merges into the incumbent's stack as a "watch and learn from footage" feature. Credit ask: none.
- **T:** Dance-tutorial mirror tools exist but are thin. The judge objection is "just a video overlay"; counter with the frame-accurate body tracking story.

- **Gray-zone discipline:** Positional ghosting only; never scores, rates, or grades the human.

### 18. Printer Failure Sentinel — 6/7/8/7 → **6.95**

**What it is.** A 3D-printing hobbyist points a webcam at their printer before starting a long job. SAM 3.1 tracks the layer geometry over time, and Wonder reasons about known failure patterns such as spaghetti blobs, warping, and detaching prints. When a failure pattern matches mid-print, the system kills the job automatically and alerts the user. The demo's moment is watching a print go visibly wrong and the system cutting it seconds later.

- **S:** Dramatic save-the-print demo, and failure footage is easy to produce on demand for a controlled take.
- **W:** Obico (formerly The Spaghetti Detective) already exists in this exact niche, so the Meta Tooling column cannot honestly go higher. Impact is capped by the hobby market.
- **O:** Merges into the incumbent's stack as real-time anomaly monitoring over video. Credit ask: none.
- **T:** Obico/The Spaghetti Detective is the named competitor. The judge objection is "this exists"; answer that none use segmentation-grade geometry tracking.

### 19. Tabletop-Turns — 5/8/7/8 → **6.85**

**What it is.** An overhead camera watches a group playing a board game. SAM 3.1 gives every piece a persistent ID and rebuilds a full game-state log, turn by turn. The group can then pause a three-hour game for a week and resume from any turn snapshot, or scrub backward through the game like a video timeline. The demo's moment is scrubbing a real game back twelve turns to settle a "what actually happened" argument.

- **S:** A time-travel scrubber over a physical game is a novel demo. Depth scores well because persistent multi-object reconstruction over long video is genuinely hard.
- **W:** Board gamers are passionate but niche, which caps Impact. The score also sits low on Impact because the use case is recreational.
- **O:** Merges into the incumbent's stack as "reconstruct and search long footage state". Credit ask: Modal SAM on long video.
- **T:** No dominant tool does video game-state reconstruction. The judge objection is "occluded pieces break it"; show recovery from a hand covering the board.

### 20. Tag-Sale-Scan — 7/7/8/5 → **6.85**

**What it is.** A reseller films a box of thrift-store finds with their phone. SAM 3.1 segments each item out of the footage, Spark drafts marketplace listings with search-optimized titles and descriptions, and Muse Image generates clean hero shots for each listing. The demo's moment is dumping a junk box on a table and walking away with a grid of ready-to-post listings two minutes later.

- **S:** Resellers are a real money market that will adopt tools that save hours. The junk-box-to-listings-grid demo is deeply satisfying to watch.
- **W:** Technical depth is thin, mostly pipeline glue around existing models. Competitors with resources are adjacent.
- **O:** Merges into the incumbent's stack as "segment and describe everything on camera". Credit ask: Image generation quota for the hero shots.
- **T:** eBay's own scan tools and listing services are the named threat. The judge objection is "eBay will ship this"; answer that this works across any marketplace with any phone.

### 21. Garage-See — 7/7/8/5 → **6.85**

**What it is.** A homeowner waves a phone camera across a cluttered garage in one continuous pan. SAM 3.1 segments every item across the footage, Spark labels them cheaply, and the result is a searchable "what do I own and where" inventory with shelf locations. Asking "where's the torque wrench?" returns a thumbnail of the wrench and the shelf it sits on. The demo's moment is that question getting answered with a photo in two seconds.

- **S:** Instantly understood value; everyone has a junk drawer or garage. The demo is simple and repeatable.
- **W:** Depth is thin: segmentation plus labeling plus a search index. The wow fades after the first minute.
- **O:** Merges into the incumbent's stack as a vertical of footage search with persistent object identity. Credit ask: Modal GPU time for the pan ingestion.
- **T:** Sortly and other home-inventory apps exist, but all require manual entry. The judge objection is "one pan per shelf is fragile"; show a re-scan merging into the same index.

### 22. Grocery Ghostwriter — 7/6/8/6 → **6.80**

**What it is.** A webcam or phone camera sits above the fridge or pantry and keeps persistent IDs on food items as they come and go, with expiry reasoning on each. One tap turns "what's dying in here?" into a use-everything dinner plan that Spark generates from the expiring items. The demo's moment is opening the app after a week and getting a real recipe built from exactly what would otherwise be thrown out.

- **S:** Auto-inventory on door-open is visceral and needs zero manual entry. The food-waste angle is relatable and universal.
- **W:** Must stay inventory plus recipes, never nutrition claims, to avoid regulated territory. Several smart-fridge and pantry apps exist, and most are abandoned or hardware-bound.
- **O:** Merges into the incumbent's stack as persistent object tracking with temporal reasoning. Credit ask: none.
- **T:** Existing smart-fridge and pantry apps are the named competitive space. The judge objection is "the camera will misidentify items"; show expiry reasoning on a controlled pantry.

### 23. Print an Instrument That Plays Itself — 4/7/9/8 → **6.80**

**What it is.** The system uses generative geometry to design a novel acoustic instrument that has never existed, which is then 3D printed. A camera-tracked robotic mallet then performs music that Spark composed specifically for that instrument's own strange overtone signature. The demo's moment is hearing a piece of music played by an instrument that was invented, printed, and programmed the same week.

- **S:** Unforgettable demo, likely the most memorable in any room. Genuine engineering depth in the design-simulate-print-perform loop.
- **W:** The art-piece nature of the project caps Impact; it is a showpiece, not a tool anyone adopts. The pipeline is long and every stage can fail.
- **O:** Merges into the incumbent's demo as a headline wow rather than a product. Credit ask: Modal GPU for the acoustic simulation.
- **T:** No direct competitor. The strongest judge objection is "cool art, but so what"; frame it as a generative design pipeline, not an instrument.

### 24. Reverse LEGO — 6/7/8/6 → **6.75**

**What it is.** A user photographs a built LEGO-style model from a few angles with their phone. SAM 3.1 decomposes the model into its parts and build stages, Spark writes step-by-step assembly instructions, and the screen plays an animated teardown showing how it comes apart layer by layer. The demo's moment is pointing a phone at a mystery cousin-built model and getting a rebuildable instruction manual.

- **S:** Strong demo wow with an intuitive inverse-problem story. The teardown animation is a memorable beat.
- **W:** The pipeline is orchestration-heavy and the depth column is middling. Occlusion from a few photos is a hard perception limit.
- **O:** No credits needed; merges into the incumbent's stack as "understand any object on camera". Credit ask: none.
- **T:** Brickit is the named competitor: it scans loose bricks to suggest builds, and the inverse direction, model to instructions, is open. The judge objection is "occlusion makes the decomposition guesswork"; demo with a symmetric model.

### 25. Zoo of Zines — 6/7/8/6 → **6.75**

**What it is.** A hobbyist dumps a physical collection, such as rocks, stamps, or pressed leaves, on a white page and films it. SAM 3.1 segments and clusters the specimens, Spark writes field-guide entries in a chosen authorial voice (say, a Victorian naturalist), Muse Image draws plate art for each specimen, and the system outputs a printable PDF zine. The demo's moment is a pile of backyard rocks becoming a bound, illustrated field guide in minutes.

- **S:** The end-to-end physical-to-printed arc is a great demo story with a tangible artifact to hand judges. Multiple Meta models all pull real weight.
- **W:** The hobbyist audience caps Impact. The pipeline has many stages, so demo-day failure surface is larger than average.
- **O:** No credits needed; merges into the incumbent's stack as "segment, describe, and narrate anything on camera". Credit ask: none.
- **T:** Field-guide apps exist, but they are manual entry with no generation. The judge objection is "a collage of prompts"; counter with the clustering and the physical artifact.

### 26. Family Photo Dating — 6/7/8/6 → **6.75**

**What it is.** A user hands the system an unlabeled box or folder of old family photos. A Glimmer model fine-tuned on visual-history corpora dates each photo using fashion, film stock, and compression-era cues, then Spark writes a contextual caption for each, and Muse Image restores damaged or scratched areas. The demo's moment is an anonymous pile of album photos becoming a dated, captioned, restored archive on screen.

- **S:** Emotional demo with a huge universal audience: everyone has an unlabeled album. The fine-tune earns the open-weight bonus honestly.
- **W:** Dating accuracy is unverifiable for the demo, which invites skepticism. Impact is capped because the use case is occasional, not daily.
- **O:** Merges into the incumbent's stack as "understand and enrich any archived media". Credit ask: Baseten for the fine-tune.
- **T:** Ancestry photo tools exist for manual dating by experts. The judge objection is "the dates are guesses"; show confidence intervals and let the caption say "circa".

### 27. SheetMusic-less Jam — 6/7/8/6 → **6.75**

**What it is.** A hobby musician hums a melody into their phone. Muse Voice Transcribe converts the humming into musical notation, Muse Spark arranges that melody into a playable part for their instrument, and when they practice the song the phone camera watches their hands and uses SAM 3.1 to overlay "ghost" position guides showing where their fingers should be next. The demo moment: hum a tune, watch it become sheet music, then see live finger-position guides appear over your own hands as you play it.

- **S:** The hum-to-notation-to-live-overlay arc is one continuous demo with no setup. Positional feedback from video is a clear SAM 3.1 use, and musicians are a large audience.
- **W:** Humming-to-notation accuracy is risky live, and transcription alone is not new. The overlay adds demo value more than depth.
- **O:** Positional guides could borrow the incumbent's overlay-over-camera-footage pattern directly. Credit ask: none.
- **T:** AnthoScore-like hum-to-transcription exists; the live hand overlay is the new part, so judges must believe the overlay is not a gimmick.
- **Gray-zone discipline:** positional feedback only ("where your fingers are"), never grades or scores the musician.

### 28. Mechanism Translator — 5/7/8/7 → **6.65**

**What it is.** A collector or tinkerer films an antique mechanical toy or pocket watch rotating slowly on a turntable. SAM 3.1 tracks every gear, lever, and part across the rotation, Muse Image renders an exploded-view diagram of the mechanism, and Muse Spark annotates what each part does. The demo moment: a rotating watch explodes into a labeled exploded diagram as it spins.

- **S:** The rotating-watch-explodes-into-diagram demo is spectacular and needs no live hardware beyond a turntable. Occlusion reasoning across rotation is genuinely hard, which carries the depth score.
- **W:** Collectors and horology fans are a small market, and Impact lands at 5 for a reason.
- **O:** The turntable-capture loop could plug into the incumbent's video pipeline unchanged. Credit ask: none.
- **T:** No consumer-grade competitor, so the strongest judge objection is "wonderful film at 11, but who pays for this?"

### 29. Dream Recorder for Robots — 4/8/8/7 → **6.60**

**What it is.** A hobby robot (a cheap arm or rover) logs its perception traces all day using SAM 3.1 object tracks. Overnight, Muse Wonder replays the whole day across sessions and writes a short self-narrated "dream journal" about what the robot noticed, including failures it wants to retry. The demo moment: the robot dreams about the door handle it failed to grasp, then succeeds the next morning.

- **S:** The dream-then-retry beat is memorable and nobody else has it. Cross-session Wonder memory is used at full stretch, which lifts Meta Tooling and Depth.
- **W:** Nobody pays for whimsy, so Impact is capped at 4. A robot failing on camera is also a live-demo risk.
- **O:** The nightly-reflection loop is the same cross-session memory pattern the incumbent could use for its own footage review. Credit ask: Wonder tokens for nightly reflection.
- **T:** No direct competitor; the judge objection is "cute research poster, not a product."

### 30. Shelf-Balance — 6/7/7/6 → **6.50**

**What it is.** A corner-store owner props a phone on a fixed camera mount pointed at one shelf for a day. SAM 3.1 detects which product slots are empty, hour by hour, and the system produces a restock-timing log plus a CSV of out-of-stock windows. The demo moment: a day of shelf video replayed in 60 seconds with empty slots lighting up as they go bare.

- **S:** Object-only tracking stays clear of people-gray-zones entirely. The day-in-60-seconds replay is a clean, self-contained demo with a real CSV artifact.
- **W:** The demo is dry compared to flashy entries, and a single shelf is a small claim.
- **O:** Reuses the incumbent's fixed-camera-plus-SAM pipeline directly, so it merges into the same stack almost for free. Credit ask: Modal for long-video inference.
- **T:** Retail shelf analytics (Trax and similar) exists for enterprise; the counter is that none of it is at phone price.

### 31. Ferry-Cargo — 6/7/7/6 → **6.50**

**What it is.** A driver or loader films inside a loaded van or trailer with their phone. SAM 3.1 segments the stacked cargo, and the system checks the unload order against last-in-first-out logic: it flags "the ladder is behind the boxes you unload first" with a visual overlay on the footage. The demo moment: the overlay highlights the buried item and shows the exact moment it becomes a problem.

- **S:** Spatial occlusion reasoning over masks is real technical work, not pipeline glue. The visual overlay matches the incumbent's demo grammar.
- **W:** Logistics crews are a narrow audience, and one-van demos understate the messiness of real trailers.
- **O:** The mask-occlusion module could feed the incumbent's timeline view for occluded objects. Credit ask: Modal for SAM.
- **T:** Load-planning software exists but is diagram-based, not camera-based; the judge question is whether crews will ever film their trucks.

### 32. Weld-Bead-Log — 5/7/8/6 → **6.45**

**What it is.** A hobbyist metalworker points a fixed camera at their welding bench. SAM 3.1 segments each weld bead's geometry, and Muse Wonder's cross-session memory links practice sessions over weeks into a progress log: weld number 1 versus weld number 40 shown as a visual diff. The demo moment: side-by-side beads from week one and week six with the improvement obvious.

- **S:** The progress arc is a strong emotional demo, and cross-session memory gives it a retention story most one-shot demos lack.
- **W:** Impact sits at 5 because welding hobbyists are a small slice, and the system must stay a logger, not a grader, to stay safe.
- **O:** The session-to-session progress log is a pattern the incumbent could reuse for any repeated activity. Credit ask: Modal plus Wonder.
- **T:** Industrial weld inspection exists at high cost; nothing at hobby price, but judges may ask why hobbyists would mount a camera at all.
- **Gray-zone discipline:** the BEAD is graded as an object and logged; never output a skill score for the person.

### 33. Yard-Sale-Orchestra — 5/7/8/6 → **6.45**

**What it is.** A window or pole camera films a whole yard sale. SAM 3.1 tracks every item from table to gone, and Muse Wonder's Active Memory builds a multi-year neighborhood resale price memory across sales, surfacing things like "your succulents always sell by 10am." The demo moment: a whoosh-through-the-day replay where each item flies to its price tag as it sells.

- **S:** The whoosh-to-price replay is delightful and the multi-year memory angle is a real Meta Tooling story. No direct competitor.
- **W:** Impact is capped because yard sales are episodic and low-stakes.
- **O:** The item-lifecycle tracking could merge into the incumbent's object timeline as a "where did it go" feature. Credit ask: Wonder plus Modal.
- **T:** No named competitor, so the objection is privacy-adjacent: filming a public sale must visibly exclude attendees.
- **Gray-zone discipline:** objects only, attendees must be masked out entirely.

### 34. Fractal Forge — 5/7/7/7 → **6.40**

**What it is.** A 3D printing hobbyist describes a structure in words, like "gyroid lattice, 8cm, printable." An open-weights generative model produces the geometry, a simulator checks printability, and after printing, SAM 3.1 scans the real object layer by layer and verifies it against the plan, marking where reality diverged. The demo moment: a failed bracket printed on camera, then the divergence map showing exactly which layers went wrong.

- **S:** The closed loop from prompt to printed object to verification is a full pipeline, and the failed-print reveal is a solid demo beat.
- **W:** The 3D printing audience is niche, and the generative-geometry part risks being weaker than existing CAD tools.
- **O:** The print-verification scan could reuse the incumbent's SAM comparison-over-time machinery. Credit ask: none.
- **T:** Print-farm monitoring tools exist but have no generative loop; the objection is that the geometry generation is the weakest link.

### 35. Repair-Part-Picture — 7/6/7/5 → **6.35**

**What it is.** A homeowner snaps a photo of a broken appliance part, like a cracked dishwasher rack wheel. SAM 3.1 isolates the part from the cluttered background, Muse Spark writes the exact part name and search string to order it, and Muse Image generates a clean diagram-style product shot. The demo moment: a blurry photo in, a precise "Frigidaire 154566501 lower rack wheel" search string out.

- **S:** Finding the right part string is a universal homeowner pain, so Impact is genuinely high for such a small product.
- **W:** Mostly pipeline glue around existing models, so Depth is thin, and part-number accuracy is unforgiving.
- **O:** The part-identification step could bolt onto the incumbent's search pipeline as a vertical. Credit ask: none.
- **T:** iFixit forums answer this with humans; the objection is that a wrong part number destroys trust instantly.

### 36. Move-Mates — 7/6/7/5 → **6.35**

**What it is.** Before packing for a move, you film each room of your home. SAM 3.1 inventories the furniture and boxes, and Muse Spark generates a box plan, printable labels, and warnings like "this couch will not fit the stairs." The demo moment: a walkthrough of an apartment becomes a labeled box manifest plus a couch-versus-staircase verdict.

- **S:** Everyone moves and everyone hates it, so the pain is universal and the demo is instantly legible.
- **W:** A one-time-use product has no retention, and the depth beyond the inventory scan is thin.
- **O:** The room-scan inventory is the same first pass the incumbent does on footage, so the capture pipeline is shared. Credit ask: none.
- **T:** Moving checklist apps exist without vision; the judge question is whether a phone scan beats a measuring tape for the stair fit claim.

### 37. Pantry-Barter — 6/7/6/6 → **6.25**

**What it is.** A neighborhood runs a swap network, like a group chat for trading stuff. Muse Wonder's Active Memory keeps each household's has-wants-traded ledger across weeks of chats and surfaces matches, like "you've both mentioned that stroller for three weeks." The demo moment: three weeks of chat history compressed into one surfaced two-way match with the ledger behind it.

- **S:** The cross-session memory use is legitimate and network-effects products have a big upside story.
- **W:** The match moment is mild on camera, and cold-start with many households is brutal for a live demo.
- **O:** The persistent per-participant memory ledger could seed the incumbent's long-term footage memory design. Credit ask: Wonder quota.
- **T:** Buy Nothing groups do this manually and human-run; the objection is that the demo needs fabricated weeks of history.

### 38. Camper-Setup — 6/6/7/5 → **6.05**

**What it is.** An RV or boat owner films their storage bays once, narrating as they go. Muse Voice Transcribe ingests the commentary, and Muse Wonder's memory turns it into a permanent voice-indexed encyclopedia of "where is everything in the rig," searchable by talking later. The demo moment: "where are the leveling blocks?" spoken at a campsite, answered with the bay and the clip.

- **S:** RV owners are a large niche and the mystery-bay pain is real. Voice-in, voice-out is a tidy demo loop.
- **W:** The tooling story beyond memory is thin, and filming bays once is a low bar for Depth.
- **O:** Voice-indexed memory retrieval is a component the incumbent could reuse for searching footage by spoken queries. Credit ask: none.
- **T:** Competing solutions are manual inventory spreadsheets; the objection is that a phone note does most of this.

### 39. Climate Costume Shop — 5/6/8/5 → **6.00**

**What it is.** You describe an event and a place, like "outdoor wedding, Lisbon, June." Muse Spark solves the clothing constraints from real weather data for that location and dates, Muse Image generates the garment, and sliding the location pin from Reykjavik to Dubai mutates the outfit live on screen. The demo moment: one outfit morphing across climates as the pin drags.

- **S:** The pin-slide mutation is a fun, continuous visual that demos itself with zero setup risk.
- **W:** Fashion plus climate is a narrow use, and the constraint-solving is shallow once you look behind it.
- **O:** The constraint-from-real-data pattern could harden the incumbent's demo with a verifiable ground-truth step. Credit ask: none.
- **T:** No named competitor; the objection is that a weather lookup plus image generation reads like a wrapper.

### 40. MemeFossil — 4/7/7/6 → **5.90**

**What it is.** You feed it any meme image. A Muse Glimmer model fine-tuned on internet-culture corpora dates it: era, platform of origin, and its compression "DNA" from re-upload artifacts, rendered as a playful stratigraphy diagram with Muse Spark narration. The demo moment: a deep-fried image dropped in, and a geological cross-section of its internet history comes out.

- **S:** The fine-tune showcase is real technical work and the stratigraphy output is charming and screenshot-friendly.
- **W:** Charming once, no repeat use, and no user pain, so it parks at the bottom half.
- **O:** The fine-tune pipeline demonstrates Baseten capability the team could reuse elsewhere. Credit ask: Baseten for the fine-tune.
- **T:** No named competitor; the objection is "fun demo, zero market, why does this win?"

### 41. The Fungus Forum — 4/7/7/6 → **5.90**

**What it is.** A hobby mycologist mounts a cheap microscope camera over a petri dish with two mold strains growing on it. SAM 3.1 segments the hyphae growth zones over a timelapse, the system draws the frontline where one strain overtakes the other, and Muse Spark drafts the lab notebook entry. The demo moment: a week of microscopic warfare compressed into a minute with a moving battle line.

- **S:** The segmentation work over timelapse is real, and the visual is unlike anything else in the pool.
- **W:** Mycology hobbyists are a tiny audience, so the market is not there even though the tech is.
- **O:** The continuous-capture pipeline could inform the incumbent's long-duration video handling. Credit ask: Modal for continuous microscopy capture.
- **T:** No consumer competitor; the objection is "beautiful science project, no customer."

### 42. Booth-Builder — 5/6/7/5 → **5.75**

**What it is.** Craft-fair vendors photograph their table setup from a couple of angles. SAM 3.1 segments the display pieces, and Muse Image regenerates the booth three alternative ways, shown as before-and-after sliders. The demo moment: a cluttered craft table sliding into three cleaner arrangements in one tap.

- **S:** Pleasant, low-risk demo with before-and-after sliders that judge well on camera.
- **W:** Small audience, thin depth, and the generated alternatives may not survive physical constraints like table size.
- **O:** Image-generation quota is the only ask, so it is cheap to keep alive as a side demo. Credit ask: Image generation quota.
- **T:** No specific competitor; the objection is that the suggestions are cosmetic rather than actionable.

### 43. Kiln Whisperer — 4/6/7/6 → **5.65**

**What it is.** A potter points a camera at their kiln's peephole during a firing. SAM 3.1 segments the pyrometric cones inside as they bend, Muse Spark fits the thermal curve from the cone readings, and the screen shows a self-correcting countdown to the finished firing. The demo moment: the countdown jumping to correct itself as a cone bends faster than predicted.

- **S:** It advises a process, not a body, so it stays ban-clear. Potters are a niche but devoted audience with real money at stake per firing.
- **W:** Impact is low because the audience is small, and the peephole camera angle is finicky on a real kiln.
- **O:** The sensor-substitute pattern (camera replacing an instrument) could apply to the incumbent's capture hardware story. Credit ask: none.
- **T:** Manual cone watching and digital kiln controllers; the objection is that a $30 controller already solves this.

### 44. Tool-Shed-Share — 6/6/6/5 → **5.65**

**What it is.** A neighborhood tool library points a camera at its loan shelf. SAM 3.1 tracks which tool slots are occupied and which are empty, and Muse Spark drafts overdue-return nudges in the group chat, while member identity stays in a manual paper logbook. The demo moment: an empty slot on camera becomes an automatic "the tile saw is back, thanks" message.

- **S:** Tool libraries are a real and growing market, and the camera-only-shelf design sidesteps the hardest privacy questions.
- **W:** Depth is thin because slot detection is not hard, and the manual logbook is a visible seam in the product.
- **O:** The slot-occupancy tracker could be a sub-feature of the incumbent's fixed-camera stack. Credit ask: Modal.
- **T:** Library management software with manual check-in exists; the objection is that a clipboard is nearly free.
- **Gray-zone discipline:** track only shelf slots and tools, never people.

### 45. Lane-Counter — 5/6/6/5 → **5.50**

**What it is.** A community pool, climbing gym, or library mounts a fixed camera pointed at equipment areas. The system counts occupied items, like lane buoys in use, crash pads on the wall, or open study chairs, and drives a live capacity board that members check before driving over. The demo moment: a live board flipping from "4 pads free" to "1 pad free" as the gym fills.

- **S:** Publishes only aggregate counts, which keeps the privacy surface nearly zero.
- **W:** Marginal utility caps every score, and a person with eyes can count a small room.
- **O:** The aggregate-count board could be a lightweight feature atop the incumbent's footage pipeline. Credit ask: Modal SAM.
- **T:** Generic occupancy counters exist; the objection is that the equipment-only constraint also limits the value.
- **Gray-zone discipline:** count equipment only, never segment humans, publish aggregate counts only.

### 46. Stall-Sense — 5/6/6/5 → **5.50**

**What it is.** A flea-market vendor puts a phone on a tripod facing their stall table. SAM 3.1 tracks which display spot gets its product picked up and when, producing a per-hour interest heat map that tells the vendor which items and times draw hands. The demo moment: a four-hour stall session replayed as a heat map showing one display corner dominating.

- **S:** Small-business value is real, and per-spot pickup tracking is a concrete, measurable output.
- **W:** The demo is thin, since a heat map is a chart, and four hours of footage is a long capture for one insight.
- **O:** The pickup-event timeline is directly the incumbent's timeline view with different objects. Credit ask: Modal for 4-hour footage.
- **T:** Retail heat-mapping exists at enterprise scale; the objection is whether vendors will run a phone battery for four hours.
- **Gray-zone discipline:** track merchandise only, never segment or identify people.

### 47. Plant-Ledger — 5/6/6/5 → **5.50**

**What it is.** A community garden photographs its plots weekly from a fixed spot. SAM 3.1 segments the beds and plots across the season, and the app maintains a shared map of who planted what where, purely as a logistics log for the garden coordinator. The demo moment: a season of garden photos scrubbing by as the plot map fills in with plantings.

- **S:** No advice or health claims, so it is ban-clear. The season-scrub timelapse is a tidy, low-risk visual.
- **W:** Niche audience, thin tooling, and the weekly-photo discipline depends on volunteers not quitting.
- **O:** The weekly-diff-over-fixed-viewpoint machinery matches the incumbent's timeline approach. Credit ask: none.
- **T:** Shared spreadsheets do this today; the objection is that the map is nicer but not necessary.

### 48. Season-Swap — 5/6/6/5 → **5.50**

**What it is.** A group of friends or families shares a clothing swap bin that rotates between houses. Each time the bin moves, the receiving host photographs it, SAM 3.1 diffs the contents against the previous rotation, and Muse Spark writes a "what's new this rotation" digest for the group chat. The demo moment: two bin photos in, a friendly digest out with the three new jackets highlighted.

- **S:** Small, friendly, and zero privacy exposure, so there is no gray-zone risk at all.
- **W:** Thin everywhere: small audience, small insight, small story.
- **O:** The bin-content diff is a two-frame version of the incumbent's temporal comparison. Credit ask: none.
- **T:** No competitor; the objection is that the group chat already says "new stuff in the bin."

### 49. Lost-Sock-OS — 4/6/7/5 → **5.45**

**What it is.** You photograph your laundry piles for a few weeks. SAM 3.1 re-identifies the same socks across different loads, washed and crumpled differently, into a persistent "sock registry," and the orphan bin visibly shrinks as matches resolve. The demo moment: a shrinking-orphan-bin counter ticking down as week-old singles find their pairs.

- **S:** Self-aware humor plus a shrinking-orphan-bin demo beat that lands emotionally. Re-identification across states is genuinely nontrivial.
- **W:** No market at all; it is pure delight, and Impact bottoms out at 4.
- **O:** The same-sock re-identification is a small, charming stress test of the incumbent's object persistence. Credit ask: none.
- **T:** No competitor; the objection is "hilarious, but this cannot win a hackathon."

### 50. Tag-Track-Kennel — 4/6/6/5 → **5.20**

**What it is.** Hobby dog-sport and 4-H handlers film their practice runs on agility courses. SAM 3.1 tracks only the equipment, like jumps, cones, and ring gates, and builds a course-map history across runs so handlers can compare layouts and their setups over a season. The demo moment: a season of practice runs collapsed into one evolving course map.

- **S:** Equipment-only tracking completely sidesteps people-and-animal gray zones, which makes it safe to ship and talk about.
- **W:** Tiny audience, low impact, and a course map is something most handlers already sketch on paper.
- **O:** The equipment-only tracking module is a bounded component of the incumbent's SAM pipeline. Credit ask: Modal SAM.
- **T:** Hand-drawn course maps; the objection is that the paper sketch plus a phone photo does the same job.
