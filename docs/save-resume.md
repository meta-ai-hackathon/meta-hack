# Save/resume (BN-13 / HACK-40)

Progress persists across sittings: there is no requirement to finish intake
in one sitting. This document records the design decisions and the guarantees
the implementation makes.

## The session token is an httpOnly cookie

**Choice:** the token lives ONLY in the `bn_session` cookie — `HttpOnly`,
`SameSite=Lax`, `Max-Age=30` days — set by the first response that creates or
resumes a session (`src/lib/intake/store.ts`, `sessionCookieHeader`).

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
  full note history.
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
later" (`src/app/intake/intake-wizard.tsx`), which calls `POST /api/session`
to guarantee the session exists even before the first answer, and says so in
plain language: saved on this device, nothing is submitted until you decide.
Returning to `/intake` on the same device resumes automatically from the
cookie — no login, no token to paste.

## Verification map

| Guarantee | Evidence |
| --- | --- |
| Leave and return restores identical progress | `src/app/api/session/route.test.ts` (resume-identity property over arbitrary answer sequences) + agent-browser screenshots (VAL-RESUME-001) |
| Progress survives a dev-server restart | agent-browser: partial completion → services stop/start → resume → identical state (VAL-RESUME-002) |
| No in-memory session state | code review (all reads via `getDb()`) + the restart test |
| Caseworker notes intact through resume | `/api/session` route tests (create-assisted → resume → notes present) |
| Rejected answers create no orphan sessions | `src/app/api/intake/answer/route.test.ts` |
| Disavowed pii values are deleted | `src/lib/vault.test.ts` + `src/lib/intake/store.test.ts` (full-population disavow property) |
