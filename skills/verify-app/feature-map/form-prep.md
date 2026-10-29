# Form prep

Form prep asks one question at a time and organizes the answers into a prepared application package, following docassemble's "questionless interview" semantics copied into our own deterministic state machine — the model only phrases, the flow never depends on it.

## Sub-features

- `prep-one-question` asks one question per screen and advances the package answer by answer (BN-18).
- `prep-package` organizes the answers into a prepared application package.
- `prep-deterministic` drives the flow with a deterministic state machine; the LLM contributes phrasing only.
- `prep-static-path` completes the flow end to end with the model unavailable (BN-40).

## How to get to it (user POV)

- Follow the "start application prep" action from the requirements checklist.
- Continue directly after the program presentation.
- Resume an in-progress prep from a saved session link.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- A synthetic persona fixture (BN-37) has completed intake and program presentation.
- A second run can force the model unavailable (BN-40).

- **Start prep.** Follow the "start application prep" action. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the first prep question appears alone on its screen.
- **Answer through the flow.** Answer each question with the fixture's values. Command: TBD — lands with the verify-app skill (HACK-8). Expected: each answer advances exactly one screen and the prepared package grows accordingly.
- **Reach the package.** Answer the last question. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the prepared application package lists the entered answers, ready for review.
- **Model unavailable.** Force the model unavailable, then run the whole flow again. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the flow completes on the static path with the same questions and the same package; no hang, no blank screen (BN-40).
- **Proof.** Capture one mid-flow screen, the prepared package, and the static-path package. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-18`, and the two packages match.

## Gotchas

- One question at a time. A screen that fills multiple package fields at once fails the docassemble-copied semantics.
- With the model unavailable the flow must still work end to end. A hang, an error, or a degraded question set on the static path is a failure.
- The prepared package is not an application. Nothing in this journey may read as submission (BN-25); the next step is review, never "send".
- docassemble is a pattern reference only (COPY-SEMANTICS). Never launch or operate docassemble itself as part of verification.
