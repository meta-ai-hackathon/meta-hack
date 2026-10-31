# Demo failure runbooks

This page says what to do when something breaks in front of a person, whether in the pilot,
the filmed demo or a rehearsal. Each runbook says when the failure happens, what the person
sees, what the operator does, and how the steps were checked. Every step, label and file
named here was checked against `main` at 7c2239d on 2026-10-31. The rehearsals described
below ran on `main` at 0abdb20 the same day, and the server side was run again at 7c2239d
with no model key: a typed turn, two saved answers, the review, the filled PDF, the purge
and `pnpm walkthrough`.

The one move to remember is to turn sharing off on the same page when the assistant stops
answering. The step-by-step questions take over in place, keep every answer the chat
already saved, and still end at the review and the filled DHB-5200. The "Open the wizard"
link in the error and the "Use the wizard instead" link at the top of the page go somewhere
else (see the first runbook).

On that path, like the chat itself, the person's answers stay in the app's server-side
session until they delete them. AGENTS.md (Legal) says that store doesn't yet meet the
rule that answers leave the device only through the fax (HACK-87), so a person has to
confirm this path is acceptable for real pilot data before the pilot relies on it.

The review also has its own boxes for what the questions don't ask: the full legal name,
the home and mailing addresses, the Social Security number, next year's income, and the
signature under "Type your full name to sign". Pressing "Download the filled PDF" sends
whatever is typed in them to the app's server for that one fill. The server doesn't keep
them, but they still leave the device, so the same confirmation covers them. A box left
empty stays blank on the PDF, for the person to fill in by hand.

Sharing choices belong to the person. The operator can turn sharing off, which only sends
less, but never turns sharing on or ticks a sharing box for them.

## Before a demo

1. Check that the deployment answers. `/api/health` touches neither the database nor the
   model, so a pass here proves only that the deployment is up.

    ```sh
    curl -sS https://meta-hack-omega.vercel.app/api/health    # expect {"ok":true}
    ```

2. Check the path that needs no model, and leave nothing behind. In a fresh private
   window, open `/intake/conversation` on the deployment, press "Don't send anything", and
   answer the first two questions. Both are choices ("Who is this application for?" and
   "What kind of help are you looking for right now?"), so pick any option and type
   nothing about yourself. If a later question gets answered too, use only the fictional
   walkthrough persona's values. "Your answers so far" should count them, and "Your
   application, prepared from your answers" should appear below. Then press "Delete my
   information" at the bottom and "Yes, delete everything". The page says "Your answers
   are gone." This checks the database and the vault key without calling the model.
   `pnpm walkthrough` checks the same path more thoroughly, but it leaves a session for
   the fictional walkthrough persona in the database it runs against, so run it against a
   local app (see below), never one that holds pilot data.

3. Know where "Your privacy choices" is. It appears below the conversation once the person
   has made a sharing choice, with the "Turn off sharing" and "Change your choices" buttons
   the runbooks below use.

4. Don't change `VAULT_ENC_KEY` in Vercel before or during the pilot (see the vault key
   runbook).

## Rehearsing locally without a model

The model-down path can be rehearsed on demand with no API key. From the repo root:

```sh
docker compose up -d
pnpm install
export DATABASE_URL=postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator
pnpm db:migrate
export VAULT_ENC_KEY="$(openssl rand -hex 32)"    # a throwaway key for this run only
MODEL_API_KEY= ELEVENLABS_API_KEY= pnpm dev --port 3301
```

An empty variable on the command line wins over a value in `.env`, so this runs without
the model even when `.env` holds a key. Open `http://localhost:3301/intake/conversation`.
`pnpm walkthrough --url http://localhost:3301` should print WALKTHROUGH PASSED with no
model at all.
To rehearse a database outage, point `DATABASE_URL` at a port nothing listens on. To
rehearse a vault key problem, start once with `VAULT_ENC_KEY=` and once with a new key.

`pnpm dev` on Next.js 16.4.3 appends a Next.js block to `AGENTS.md`, from
`<!-- BEGIN:nextjs-agent-rules -->` to `<!-- END:nextjs-agent-rules -->`. Delete just that
block before committing, so any edit of your own to `AGENTS.md` stays. Setting
`agentRules: false` in `next.config.ts` would stop it, which is a team call.

## The model is unavailable

This happens when the Meta model API is down or slow, the credits run out,
`MODEL_API_KEY` is missing or wrong, or a reply comes back empty three times. Speech to
text runs on the same API, so voice turns fail the same way.

The person waits up to about a minute (three tries of up to 20 seconds each), then sees
an amber alert: "Our assistant is unavailable right now. You can keep filling in your
answers." Under it, "Open the wizard" links to `/intake`. The match card keeps working
and explains the program from the knowledge base's own facts instead of the model.

To keep going without losing anything:

1. Under "Your privacy choices", press "Turn off sharing".
2. "Nothing goes to any AI provider" appears with the step-by-step questions. They start
   at the first question still open, with every answer the chat already saved.
