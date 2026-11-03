# Rampart vendor pin record

`@nationaldesignstudio/rampart` is pinned to one commit of the maintained
fork (`meta-ai-hackathon/rampart`). Both pins are maintained as one; the
dependable one is the full 40-character SHA. PR #116 re-lands the
dependency (prod was unblocked by reverting PR #98, per the owner decision
recorded there) with the pin landing once and directly on this tip; the
hops below are the vetting chain that reached it.

| File | Pin |
| --- | --- |
| `package.json` | `github:meta-ai-hackathon/rampart#83a60c6528fa1ef7708271d317426fdd162bbd8d` |
| `pnpm-workspace.yaml` | `https://codeload.github.com/meta-ai-hackathon/rampart/tar.gz/83a60c6528fa1ef7708271d317426fdd162bbd8d`, the only entry under `onlyBuiltDependencies` |

## What each vetted commit is

- `e2bd8f8e2bd5a26dc82bbf21e1955a9d0f22397d` — the serialize/deserialize
  session seam the review rounds vetted (PR #98's original pin).
- `349345fd9d2b07445bf95932364148d49474bcbb` — the same change carried
  along when the fork's main was re-based (PR #98's review round pinned
  this one; identical subject, identical feature patch).
- `9f629f0ee6efba05f1019e96c2eafaa615b4894b` — the allow-list commit the
  intake allow-list feature (PR #116) consumes, merged to the fork's
  main as rampart#9 after rampart#7's serialization-safety hardening.
- `b3b56f154f794ffb4ade40fdc672ca75775b6722` — the label-scoped allow-list
  fix PR #116's review round grounded as its P1, which this repo consumes
  via the new `allowListSkipLabels` option.
- `0e1e99436d45eab7fc4007865211405471417db4` — the fork main tip after
  rampart#12 merged. The fork's branch rule makes merge commits the only
  merge style, and rampart#11 and rampart#12 both merged as regular
  merge commits, so the full-SHA pin stays valid.
- `d8c3b590d230bc4840d39a47ac95208120e40335` — the fork main tip
  while the shield was first re-landed: rampart#10 (the PGP/stuck-token
  redaction work, HACK-120) merged on top as a regular merge commit. Its only delta is the fork's
  own review-bot script (Hop 5 below) — no package surface.
- `5dbf3e2a87910ba1d3c3f943f89ea847007db7c2` — the fork main tip after
  rampart#13 (Hop 6 below) merged, committing the built dist/ for this tree;
  an earlier draft of the re-land pinned here before the LF normalization
  was folded into the same re-land.
- `83a60c6528fa1ef7708271d317426fdd162bbd8d` — the fork main tip now
  pinned: the user merged rampart#14 (Hop 6 below) as a regular merge
  commit, pinning LF repo-wide in .gitattributes and rebuilding dist/ from
  the eol=lf checkout; package.json, pnpm-workspace.yaml, and the lockfile
  integrity pin all name it.

## Hop 1: `e2bd8f8..349345f` — tooling only, nothing executed

| Path | Change | What it is |
| --- | --- | --- |
| `.github/claude-review/rules.md` | +49 lines | review-bot rules for the fork |
| `.github/dependabot.yml` | +6 lines | dependabot config for the fork |
| `.github/workflows/ci.yml` | 3 lines changed | fork CI plumbing |
| `.github/workflows/claude-review.yml` | +95 lines | review-bot workflow for the fork |
| `AGENTS.md` | +46 lines | agent conventions for the fork |
| `requirements-review.txt` | +7 lines | review-bot Python requirements |
| `scripts/claude_review.py` | +3244 lines | the fork's review-bot script |

No path under `src/` changes, so the browser-side tokenization path and
whatever the bun `prepack` build compiles are exactly what the vetted
commit had. None of these files reduces to a network call, telemetry, or
any other runtime surface of the dependency: the delta ships no code the
package executes.

## Hop 2: `349345f..9f629f0` — vetted source changes (HACK-107 review P2)

Three fork PRs, all reviewed on the fork, then read hop-by-hop here:

- rampart#7 (`feat/session-serialize` hardening): serialization veto
  teeth plus review nits — `err` declared in a test, a truncated comment
  completed, exhaustive label-map coverage. Commits `ec70f13`, `e51b437`,
  `1ef7764`, `ab33180`, `1579584`.
- rampart#8 (`chore/ci-fork-guards`): fork-internal CI; see the tooling
  rows below.
- rampart#9 (`feat/allow-list`): the option PR #116 consumes.
  Commits `350750c`, merged by `9f629f0`.

Source changes the package actually executes (read in full as
`git diff 349345f..9f629f0 -- src/ index.ts` on the fork clone):

