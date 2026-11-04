# Save/resume (BN-13 / HACK-40)

Progress persists across sittings: there is no requirement to finish intake
in one sitting. This document records the design decisions and the guarantees
the implementation makes.

## The session token is an httpOnly cookie

**Choice:** the token lives ONLY in the `bn_session` cookie — `HttpOnly`,
`SameSite=Lax`, `Max-Age=30` days — set by the response that creates the
session (`src/lib/intake/store.ts`, `sessionCookieHeader`; a resume returns
200 with no new cookie — the browser already holds the token).

**Why httpOnly cookie over a URL/return token:**

- Page scripts can neither read nor exfiltrate the token, so an XSS in any
  future UI cannot walk off with someone's benefits session.
- The browser carries it automatically on every request and re-sends it when
  the person returns later (including after a full browser restart, thanks to
  the 30-day Max-Age) — no code path needs to store or replay it.
- A URL-borne token was rejected: URLs leak via browser history, referrer
  headers, and screenshots, and the cookie already covers the same-browser
  sitting-to-sitting case BN-13 describes.

**Trade-off (deliberate):** a person who moves to a different browser or
device cannot resume, because the token never leaves that browser's cookie
jar. That is the honest behavior for a benefits companion: a shared URL must
not hand a stranger someone's in-progress application.

**Secure flag:** `sessionCookieHeader` sets `Secure` when the request arrived
over https — directly (`request.url`) or behind a TLS-terminating proxy
(`x-forwarded-proto`, first hop). Plain http deliberately keeps the flag off:
a Secure cookie would never be stored by the browser on localhost dev.

## The endpoints

| Endpoint | Method | Behavior |
| --- | --- | --- |
| `/api/session` | POST | Create the session now (before the first answer) and set the cookie — or, when the cookie already names a session, resume it without creating anything (201 vs 200). Optional body `{ caseworkerAssisted: true, note }` records a caseworker audit note (BN-10); the note is required when `caseworkerAssisted` is true, and the request is validated before any row is created so a rejected request leaves no orphan person/session. |
| `/api/session` | GET | Resume with the token: `200 { session, state }` — the session's lifecycle summary (BN-25 status, caseworker flag, audit notes, oldest first) plus the full client state. No recognizable token is a `404` with the `not_found` taxonomy code; GET never creates a session. |

The intake routes keep their BN-09 contracts: `GET /api/intake/state` stays
read-only (empty state, no cookie for a fresh visitor), and
`POST /api/intake/answer` creates the session lazily on the first valid
answer — validation runs before the session is resolved, so a rejected first
answer creates no orphan rows.

## What "resume" restores, and where state lives

- **Answers + tri-state labels:** every answer row (status, provenance,
  value) and every pii vault entry live in Postgres. The client state is
  rebuilt from the database on every request.
- **Flow position:** not stored at all — it is *derived* as "the first
  unanswered visible question" (`buildClientState` → `currentIndex`), a pure
  function of the persisted answers. Identical answers therefore produce an
  identical position on resume, by construction, with nothing extra to keep
  in sync.
- **Caseworker audit notes:** `session_audit_note` rows are never touched by
  resume; the `/api/session` GET returns them intact, and resuming a
  caseworker-assisted session reports `caseworkerAssisted: true` with the
  full note history. Attribution is deliberately **self-reported**: this app
  has no authentication, so an assist note is recorded as
  `self_reported_caseworker` — the audit trail never presents an unverified
  claim as a verified caseworker's record (same honesty spine as the
  tri-state answers). A future mission that adds caseworker identity can
  upgrade the attribution.
- **In-memory state:** none. No module keeps session state in module scope;
  every request reads Postgres. A dev-server restart mid-session is
  invisible to a resuming browser (proven by the VAL-RESUME-002 check).

## Disavowed answers are deleted, not just ignored

Answering "I'm not sure" over an earlier known answer deletes the vault value
(`vaultDelete` — BN-13 delete-on-disavow), so a disavowed pii value does not
linger in storage. The flow engine already ignores vault values for
unknown-status answers and the serialization boundary strips pii values from
client payloads; the delete makes the hygiene physical.

## UI affordance

The intake wizard saves every answer immediately and offers "Save and finish
later" (`src/app/intake/intake-wizard.tsx`). On the consent-declined
conversation page the wizard runs in server mode: "Save and finish later"
calls `POST /api/session` to guarantee the session exists even before the
first answer, and returning resumes automatically from the cookie, with no
login and no token to paste.

