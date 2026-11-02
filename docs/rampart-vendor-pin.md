# Rampart vendor pin record

`@nationaldesignstudio/rampart` is pinned to one commit of the maintained
fork (`meta-ai-hackathon/rampart`). Both pins are maintained as one; the
dependable one is the full 40-character SHA:

| File | Pin |
| --- | --- |
| `package.json` | `github:meta-ai-hackathon/rampart#349345fd9d2b07445bf95932364148d49474bcbb` |
| `pnpm-workspace.yaml` | `https://codeload.github.com/meta-ai-hackathon/rampart/tar.gz/349345fd9d2b07445bf95932364148d49474bcbb`, the only entry under `onlyBuiltDependencies` |

## What each vetted commit is

- `e2bd8f8e2bd5a26dc82bbf21e1955a9d0f22397d` — the serialize/deserialize
  session seam the review rounds vetted (PR #98's original pin).
- `349345fd9d2b07445bf95932364148d49474bcbb` — the same change carried
  along when the fork's main was re-based (PR #98's review round pinned
  this one; identical subject, identical feature patch).

## The delta between the two, vetted and recorded (HACK-107 review P2)

`e2bd8f8..349345f` adds repo tooling only; nothing in the package's
source tree changes:

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

Consequence for future pins: when the fork's main moves again, re-vet
the next `e2bd8f8..NEXT` delta the same way — file list, no `src/`
changes, no runtime surface — and extend this record.
