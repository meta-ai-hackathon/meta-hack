# Deadlines tracker

The deadlines tracker shows dates from the verified knowledge base and events the person reported, clearly labeled by origin, and fires an in-app reminder when a deadline approaches.

## Sub-features

- `dl-kb` shows knowledge-base dates with their source cards (BN-22, BN-27).
- `dl-user` shows user-reported events, labeled as user-reported (BN-22).
- `dl-reminder` fires an in-app reminder when a deadline approaches.
- `dl-versions` flags stale or withdrawn knowledge-base dates instead of showing them silently (BN-29).

## How to get to it (user POV)

- Open the tracker view from the requirements checklist.
- Follow the deadline reference on the handoff view.
- Reach a deadline entry from a follow-up explainer notice.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- The fixture knowledge base carries one known upcoming deadline and one known stale entry for the pilot program.
- A synthetic persona session (BN-37) has one user-reported event; the harness can advance the fixture clock.

- **Open the tracker.** Follow the tracker entry point. Command: TBD — lands with the verify-app skill (HACK-8). Expected: knowledge-base dates appear with source cards and user-reported events carry the user-reported label.
- **Trigger a reminder.** Advance the fixture clock to inside a deadline's reminder window. Command: TBD — lands with the verify-app skill (HACK-8). Expected: an in-app reminder appears for that deadline.
- **Check the stale entry.** Read the fixture's stale knowledge-base date. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the version-change flag is visible; the date is never presented as current (BN-29).
- **Proof.** Capture the labeled tracker, the reminder, and the flagged stale entry. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-22`.

## Gotchas

- Origin labeling is the check. A knowledge-base date without its source card, or a user-reported event styled as official, both fail.
- Do not verify SMS reminders — the SMS channel is gated out of P0 (BN-42); the reminder is in-app only.
- A stale date that renders like a live one is the worst failure mode here; the flag must be user-visible (BN-29).
- Reminder proof needs the fixture clock, not a real wait. Sleeping until a real deadline is not a verification plan.