## The step-by-step page keeps answers on the device (HACK-99)

`/intake` runs the wizard in device mode. No answer is sent to any endpoint,
and nothing about the journey is stored on the server.

- **Where answers live:** IndexedDB in the person's browser, as one sealed
  envelope (the client store's AES-256-GCM `sealed1.` format,
  `src/lib/intake/client-store.ts`) next to the key that sealed it
  (`src/lib/intake/device-answer-store.ts`). The key is generated in the
  browser as non-extractable, so no script can read its bytes, and it never
  leaves the device. Key and envelope are read in one transaction and written
  in one transaction (`src/lib/device-kv.ts`).
- **Resume:** reopening `/intake` in the same browser opens the envelope and
  the flow engine runs over it in the page, landing on the first unanswered
  visible question, the same derivation the server uses. Another browser or
  device starts fresh by construction.
- **Checks:** every answer is validated and canonicalized by
  `src/lib/intake/answer-input.ts`, the same function the server store uses,
  so the device keeps exactly what `POST /api/intake/answer` would accept.
- **Several tabs:** a save re-reads the store and writes only if nothing
  changed since; when another tab saved first it applies its answer on top,
  and when another tab deleted everything it writes nothing and the page says
  so.
- **Delete:** "Delete my answers from this device" removes the key and the
  envelope in one transaction and reports success only when a read afterwards
  finds neither. Without the key, no copy of the ciphertext can be opened.
  When this visit's store failed to open or read, the delete opens it afresh
  and runs the same verified purge; if it still can't reach storage, it says
  the delete couldn't be confirmed. Only a browser that can't store anything
  at all clears just the page.
- **Who can see them:** anyone using the same browser profile can open
  `/intake` and see the answers. HACK-139 calmed the page's standing copy,
  so the blurb no longer repeats that caution — a short visibility note
  ("Anyone using this browser can open these answers.") sits by the delete
  control, and the download copy and the delete/purge copy keep the rules'
  statements (the file is not encrypted and should be deleted on a shared
  computer; a downloaded copy stays until the person deletes it).
  Private windows clear the store when closed, and Safari clears a site's
  storage after about a week without a visit, so the page never promises an
  open-ended resume.
- **Keeping the store:** the page asks the browser to keep this site's
  storage (`navigator.storage.persist()`) only when the person presses
  "Save and finish later" with answers saved on the device, and at most once
  a visit. Answering a question never asks. Firefox answers the request with
  a permission prompt, so a note by the button says beforehand that the
  browser may ask and what saying yes does (HACK-113).
- **Honest copy:** what the page says follows what the browser did. When it
  can't store anything, the page works in memory and says the answers last
  only until it is closed. When storage fails on a visit, it says answers
  from an earlier visit may still be stored. When a save fails mid-visit, it
  says the answers saved before are still on the device and new changes
  aren't. It never claims a save, resume, or delete that did not happen.
- **Other tabs:** the page re-reads the store when it comes back into view
  and before confirming "Save and finish later", so a delete or new answers
  from another tab show up instead of being contradicted.
- **Answers on the app's server:** until HACK-99, `/intake` saved answers
  to the server session, and the conversation page still does. On load the
  page asks `GET /api/intake/state` (the cookie only, no answer, no new
  session) whether this browser has answers there. If it does, a notice
  says how many, without guessing where they came from or calling them
  unused, since the person may still be using the chat. It says the delete
  also removes any chat with the assistant, and it offers the HACK-80 purge
  (`POST /api/session/purge`) behind one confirming step. Its outcome copy
  claims a deletion only when the server confirmed one, and a Check again
  that can't reach the app says so. Only one Check again runs at a time, so
  a failed check can't overwrite one that reached the app
  (`src/app/intake/server-answers-notice.tsx`).

The conversation page still keeps answers on the server, because its match
and review sections read the server session. Moving them on-device is
HACK-95, and its error fallback link says the step-by-step page starts
without what the person told the chat.

## The match, the review, and the filled form on the device (HACK-115)

When the person reaches the end of the questions on `/intake`, the page
shows the benefit match, a review of the application form, and, when the
person asks, the filled DHB-5200 drawn on the page to print or to download a
copy of. All three are computed in the browser from the answers sealed on
the device (`src/lib/intake/device-form.ts`, shown by
`src/app/intake/device-results.tsx`). No request carries an answer, and the
filled form reaches the device only as a copy the person downloads, or as a
PDF the person saves from the print window.

