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
  `/intake` and see the answers, so the page says so and points to the
  delete on shared computers. Private windows clear the store when closed,
  and Safari clears a site's storage after about a week without a visit, so
  the page never promises an open-ended resume.
- **Honest copy:** what the page says follows what the browser did. When it
  can't store anything, the page works in memory and says the answers last
  only until it is closed. When storage fails on a visit, it says answers
  from an earlier visit may still be stored. When a save fails mid-visit, it
  says the answers saved before are still on the device and new changes
  aren't. It never claims a save, resume, or delete that did not happen.
- **Other tabs:** the page re-reads the store when it comes back into view
  and before confirming "Save and finish later", so a delete or new answers
  from another tab show up instead of being contradicted.
- **Answers saved before this change:** until HACK-99, `/intake` saved
  answers to the server session. On load the page asks
  `GET /api/intake/state` (the cookie only, no answer, no new session)
  whether this browser still has answers there. If it does, a notice says
  how many and offers the HACK-80 purge (`POST /api/session/purge`) behind
  one confirming step, and its outcome copy claims a deletion only when the
  server confirmed one (`src/app/intake/server-answers-notice.tsx`).

The conversation page still keeps answers on the server, because its match
and review sections read the server session. Moving them on-device is
HACK-95, and its error fallback link says the step-by-step page starts
without what the person told the chat.

## The match, the review, and the filled form on the device (HACK-115)

When the person reaches the end of the questions on `/intake`, the page
shows the benefit match, a review of the application form, and a download
of the filled DHB-5200. All three are computed in the browser from the
answers sealed on the device (`src/lib/intake/device-form.ts`, shown by
`src/app/intake/device-results.tsx`). No request carries an answer.

- **The match:** the same deterministic scoring the server runs
  (`src/lib/match-core.ts`, which `src/lib/match.ts` re-exports), with every
  explanation composed from the matched entry's own sourced facts. The page
  never calls a model.
- **The review:** the same form-driven field view the server's review route
  builds (`src/lib/forms/flow.ts`). Each field is filled from an answer,
  still needed, or not needed, with its answer's status and provenance. A
  private answer shows its status only, never its value.
- **The fill:** the same value assembly and PDF fill the server's fill route
  runs (`src/lib/forms/fill-core.ts`, which `src/lib/forms/fill.ts`
  re-exports), done with `@cantoo/pdf-lib` in the browser over the device
  answers and the on-device vault view (`vaultValues` in
  `src/lib/intake/client-store.ts`). The form reads private answers only
  through its registry entry's vault field allowlist. The device lays its
  answers out the way the server keeps the same answers, so the filled form
  matches the server's fill of those answers field for field. The PDF step
  (`src/lib/intake/device-fill.ts`) is the only device module that loads
  pdf-lib, and the page loads it only when the person downloads, so the
  questions never wait on it.
- **Answers the questions don't ask:** the form's other fields (the name,
  the addresses, the Social Security number, next year's income) are typed
  into the review. They are used for that one download, live only in the
  page's memory, and clear when the person leaves the screen. Nothing saves
  them, on the device or anywhere else.
- **The blank form:** the public DHB-5200 is a static file
  (`public/forms/dhb-5200.pdf`), byte for byte the registry's committed
  copy. The page asks for it only when the person downloads, with a GET that
  has no body, no cookies, and no referrer
  (`src/lib/intake/device-template.ts`). The filled PDF goes to the browser
  as a download, and the page keeps no copy of it.
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
| What the page says matches what the browser kept | `src/lib/intake/device-intake.test.ts` (unsupported, failed open, failed read, failed and stalled saves, other tabs) + `src/app/intake/intake-wizard.device.test.tsx` (focus and announcements in the delete flow, the double-click guard) |
| Device storage holds no plaintext and resumes exactly | `src/lib/intake/device-answer-store.test.ts` (properties over saved answer sequences) + `src/lib/device-kv.test.ts` (sealed store over a fake IndexedDB) |
| A device delete is verified and never undone by another tab | `src/lib/intake/device-answer-store.test.ts` (purge and racing-save properties) |
| Answers saved on the server before device mode can be found and deleted | `src/app/intake/server-answers-notice.test.tsx` (cookie-only check, confirmed purge, every purge outcome, no answer in any request) |
| `/intake` reaches the match, the review, and the filled form with no answer in any request, and a reload resumes them | `src/app/intake/device-results.test.tsx` (the page driven through the DOM over a fake IndexedDB, with every request recorded) + `src/lib/intake/device-path-boundary.test.ts` (no server module, Node built-in, or request on the path besides the blank form's GET) |
| The device's fill and review match the server's for the same answers | `src/lib/intake/device-form.test.ts` (properties over generated answer sets saved through the server store and on the device: the same field values, provenance, to-resolve and not-applicable lists, and the review route's view) |
| The device's match is the consent-declined server match | `src/lib/match-core.test.ts` (property over answer maps) + `src/lib/intake/device-form.test.ts` (the `/api/match` route over the same answers) |
| A form reads only the private answers its allowlist names | `src/lib/forms/fill-core.test.ts` (property over entries with fields remapped outside the allowlist) |
| The static blank form is the registry's committed copy | `src/lib/intake/device-template.test.ts` (byte comparison, and the loader's one bodiless, cookieless GET) |