| Path | What changed | Verdict |
| --- | --- | --- |
| `src/session.ts` | The stored-label set becomes an exhaustive `Record<PiiLabel, true>` (a new `PiiLabel` member is a compile error, not a silent validator gap); restore rejects non-positive/unsafe token ordinals and unsafe counters; the persistence warning now mandates AES-256-GCM with a fresh IV per write and a device-only non-extractable key. | Strictly tighter validation and docs-only warning text; the store of PR #98/HACK-107 already implements exactly the mandated scheme. |
| `src/guard.ts` | The new `allowList` option plumbs through `ChatGuard`/`createGuard`; a passed `session` is validated once up front (before the NER model load) and re-validated in the constructor as before. | The restore path #98 vetted now fails fast on malformed input; nothing about it weakens. |
| `src/policy.ts` | `dropAllowListed`: suppresses a detected span only when its text equals — whole-span, trimmed, case-insensitive — an app-supplied entry; an empty/omitted list is a no-op copy. | Default-deny preserved: the app, not the dependency, names the exempt terms; a substring can never punch through a larger finding. |
| `index.ts` | Exports `dropAllowListed`. | Surface area only. |

Test changes ride the same delta (`__tests__/allow-list.test.ts` +106
lines, `__tests__/session-serialize.test.ts` tightened coverage) and the
tooling rows are fork-internal plumbing (`.github/dependabot.yml`,
`.github/workflows/ci.yml`, `AGENTS.md`, `README.md`) — no runtime
surface. No network call, telemetry, or egress exists anywhere in the
delta: the only behavior change is spans being *dropped* on an explicit,
caller-supplied list, which is the feature PR #116 exists to use.

## Hop 3: `9f629f0..b3b56f1` — vetted source changes (PR #116 review P1)

One direct commit on the fork's main, reviewed here hop-by-hop: the
review round's P1 showed an allow-list entry such as "CHIP" also equals
a person's given name, and `dropAllowListed` matched text with no label
awareness, so a quoted "my son Chip" would leave the device unredacted.

Source changes the package actually executes (read in full as
`git diff 9f629f0..b3b56f1 -- src/ index.ts` on the fork clone):

| Path | What changed | Verdict |
| --- | --- | --- |
| `src/policy.ts` | `dropAllowListed` gains a third parameter, `skipLabels` (default an empty set — a no-op): a span whose label is in the skip set is never exempted, even when its text equals an entry. | Strictly tighter than hop 2; without the new option the function is byte-for-byte the vetted hop-2 behavior (the 13 pre-existing tests pass unchanged). This repo passes the person-name labels, so a name can no longer ride a same-text entry out. |
| `src/guard.ts` | The new `allowListSkipLabels` option plumbs through `GuardOptions` / `ChatGuardConfig` / `ChatGuard` / `createGuard` into `dropAllowListed`. | Plumbing only, same shape as the hop-2 `allowList` plumbing already vetted; default changes nothing. |

Nothing else in the package executes: the rest of the delta is
`__tests__/allow-list.test.ts` (6 added tests, including an exhaustive
coverage check that the runtime label list names every `PiiLabel`
member exactly once). No network call, telemetry, or egress anywhere in
the delta.

## Hop 4: `b3b56f1..0e1e994` — rampart#11 polish + rampart#12's Actions freeze (PR #116 repin)

Two reviewed PRs on the fork, then read here:

- rampart#11 (`allow-list-skip-labels`, merged by `93f3da9`): review
  rounds on the fork ended No findings at `c3164a5`; the only source the
  package executes is the delta below, which derives the fork's test
  label list from the session module instead of a hand-copied twin.
- rampart#12 (`dependabot-actions-off`, merged by `0e1e994`): stops
  Dependabot's version updates to CI Actions so fork-only commits do
  not grow ahead of upstream; `.github/dependabot.yml` only.

Source changes the package actually executes (read in full as
`git diff b3b56f1..0e1e994 -- src/ index.ts` on the fork clone):

| Path | What changed | Verdict |
| --- | --- | --- |
| `src/session.ts` | The module-private label set becomes a derived runtime export: `PII_LABELS` is now `readonly PiiLabel[]`, documented as derived from `ALL_LABELS` (a `Record<PiiLabel, true>` literal with no cast), and the validator reads a `ReadonlySet` built from that list. | Same set, same membership check at runtime, so restore validation is byte-for-byte the vetted hop-3 behavior; the export exists so tests derive the list instead of hand-copying it, and compile-time exhaustiveness already held via the `Record` literal. |

The rest of rampart#11's delta is its own fork test suite
(`__tests__/allow-list.test.ts`), not package surface. Nothing else in
the package executes, and no network call, telemetry, or egress exists
anywhere in the delta.

Tooling: rampart#12's three commits change only
`.github/dependabot.yml` — version updates to `github-actions` capped at
`open-pull-requests-limit: 0`, with the fork-divergence rationale
recorded in the file comment. Dependabot security updates stay enabled
at the repo level as the standing channel once the freeze is verified;
the verification date (2026-11-02) and the fallback rule live in the
same comment. No path under `src/` or `index.ts` changes across the
whole hop.

## Hop 5: `0e1e994..d8c3b59` — rampart#10 merges the review-bot redaction work (the re-land pin)

