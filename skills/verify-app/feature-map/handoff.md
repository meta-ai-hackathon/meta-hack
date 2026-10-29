# Handoff

The handoff view gives one clear next action — what can be done in-product versus what happens on the official site or with a caseworker — provides deep links and ordered steps for the official application, maintains the prepared-is-not-submitted state machine where external statuses are user-reported only, and explains what mail and notices to expect next.

## Sub-features

- `handoff-next` shows one clear next action, split between in-product, the official site, and a caseworker (BN-23).
- `handoff-portal` provides deep links and ordered step-by-step guidance for the official application, with no auto-submission (BN-24).
- `handoff-states` enforces draft, prepared, handed off, user-reported submitted, user-reported decided (BN-25).
- `handoff-evidence` records external statuses only via user report plus an evidence note (BN-25).
- `handoff-mail` explains the mail and notices to expect and what they might mean, sourced from official guidance (BN-26).

## How to get to it (user POV)

- Approve the prepared package on the review screen; the handoff view follows.
- Reopen a handed-off session from a saved session link to report an external status.
- Follow the deadline reference into the tracker and back.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- A synthetic persona fixture (BN-37) has an approved prepared package, and the fixture knowledge base carries the official portal's links and ordered steps.

- **Open the handoff.** Approve the prepared package. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the handoff view shows one clear next action, split between in-product, official site, and caseworker.
- **Open the official steps.** Follow the official-site next action. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the deep link and ordered steps appear; no submit affordance exists anywhere on the screen.
- **Report a submission.** Enter a user report that the application was submitted, with an evidence note. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the status moves to user-reported submitted, visibly labeled as user-reported.
- **Attempt an illegal transition.** From a draft session, try to reach the decided state by direct navigation. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the transition is impossible by construction — the state machine rejects it, with no warning-only bypass.
- **Open the mail explainer.** Follow the follow-up explainer from the handoff view. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the expected mail and notices appear, each sourced from official guidance.
- **Proof.** Capture the next action, the official steps, the user-reported status with its evidence note, and the mail explainer. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-23`, `BN-24`, `BN-25`, and `BN-26`.

## Gotchas

- No submission affordance anywhere. Any button or link that submits the application is a failure; auto-submission is never in P0 (BN-43).
- UI copy must never blur prepared and submitted. "Your application is prepared" is correct; "your application was sent" is a failure (BN-25).
- External statuses can only come from a user report plus an evidence note. Anything that sets submitted or decided without a report is a failure.
- Illegal transitions must be impossible by construction, not merely warned about. A confirm dialog that lets a draft jump to decided is a failure.
- Portal deep links must come from the knowledge base with their source cards; a hand-typed URL proves nothing about BN-24.
