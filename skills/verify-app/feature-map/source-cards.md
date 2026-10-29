# Source cards

Source cards are the cross-cutting provenance surface: every requirement, document, and deadline shown anywhere in the product displays its official source, retrieval date, and version, and stale or withdrawn entries are never cited silently — the assistant refuses or flags the version change.

## Sub-features

- `src-card` shows official source, retrieval date, and version on every requirement, document, and deadline (BN-27).
- `src-on-claims` attaches a source card to every assistant claim drawn from the knowledge base (BN-27).
- `src-stale` flags a stale entry's version change visibly; the assistant never cites it silently (BN-29).
- `src-withdrawn` refuses to rely on a withdrawn entry instead of citing it (BN-29).

## How to get to it (user POV)

- Read the source card under any item on the requirements checklist.
- Open the provenance shown with any assistant answer or document explanation.
- Follow the version flag on a deadline or rule that changed.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- The fixture knowledge base has one current entry, one stale entry, and one withdrawn entry for the pilot program.
- A synthetic persona session (BN-37) has reached the requirements checklist and asked the guide one covered question.

- **Inspect a card.** Open a requirement's source card. Command: TBD — lands with the verify-app skill (HACK-8). Expected: official source, retrieval date, and version all visible, and the link target matches the cited source.
- **Check an assistant claim.** Ask the guide a covered question. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the answer carries its source card; a claim without one is a failure.
- **Check the stale entry.** Open the fixture's stale entry. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the version-change flag is user-visible and the assistant flags the change when the topic comes up — never a silent citation.
- **Check the withdrawn entry.** Open the fixture's withdrawn entry. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the assistant refuses to rely on it and says so, rather than citing it.
- **Proof.** Capture a card from each journey surface (requirements, deadlines, guide answer) plus the stale and withdrawn flags. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-27` and `BN-29`.

## Gotchas

- A card missing any of the three elements — official source, retrieval date, version — fails.
- A stale answer that reads like a live one is the worst failure mode in the product; the flag must be user-visible, not just logged (BN-29).
- Source cards are cross-cutting. Verifying them on one screen under-covers the check; sample every surface that makes a claim.
- Cards prove provenance, not truth. Retrieval date and version let a person re-check the source; do not "verify" the underlying rule yourself.
