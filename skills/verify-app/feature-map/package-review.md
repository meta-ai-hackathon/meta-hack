# Package review

The review screen lists everything answered and everything still needed, labels each answer's provenance as user-supplied or AI-drafted, lets the person or caseworker edit any answer in place, and flows the edits back into the session so downstream views reflect them.

## Sub-features

- `review-list` lists answered items and still-needed items (BN-21).
- `review-provenance` labels every answer as user-supplied or AI-drafted (BN-21).
- `review-edit` edits an answer in place on the review screen.
- `review-flows-back` propagates edits into the session and downstream views.

## How to get to it (user POV)

- Finish form prep; the review screen follows the last question.
- Follow the review action from the handoff view.
- Resume a prepared session from a saved session link.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- A synthetic persona fixture (BN-37) has a completed form-prep session with at least one AI-drafted answer and one still-needed item.

- **Open the review.** Finish form prep or follow the review action. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the review screen lists answered and still-needed items, each answered item carrying a provenance label.
- **Check the provenance labels.** Read the answered items. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the fixture's user-supplied and AI-drafted answers carry the correct, distinct labels.
- **Edit in place.** Change one answer from the review screen. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the edit saves and the review screen shows the new value.
- **Verify the edit flows back.** Reopen the same session read-only in a fresh context and check a downstream view (requirements checklist, handoff). Command: TBD — lands with the verify-app skill (HACK-8). Expected: the edited value appears downstream — the reopened session is the mutation proof.
- **Proof.** Capture the review screen with labels, the edit, and the downstream view. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-21`.

## Gotchas

- A missing provenance label is a failure. AI-drafted answers must be distinguishable from user-supplied ones at a glance (BN-21).
- The still-needed list must match the requirements checklist. A discrepancy means the state machine dropped or invented an item.
- Editing on the review screen must update the one stored answer. A second, divergent answer record is a failure.
- Review confirms preparation, never submission. Any affordance or copy here that submits the application is a failure (BN-24, BN-25).