- **The match:** the same deterministic scoring the server runs
  (`src/lib/match-core.ts`, which `src/lib/match.ts` re-exports), with every
  explanation composed from the matched entry's own sourced facts. The page
  never calls a model.
- **The review:** the same form-driven field view the server's review route
  builds (`src/lib/forms/flow.ts`). Each field that takes an answer is
  filled from one, still needed, or not needed, with its answer's status and
  provenance. A private answer shows its status only, never its value. Under
  it is the same coverage report the review route serves
  (`src/lib/forms/disposition.ts`): how many of the form's fields take an
  answer, and for every field left blank by design, why and on which page
  of the printed form. It is built from the committed registry, so it holds
  no answer.
- **The fill:** the same value assembly and PDF fill both download surfaces
  run (`src/lib/forms/fill-core.ts`, re-exported by `src/lib/forms/fill.ts`
  for the node-side machinery), done with `@cantoo/pdf-lib` in the browser
  over the device answers and the on-device vault view (`vaultValues` in
  `src/lib/intake/client-store.ts`). The form reads private answers only
  through its registry entry's vault field allowlist. Every field the
  registry gives a non-mapped disposition stays blank, yes/no pairs fill by
  their export values, and the fill flags any question with more than one
  box checked without picking a side; the page lists those above the filled
  pages. The device lays its answers out the way the server keeps the same
  answers, so its filled form matches the review payload's values field for
  field (property-proven in `src/lib/intake/device-form.test.ts`). The PDF
  step (`src/lib/intake/device-fill.ts`) is the
  only device module that loads pdf-lib, and the page loads it only when
  the person asks to see the filled form, so the questions never wait on
  it.
