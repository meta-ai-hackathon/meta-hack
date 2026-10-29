# Mailing-address guidance

Mailing-address guidance presents sourced options for getting mail without a fixed address — a shelter address with consent, general delivery, or a PO box — as guidance links to official sources, never as outcome promises.

## Sub-features

- `addr-options` presents the sourced options: shelter address with consent, general delivery, PO box (BN-20).
- `addr-consent` presents the shelter-address option as requiring the shelter's consent.
- `addr-sourced` shows each option with its official source, retrieval date, and version (BN-27).
- `addr-links` links out to official guidance instead of promising outcomes.

## How to get to it (user POV)

- Follow the mailing-address to-resolve item on the requirements checklist.
- Ask the AI guide about getting mail without a fixed address.
- Reach it from the package review screen's still-needed list.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- A synthetic persona fixture (BN-37) with no fixed address has reached the requirements checklist.
- The fixture knowledge base carries address-guidance entries for the pilot location.

- **Open the guidance.** Follow the mailing-address to-resolve item. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the options appear, each with its source card showing official source, retrieval date, and version.
- **Check the consent condition.** Read the shelter-address option. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the option states it requires the shelter's consent.
- **Follow a guidance link.** Open one option's official link. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the official source opens and matches the option's source card.
- **Proof.** Capture the options list with source cards and the consent condition. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-20`.

## Gotchas

- Guidance links, never outcome promises. "This will get you your mail" or any guaranteed-delivery wording is a failure (BN-05).
- The shelter-address option without its consent condition is a failure.
- Address rules change by jurisdiction. Verify against the knowledge base's retrieval dates and the pilot location's entries, not against generic web results.
- Choosing an option here is guidance only; it must not mark the mailing-address to-resolve item resolved without the person actually providing an address.