One reviewed PR on the fork, merged as a regular merge commit by
`d8c3b59`: rampart#10 (`hack-120-redact-pgp-and-stuck-tokens`, HACK-120
carried into the fork) strengthens the fork's own review-bot scanner —
PGP private key blocks, tokens stuck to SSNs/card numbers, JWTs whose
segments hold an SSN or card number, and a checksum that hid the line
before it.

Source changes the package actually executes (read in full as
`git diff 0e1e994..d8c3b59` on the fork clone): none. The single changed
path is `scripts/claude_review.py` (50 insertions, 14 deletions) — the
fork's repository-side Python review bot, which is not part of the
npm package (`files` ships `dist`, `eval`, `examples`, `index.ts`,
`LICENSE`, `src`, and the model/docs files; the `scripts` directory is
unshipped) and never runs in the browser or install path. The
browser-side tokenization the package executes is byte-for-byte the
vetted hop-4 surface, and its own suite (`__tests__/allow-list.test.ts`,
+197 lines across the hop) still passes. No network call, telemetry, or
egress exists anywhere in the delta for the package's runtime.

Consequence for future pins: when the fork's main moves again, re-vet
the next `d8c3b59..NEXT` delta the same way — read every `src/` change in
full, classify the rest — and extend this record.

## Hop 6: d8c3b59..83a60c65 — rampart#13 commits dist/, rampart#14 normalizes it (the re-land pin, cold-store OOM fix)

One fork PR merged by 5dbf3e2 first: the compiled output (dist/,
26 files — two esm bundles with source maps plus per-module .d.ts emitted by
tsc, all built with bun run build from the byte-identical d8c3b59 tree) becomes
committed, with no src/ or index.ts change. A second fork PR, rampart#14,
merged by 83a60c65 (the final pin), then pins LF repo-wide in .gitattributes
(catch-all above the LFS rules, so `-text` keeps winning for the model
assets) and rebuilds dist/ from the eol=lf checkout.

Root cause this close out (full chain recorded on HACK-107, reproduced
locally): pnpm 10.34.9 (exec/prepare-package) re-prepares source-only git
tarballs on every cold install. preferred-pm picks the inner package manager
by lockfile FILENAME only — the fork ships the text bun.lock, which it does
not recognize (it knows bun.lockb only), and the packageManager field is
never consulted — so the inner step was a discarded npm install of the
forks ~100 devDependencies into a store temp dir, ending in prepack =
bun run build. On Vercels Node 22 builder (bundled npm 10.9.x, no bun, capped
V8 heap) that inner install died: arborists #loadPeerSet self-recursion
(npm/cli #9960; reproduced with the exact rampart devDep tree: npm 10.9.4
crashes, npm 11.19.1 installs the same tree cleanly), accumulating memory
until the oomReport instead of failing fast. A surviving install would then
still need bun for prepack (ERR_PNPM_PREPARE_PACKAGE).

With dist/index.js present, pnpm packageShouldBeBuilt() returns false
(prepack exists but main exists) and the entire prepare machinery is skipped
on every install: no inner npm install, no arborist, no bun requirement —
cold-store-safe by construction. The pnpm-workspace.yaml onlyBuiltDependencies
entry is updated to the same SHA even though it is now inert (a prepare never
runs; the standing #98 rule that it match the pin exactly is kept so a future
prepare-capable state is never silently blocked). The app jobs bun/npm@11
steps stay as harmless keep-alive for that same future-proofing.

npm publishing stays rejected (HACK-107 owner decision): the fork-only
serialize() face exports raw token-to-PII maps, so a registry package has
high accidental-misuse potential; release.yml guards are untouched.

Regression guard: a Vercel cold-store simulation job lands in ci.yml on this
branch right after this commit (Node 22, no bun, no npm 11 pin, no pnpm store
cache, frozen install plus next build) so a regression to a source-only pin
fails CI instead of a Vercel deploy.

Reproducible-build check on Hop 6: bun run build (bun 1.4.4) from the
83a60c65 tree reproduces every committed dist file byte-for-byte, maps
included, and is run-to-run deterministic (built twice, byte-identical
both times). A sourcemap inlines its build checkout's src/ text (the
map's embedded sourcesContent string), so the LF smudge that rampart#14
pins is exactly what makes the committed maps byte-reproducible from any
clean checkout on any OS. The 5dbf3e2-stage maps had been the obstacle:
their committed sourcesContent carried 702 (dist/index.js.map) and 102
(dist/src/ner/worker.js.map) inlined source lines as CRLF, JSON-escaped,
from a Windows-smudged build (an earlier draft of this record miscounted
that as 18 lines); the LF rebuild turns those escapes into plain LF
escapes and changes nothing else in dist/ (105033→103629 and 53032→52828
bytes, 702×2 and 102×2 exactly; every runtime code byte identical).

Consequence for future pins: refresh dist/ on the fork (bun run build on the
exact pinned tree, commit) BEFORE the pin ever moves — rampart AGENTS.md
maintenance rule — and re-vet the next delta the same way: read every src/
change in full, classify the rest — and extend this record.