3. Keep answering. "Your answers so far", "Benefits that may be worth pursuing" and "Your
   application, prepared from your answers" stay below, and "Download the filled PDF"
   works. These answers save in the app's server-side session like the chat's, and the
   download sends the review's own boxes to the server (see the top of this page).
4. Once the model is back, tell the person the chat works again. Going back to it is
   their choice, and they turn sharing on themselves: "Change your choices", the box for
   sharing typed words, then "Continue with these choices".

The amber alert stays on screen after the switch. Ignore it. Don't follow "Open the
wizard" mid-demo, or "Use the wizard instead" at the top of the page, since both go to
`/intake`. It keeps answers only on the device, doesn't see what the chat saved, starts
again at question 1, and ends at a list of answers ("All questions answered for now")
with no form review and no PDF. It also shows an "Answers saved on the app's server"
notice that counts the chat session's answers and offers to delete them, chat included.
Don't press "Delete them from the app's server" if the person is going back to the chat.

Rehearsed on 2026-10-31 with the app on port 3301 and no model key. A typed turn returned
503 and showed the alert above. "Turn off sharing" brought up the questions in place. After
six answers, sharing went back on, a second typed turn failed the same way, and turning
sharing off again resumed at the same question with 6 of 35 answered. The fill route then
returned the DHB-5200 as a PDF, and a drafted name was filled into it. The browser made no
request to any other host. Tests pin the rest: `src/app/api/conversation/turn/route.test.ts`
(model and speech-to-text failures return the error with the wizard link and save nothing)
and `src/lib/match.test.ts` (the explanation falls back to the entry's facts).

## Too many turns at once

This happens after 12 typed or spoken turns within one minute in one session, or when the
model API refuses three tries in a row for load. The alert says "That was a lot of
activity at once. Please wait a moment and try again." with the same "Open the wizard"
link.

Wait a minute and send again. If it keeps happening, turn sharing off as above.

Checked in code (`MAX_TURNS_PER_WINDOW` and `TURN_RATE_WINDOW_SECONDS` in
`src/lib/conversation.ts`) and by the per-session cap test in
`src/app/api/conversation/turn/route.test.ts`. Not rehearsed, because only a turn the model
answers counts toward the cap.

## Voice or spoken replies are down

The microphone can't start when permission is denied or the device has none. The page says
"Your microphone isn't available." and shows the typed box, which works the same way. If
recording fails mid-session, it says "Recording failed. You can type your answer below
instead."

When speech to text fails, the person sees the model-unavailable alert. In "Talk, with
typing anytime", press "Switch to typing" and carry on, which works while the chat model
is still up. "Talk the whole way" has no switch button, so turn voice off instead: press
"Change your choices", untick only the voice box, and press "Continue with these choices".
That sends less, and sharing typed words stays as the person chose it. If typed turns fail
too, turn sharing off as in the first runbook.

When the model is slow and the person keeps talking, up to three more things they say wait
for the turn in progress and go in order after it. Past that, the page drops what didn't
fit and says "We're catching up with what you said", so the person says it again.

When the spoken replies fail (ElevenLabs is down, or `ELEVENLABS_API_KEY` is missing), the
reply text still appears and the browser's built-in voice reads it, with a "Hearing the
built-in voice" badge. Nothing needs doing. Typed turns aren't read aloud at all.

Checked in the voice code in `src/app/intake/conversation/conversation-chat.tsx` (the
queue limit is `MAX_PENDING_VOICE_TURNS`) and the tests in
`src/app/intake/conversation/journey-stage.test.tsx` (a failed reply shows the
built-in-voice badge). Not rehearsed end to end, because a voice turn needs the model.

## An official source is down or has changed

The app never fetches an official page while it runs. The only outside calls are the Meta
model API (`src/lib/model.ts`) and ElevenLabs (`src/lib/tts.ts`). The program facts are
committed in `kb/entries/nc-medicaid.json` (version 2, retrieved 2026-10-30) and the
DHB-5200 template in `src/lib/forms/fixtures/dhb-5200-ia-9-2020.pdf`. So when an official
site is down, the match card, the review and the PDF keep working. Only the links out to
official pages fail for whoever clicks them. Those are every source link and the "Official
application links" on the match card (from the knowledge base entry), the form's source
link at the top of the review, and the three links under "Official portal (submit here
yourself)" in "Getting it done": "Apply online through ePASS", "How to apply for NC
Medicaid (official guidance)" and "Printable application (DHB-5200, PDF)" (from
`src/lib/pilot.ts`).

During the demo, don't click through to a site that's down. Point to the source line under
the facts instead, which shows the page and the date it was checked. The downloaded PDF is
the same official form.

If an official page now says something different from the knowledge base, don't change a
fact on the spot or repeat the new wording from memory. After the demo, a person checks
the page again. If that can't happen before the next session, a PR that sets the entry's
`status` to `stale` with a `status_reason` (see `kb/README.md`) takes the program card off
the match section, since stale entries are never shown. The form and the review keep
working. That PR is more than the one field. Tests expect the pilot entry to be active
(in `src/lib/nc-medicaid-kb.test.ts`, `src/lib/match.test.ts`, `src/lib/conversation.test.ts`,
`src/app/api/match/route.test.ts` and `tests/test_kb_schema.py`), so CI fails until the
same PR updates them and says why in its body, as AGENTS.md asks.

