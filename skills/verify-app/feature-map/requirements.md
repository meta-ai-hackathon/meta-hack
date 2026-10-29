# Requirements

The requirements view lists the pilot program's required documents, steps, and deadlines as a checklist with every item source-linked; facts the person has not provided surface as explicit to-resolve items; and each document gets a plain-language explanation with how to replace it and official links.

## Sub-features

- `req-checklist` lists required documents, steps, and deadlines as a checklist, each item source-linked (BN-15).
- `req-toresolve` shows missing facts as explicit to-resolve items, never inferred (BN-16).
- `req-plain-docs` explains each document in plain language, with how to replace it and official links (BN-17).

## How to get to it (user POV)

- Follow the "what's needed" link from the program presentation.
- Follow a to-resolve item from the package review screen.
- Reach it from the handoff view's next action.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- A synthetic persona fixture (BN-37) with at least one known missing fact has completed intake and program presentation.
- The fixture knowledge base lists the program's requirements with sources.

- **Open the checklist.** Follow the "what's needed" link. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the checklist appears and every item shows a source card with official source, retrieval date, and version (BN-27).
- **Check to-resolve items.** Read the checklist with the fixture's missing fact. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the missing fact appears as an explicit to-resolve item, not a blank or an assumption.
- **Open a document explanation.** Choose one required document. Command: TBD — lands with the verify-app skill (HACK-8). Expected: a plain-language explanation of what the document is, a replacement path, and an official link.
- **Follow an official link.** Open one official link. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the official source opens, matching the item's source card.
- **Proof.** Capture the checklist with source cards, the to-resolve item, and one document explanation. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-15`, `BN-16`, and `BN-17`.

## Gotchas

- A missing fact the app silently assumes or infers is a failure; it must surface as an explicit to-resolve item (BN-16).
- Official links must come from the knowledge base and match the source card. An app-generated page or a generic search result is not an official link.
- A deadline on the checklist without its retrieval date and version fails the source-card rule (BN-27).
- Replacement guidance is procedural ("how to request a replacement"). Outcome language ("this will be accepted") fails the honest-answers boundary (BN-05).
