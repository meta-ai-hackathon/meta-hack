# Restrictions — what gets a project disqualified

## The official anti-projects list (verbatim)

> Any project using AI to generate and give medical advice e.g. AI Mental Health Advisor, skin blemish detector, etc.; Basic RAG Applications; Simple Image Analyzers; simple "AI for Education" Chatbots; AI Job Application Screener; AI Nutrition Coach; Personality Analyzers; Sports analyzers or coaches; Anything political or involving war

## The four logics behind it

The list isn't random — every banned item falls in one of four buckets. Test any idea against these:

1. **Advice that can hurt a body.** Medical, mental health, nutrition. Wrong output = harm = regulation + lawsuits. Meta wants zero of it
2. **Machines judging people.** Anything that scores a human and affects their life — hiring, grading, dating, credit, personality. Bias/discrimination exposure
3. **Wrapper projects.** Basic RAG, one-shot image analysis, edu chatbots. Not a safety issue — a depth issue. One API call + a chat UI = the "basic integration" that fails the tooling criterion anyway
4. **Politics and war.** Brand safety, sanctions/export (defense = ITAR), demo content nobody wants on a livestream

## Extrapolated — also banned in spirit

| Idea | Bucket |
|---|---|
| Legal advice bot ("can I sue?") | 1 |
| "Should I buy this stock?" advisor | 1 |
| AI therapist / companionship bot | 1 |
| AI personal trainer / diet plans | 1 |
| Symptom or dosage checker | 1 |
| Interview grader, teacher grader, "AI boss" | 2 |
| Dating compatibility scorer | 2 |
| Emotion / lie detection from faces | 2 + biometric laws |
| Credit / insurance scoring of people | 2 |
| Chat-with-your-PDF, recipe-from-fridge-photo, plant identifier, email summarizer | 3 |
| Drones, target recognition, ISR, anything defense | 4 |
| Immigration advice | 1 + 2 + 4 |

## One-line test for any new idea

**Does it advise a body, grade a human, need one API call, or touch war? No to all four = buildable.**

## Gray zones to watch (not banned, but easy to drift into)

- **Face recognition / identity search** → logic 2 + biometric privacy laws (BIPA). Search by attributes ("person in red hoodie"), never by identity ("find John")
- **"Suspicious behavior" scoring** ("this person looks like a thief") → logic 2, that's profiling. Trigger on concrete events only: line crossed, after-hours motion, dwell time
- **Surveillance framing**: private property + owner's own cameras + loss prevention = standard commercial security (safe). Public-space tracking, police, or cross-city person tracking = dead

## Other hard rules (not idea-related but disqualifying)

- **New work only** — demo shows only what was built during the event; unclear contribution = immediate DQ
- Public repo, one submission per team, max 4 people
- Late submission = not considered