- **Answers the questions don't ask:** the form's other fields that take
  an answer (the name, the addresses, the Social Security number, next
  year's income, and the rest of the full DHB-5200 mapping) are typed into
  the review. As on the conversation page, a box or a yes/no pair among them
  takes the word checked or unchecked. The fill would print any other text
  as an unchecked box, so the filled form waits until each box answer reads
  checked or unchecked (any case) and lists the ones that don't
  (`reviewAnswersForForm` in `src/lib/intake/device-form.ts`). They are
  used for the filled form and live only in the page's memory: the wizard
  holds them, so going from the review to a question and back keeps them,
  and they clear when the page closes or reloads or the answers are
  deleted (on this page, in another tab, or found deleted by a save). The
  page never stores them, on the device or anywhere else, and they leave
  the page only on the filled form, printed or in a copy the person
  downloads. Their inputs turn off the browser's spellcheck, because a
  browser's cloud spellcheck sends what is typed to its vendor.
- **The print preview:** the filled PDF stays in the page's memory. The
  page draws each of its pages onto a canvas with pdf.js
  (`src/lib/intake/device-print.ts`), shows them under a heading with a
  Print button that opens the browser's print, and the print rules in
  `src/app/globals.css` put only those pages on paper, one page per sheet.
  While the pages are on screen, the page marks `<html>` with
  `data-print-filled-form` and every element from the body down that holds
  the pages with `data-print-path`, and the print rules key off those
  marks. Those selectors work in every browser, so a browser without
  `:has()`, such as Firefox before 121, prints only the pages too and never
  the review's typed answers. A `:has()` rule stays as a progressive
  enhancement in a rule of its own, so a browser that can't read it drops
  only that rule. The pages go, and their canvases are released, when any
  answer changes, typed ones included, when the person leaves for another
  screen of the app or another site (on `pagehide`, so a page the browser
  keeps for Back comes back without them), and with every delete. Pages
  drawn just as an answer changes or the page is left, which React drops
  before it ever puts them on screen, are released the same way. The note
  by the Print button asks the person to choose a printer, and says that
  saving the form as a PDF there saves a file to this device, with the
  same words the download note uses about the file. Some in-app browsers
  ignore `window.print()`, so when no print starts after a press, the page
  says to open the page in a browser such as Safari or Chrome, that answers
  saved in this browser don't move there, and, after that, to try Download
  a copy and print the file from another app, since a browser that ignores
  Print may drop a downloaded file too. Each page prints on its own sheet,
  sized to fit the sheet's printable area both ways, so narrow margins,
  headers and footers, or a landscape sheet don't split it. While the form is
  prepared, the show button keeps focus (it is marked busy rather than
  disabled) and the status line says so; once the pages are drawn, focus
  moves to their heading.
- **The downloaded copy:** the person reviews, signs, and sends in the
  application themselves, so beside Print a Download a copy button saves
  the filled form to the device, to print, sign, send in, and keep. The
  owner decided on HACK-115 that this download is vital, and
  `.github/claude-review/rules.md` (Real data rules) sanctions it on its
  conditions. The copy is the same filled PDF the pages were drawn from,
  made in the browser from the answers sealed on the device and those
  typed into the review, never from anything held on the server. Only the
  button's own click handler saves it, through
  `src/lib/intake/device-download.ts`, the one module on the device path
  allowed to hand the browser a file: it makes a Blob and an object URL of
  the bytes, clicks a download link once, and takes the link off the page.
  The URL stays alive until the page lets go of the filled form, and is
  revoked with it, because a browser reads the file after the click, and
  iOS Safari only once the person taps Download in the prompt it shows
  (HACK-145). Where the browser can tell, it refuses a call made while the
  person isn't acting on the page.
  Nothing about the file is requested, logged, cached, or stored, and the
  app keeps no copy anywhere. The bytes kept for the download live only in
  the page's memory with the pages and are wiped whenever the pages go. The
  note by the button says the file holds the answers filled in on the form,
  private ones included, that it is an ordinary file that isn't encrypted,
  and that on a shared computer it should be deleted once printed or sent.
  The page can't see what the browser does with the file, so after a press
  it says the browser should now save the copy or ask where to save it,
  and to open the page in Safari or Chrome if no file appears. That word
  goes with the pages, as the word that they are ready does. The note by
  the show button says the filled form is saved to the device only if the
  person downloads a copy or saves it as a PDF when printing: the answers
  themselves may be saved in this browser, as the save for later section
  says on the same screen, so it never claims nothing at all is saved. A
  downloaded copy is a file outside this browser's storage, so every delete
  and purge message on the page, the device's own and those of the notice
  for answers saved on the app's server, says that a copy downloaded, or
  saved as a PDF from the print window, stays on the device until the
  person deletes it.
- **When the pages can't be drawn:** the download needs only the filled
  form, so when the form fills but this browser can't draw its pages
  (pdf.js didn't load, a canvas was refused, or the drawing never finished),
  the page says so and offers Download a copy on its own, with the same
  note, so the person can still get the form. There is no Print button
  then, since there are no pages to print and nothing marks the page for
  the print rules. The bytes kept for it are wiped on the same changes as
  the pages', and showing the filled form again tries the drawing once
  more.
- **pdf.js on the page:** the print preview is the only device module that
  loads `pdfjs-dist`, and both it and pdf.js load only when the person asks
  to see the filled form. pdf.js runs on the page's own thread: the module
  imports pdf.js's worker module first, which installs the
  `globalThis.pdfjsWorker` hook pdf.js 6.4.x checks before it would start a
  Worker, so it never starts one or requests a worker script. It gets the
  filled bytes and none of the locations it would request font, CMap, ICC,
  or wasm files from. Pages draw with the print intent and the default
  annotation mode, so each field shows the appearance pdf-lib wrote for its
  answer, at about 150 DPI within a budget of 48 million pixels (about
  190 MB of canvas memory). iOS Safari caps the memory all of a page's
  canvases may use, so a small device, one whose `navigator.deviceMemory`
  says 4 GB or less or that is an iPhone, iPad, or iPod (an iPad that says
  it is a Mac is told by its touch screen), draws at up to 110 DPI within
  22 million pixels (about 88 MB). The DHB-5200's 21 pages come to about
  106 DPI there, still legible on paper. pdf.js 6.4.x calls
  `Promise.withResolvers` and `ArrayBuffer.prototype.transferToFixedLength`
  without bringing them, and Safari before 17.4 lacks both (Chrome gained
  them in 119 and 114), while Next.js builds for Safari 16.4 and Chrome
  111. Without them pdf.js throws on every document or never finishes a
  page, so the module fills in whichever is missing before pdf.js loads
  and leaves a browser's own alone. A drawing pdf.js hasn't finished a
  minute after it loaded is
  given up on, and the page shows the same failure message as any other.
- **The blank form:** the public DHB-5200 is a static file
  (`public/forms/dhb-5200.pdf`), byte for byte the registry's committed
  copy. The page asks for it only when the person asks to see the filled
  form, with a GET that has no body, no cookies, and no referrer
  (`src/lib/intake/device-template.ts`).
- **Resume:** the review is a pure function of the stored answers, so a
  reload that resumes them from IndexedDB lands back on the same review, and
  the form fills again from them.

## Verification map

| Guarantee | Evidence |
| --- | --- |
| Leave and return restores identical progress | `src/app/api/session/route.test.ts` (resume-identity property over arbitrary answer sequences) + agent-browser screenshots (VAL-RESUME-001) |
| Progress survives a dev-server restart | agent-browser: partial completion → services stop/start → resume → identical state (VAL-RESUME-002) |
| No in-memory session state | code review (all reads via `getDb()`) + the restart test |
| Caseworker notes intact through resume | `/api/session` route tests (create-assisted → resume → notes present) |
| Rejected answers create no orphan sessions | `src/app/api/intake/answer/route.test.ts` |
| Disavowed pii values are deleted | `src/lib/vault.test.ts` + `src/lib/intake/store.test.ts` (full-population disavow property) |
| Device mode sends no answer anywhere | `src/app/intake/intake-wizard.device.test.tsx` (the wizard driven through the DOM with `fetch` failing the run) + `src/lib/intake/device-intake.test.ts` (a full journey) + `src/lib/intake/device-path-boundary.test.ts` (no server module, Node built-in, or request on the path) |
| What the page says matches what the browser kept | `src/lib/intake/device-intake.test.ts` (unsupported, failed open, failed read, failed and stalled saves, other tabs, including a delete in another tab that a roster change's re-prune finds) + `src/app/intake/intake-wizard.device.test.tsx` (focus and announcements in the delete flow, the double-click guard) |
| Device storage holds no plaintext and resumes exactly | `src/lib/intake/device-answer-store.test.ts` (properties over saved answer sequences) + `src/lib/device-kv.test.ts` (sealed store over a fake IndexedDB) |
| A device delete is verified and never undone by another tab | `src/lib/intake/device-answer-store.test.ts` (purge and racing-save properties) |
| Answers saved on the server can be found and deleted | `src/app/intake/server-answers-notice.test.tsx` (cookie-only check, confirmed purge, every purge outcome, a failed Check again, overlapping Check again presses, no answer in any request) |
| Only Save and finish later asks the browser to keep the store, after saying so | `src/lib/intake/device-intake.test.ts` (answering never asks; it asks only when the device holds answers) + `src/app/intake/intake-wizard.device.test.tsx` (the note describes the button, one request a visit) |
| `/intake` reaches the match, the review, and the filled form with no answer in any request, and a reload resumes them | `src/app/intake/device-results.test.tsx` (the page driven through the DOM over a fake IndexedDB, with every request recorded) + `src/lib/intake/device-path-boundary.test.ts` (no server module, Node built-in, or request on the path besides the blank form's GET) |
| The end of `/intake` shows no banned claim and no private answer, for any answers | `src/app/intake/device-results.markup.test.tsx` (properties over generated device answers: the rendered text, attributes, and markup, plus labelled and described inputs with spellcheck off and a heading outline that never skips a level) |
| The filled form reaches the device only as the copy the person downloads | `src/lib/intake/device-path-boundary.test.ts` (read from the parsed code of every module on the path: no object URL, Blob, File, response or canvas Blob, download attribute, share sheet, embedding element, file picker or file system, image file, browser storage, cookie, or service worker, whether named in code or in a string, with only the two sealed answer stores allowed their own storage and only `device-download.ts` allowed exactly an object URL, a Blob, and a download link; of every module the app ships, only the page loads that module, and only its download button's click handler calls it, a reading checked against generated pages; no module on the path writes to the console; pdf.js loads only in the print preview, on demand, with nothing that would send it to the network) + `src/app/intake/device-results.test.tsx` (the page driven to the filled pages: nothing handed to the browser as a file until Download a copy is pressed, nothing new in its storage, Print calls the browser's print) |
| A downloaded copy is the form on screen, saved only at the person's press, with nothing sent or kept | `src/app/intake/device-results.test.tsx` (the press saves one PDF whose bytes are the ones the pages were drawn from, with no request and nothing in the browser's storage, its link off the page at once and its URL alive until the pages go, then revoked with them; showing, printing, or a press the browser says no one made saves nothing; the note that describes the button says what the file holds, that it isn't encrypted, and to delete it on a shared computer) + `src/lib/intake/device-download.test.ts` (properties: exactly the bytes as a PDF under the name asked for, one click of a link taken away at once, the URL alive with no timer until the caller releases it, each copy released on its own, a copy the caller can wipe, nothing made when the browser says no one is acting on the page) |
| Delete and purge copy says a downloaded copy stays on the device | `src/lib/intake/device-intake.test.ts` (every delete and purge message) + `src/app/intake/server-answers-notice.test.tsx` (the server answers delete's confirming step and each outcome that says what was or wasn't removed) + `src/app/intake/device-results.test.tsx` (a delete and a clear after a download) |
| Where the pages can't be drawn, the filled form can still be downloaded | `src/app/intake/device-results.test.tsx` (with pdf.js failing to load: no pages, no Print button, and no print marks, Download a copy offered with its note, saving the form the fill made, its bytes wiped on an answer change, on leaving, and with the screen, and the pages shown on the next try) |
| Print puts only the filled pages on paper, one to a sheet, with or without `:has()` | `src/app/intake/device-results.test.tsx` (the print rules in `src/app/globals.css`, read with the browser's CSS parser and applied to the rendered page as the cascade does, once without the rules that use `:has()` and once with them: everything beside the pages is hidden, the typed answers included, nothing in them is, a break after every page but the last, and each canvas sized to fit the printable width and height; the `:has()` rule alone still hides the rest if a mark is missing, and the marks come and go with the pages) |
| The print preview draws every page, in order, and keeps nothing when it can't finish | `src/lib/intake/device-print.test.ts` (properties with pdf.js faked: each page drawn once at its print size and label from a copy of the bytes, the worker hook and the missing built-ins in place first, the stand-in built-ins behaving as the real ones, the loading task destroyed, every canvas released after a failure, an abort, or a pdf.js that stops answering, on a fake clock so a busy machine can't move the watchdog, a failed pdf.js load retried; the print size never past the budget's DPI or pixel limits, full or small, the small budget for an iPhone, iPad, or iPod or a device with 4 GB or less, read from the browser by default) |
| The filled pages never outlast the answers they show | `src/app/intake/device-results.test.tsx` (a typed change, an answer change, a change while the pages draw, leaving the page for another screen or another site, a drawing still running when the page is left, a keypress or a `pagehide` between a drawing finishing and React's render, and a delete each drop the pages, release their canvases, and wipe the bytes kept for a download, and the word that they are ready, or that a copy should be saving, goes with them; a press of Download a copy between leaving and the next render saves nothing) |
| A print press the browser ignores says how to print instead | `src/app/intake/device-results.test.tsx` (with `window.print()` ignored, the page says to open the page in another browser such as Safari or Chrome, and then to try Download a copy and print the file from another app, and a print that starts late takes that back) |
| A box answer that isn't checked or unchecked holds the filled form back instead of printing an unchecked box | `src/lib/intake/device-review-answers.test.ts` (property over typed answers: box answers reach the fill only as checked or unchecked, any other text is listed) + `src/app/intake/device-results.test.tsx` (yes typed into a box: nothing fetched or filled, the box listed, then filled as fixed) |
| Answers typed into the review survive a trip to a question and go with every delete | `src/app/intake/device-results.test.tsx` (property: generated typed answers are all still there after answering a question from the review; a delete here, in another tab, or found by a save leaves the review empty when the questions are answered again) |
| The device's fill and review match the server's for the same answers | `src/lib/intake/device-form.test.ts` (properties over generated answer sets saved through the server store and on the device: the same field values, provenance, to-resolve and not-applicable lists, conflict flags, and the review route's view and coverage report) |
| Every field on the form is in the review or listed as left blank, once | `src/app/intake/device-results.markup.test.tsx` (property over generated device answers: the review's fields and the coverage rows together are the form's fields, each row with its reason and page) |
| Boxes checked on both sides of a question print as given and are named | `src/app/intake/device-results.test.tsx` (two boxes of one check-one line typed checked: both print checked and the page lists the question above the filled pages) |
| The device's match is the consent-declined server match | `src/lib/match-core.test.ts` (property over answer maps) + `src/lib/intake/device-form.test.ts` (the `/api/match` route over the same answers) |
| A form reads only the private answers its allowlist names | `src/lib/forms/fill-core.test.ts` (property over entries with fields remapped outside the allowlist) |
| A field left blank by design is never filled or listed to resolve | `src/lib/forms/fill-core.test.ts` (property: every mapped field is filled, to resolve, or not applicable exactly once, even with values sent for the rest) |
| The browser-safe registry refuses a field without its reviewed disposition | `src/lib/forms/registry-core.test.ts` (properties that rewrite one committed field: a missing or unknown disposition, a blank one without its reason, malformed export values or conflict groups) |
| The static blank form is the registry's committed copy | `src/lib/intake/device-template.test.ts` (byte comparison, and the loader's one bodiless, cookieless GET) |