Checked by listing every `fetch` in `src` and reading the filter in `src/lib/match.ts`
that shows only active entries. Marking the entry stale on a scratch copy of `main` at
7c2239d failed 9 Vitest tests in those four files and 1 pytest test.

## A wrong answer

When the chat saved the wrong value, the person can say what's right in the chat, and the
next turn can save the new value over the old one. That depends on the model, so it
wasn't rehearsed. The reliable fix is to turn sharing off, press "Back" in the step-by-step
questions until the question shows, change the answer, and press "Continue". A saved
answer shows filled in, except a private one, which the page never shows again, so type
that one in full. The new answer replaces the old one, and the questions move on to the
next one still unanswered. Once every question is answered, the list of answers has a
"Review this answer" button next to each one that does the same. "I'm not sure" saves the
question as "You're not sure", which leaves it blank on the form, and deletes a private
value given earlier.

Every reply is checked for promise language and replaced with honest copy when it fails,
and the assistant is told to answer topics outside the knowledge base with "I don't have
verified info on that." If a reply still says something about the program that you can't
find in the sources on the match card, say so plainly and point to the source. Don't
repeat it, and never say the person qualifies or will be approved.

Before the person signs, go through the review together. Each form field shows as filled
or "Still needed", and anything unanswered stays blank on the PDF. The person checks the
form, signs it, and submits it themselves.

Rehearsed on 2026-10-31. After six answers, two presses of "Back" showed the household
size question with 1 filled in. Changing it to 2 saved the new value, and the progress
stayed at 6 of 35.

## The database is down

This happens when Postgres is unreachable or `DATABASE_URL` is missing. The chat page
shows "We could not load your earlier conversation just now." The step-by-step questions on
it show "Something went wrong on our side. Please try again." The match, review and delete
sections don't appear. `/api/health` still answers `{"ok":true}`.

`/intake` keeps working because it saves answers on the device, so show the intake there.
"Use the wizard instead" at the top of the chat page goes to it. It ends without the
review or the PDF. Then check the Vercel Postgres store and the
deployment's environment variables.

Rehearsed on 2026-10-31 with `DATABASE_URL` pointed at a closed port. The chat page and its
questions failed as described, and `/intake` saved an answer with "Saved on this device."

## The vault key is missing, wrong, or changed

`VAULT_ENC_KEY` is the server key the vault uses to encrypt private answers. When it's
missing or not 64 hex characters,
every page that reads the session fails like a database outage. Even a plain answer comes
back with an error, because each save reads the vault back. When the key changes, any
session that already holds a private answer can't be read again, while new sessions work.
An unreadable session doesn't show "Delete my information" either.

Set the key in the Vercel project's environment for production and preview, and don't
change it mid-pilot. A session saved under an old key still sits on the server, and the page
can't offer its delete button. Tell the person their earlier answers can't be read anymore,
and ask whether to delete them. Only once they agree, delete the session from the same
browser before starting over: on the chat page, open the browser's developer console and
send the request that button sends.

```js
await (await fetch("/api/session/purge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true }) })).json()
```

The console prints `purged: true` and the counts of what it deleted. Then start over in a
fresh private window.

Rehearsed on 2026-10-31. With no key, every session read and a first plain answer returned
500. With a new key, the earlier session stayed unreadable, and the purge route still
deleted its 6 answers and 1 vault entry. `docs/deployment.md` now lists `VAULT_ENC_KEY` and
`ELEVENLABS_API_KEY` with the other Vercel variables, but nobody has confirmed yet that
both are set there, so check them in the Vercel project.

## Fax

No route or screen sends a fax yet. `transmitPacket` and `assemblePacket` are only called
from their tests, and the fax consent path stays switched off (`termsVerified: false` in
`src/lib/consent.ts`). The review offers the filled PDF and the official links, and the
person submits the form themselves. The "Send my application" button on "Your results",
where a conversation with typed and voice sharing on ends, only scrolls to the
typed-signature step ("Type your full name to sign"), or to "Getting it done" when there
isn't one, and sends nothing. A name typed in that step goes to the app's server with
"Download the filled PDF", like the review's other boxes (see the top of this page). If
the demo films a fax, the person sends it through their own channel, and rehearsal faxes
go to a test destination only (AGENTS.md, Legal).

## Resetting between rehearsals

"Delete my information" at the bottom of the chat page, then "Yes, delete everything",
deletes this browser's answers, chat and private details from the server. On `/intake`,
"Delete my answers from this device", then "Yes, delete them", does the same on the
device. A fresh private window also starts clean.

Rehearsed on 2026-10-31. After two answers on the chat page, the delete left the server
with 0 answers and the page said "Your answers are gone. This screen lists exactly what
remains."
