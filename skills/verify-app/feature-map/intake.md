# Intake

Intake asks a small set of plain-language situation and location questions, one question per screen, and saves progress so a person can stop at any point and resume in a later sitting with all prior answers intact.

## Sub-features

- `intake-plain` asks situation and location questions in plain language, free of benefits jargon (BN-09).
- `intake-one-screen` shows exactly one question per screen.
- `intake-skip-logic` skips questions that earlier answers make irrelevant.
- `intake-save` persists progress without requiring an explicit save action.
- `intake-resume` resumes a saved session in a later sitting at the next unanswered question, with prior answers intact (BN-13).

## How to get to it (user POV)

- Choose the start control on the app's home screen (planned landing screen).
- Resume an earlier sitting by reopening the saved session link.
- Reach it from the AI guide when the guide hands control to the structured flow.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- A synthetic persona fixture (BN-37) is loaded; no real resident data exists in the run.
- No saved session exists for the fixture's answers yet.

- **Start intake.** From the home screen, choose the start control. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the first intake question appears alone on its screen, in plain language.
- **Answer a question.** Choose the fixture's answer for the shown question. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the next relevant question appears; progress is saved without an explicit save action.
- **Check skip logic.** Give an answer whose skip condition makes a later question irrelevant. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the irrelevant question never renders anywhere in the flow.
- **Leave mid-intake.** End the sitting after answering at least one question. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the session persists and its link still opens the flow.
- **Resume in a second sitting.** Reopen the session link in a fresh browser context. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the flow continues at the next unanswered question, and revisiting earlier screens shows the prior answers unchanged — the reopened session is the mutation proof for this feature.
- **Proof.** Capture the first question, the resumed screen, and the intact prior answers. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-09` and `BN-13` show the question text and the saved answers.

## Gotchas

- One question per screen is the contract. A screen that renders two questions at once fails the check even if both answers save.
- Resume must land on the next unanswered question. Landing back at the first question means saved progress is silently lost.
- A summary screen that recomputes answers instead of reading stored ones is not proof of resume. Reopen the session read-only and check the stored values.
- Do not retype the fixture's answers during the second sitting; that destroys the distinction between saved data and re-entered data.
- Synthetic fixtures only (BN-37). Never type real identity details into the flow, even to "save time" — they would enter the session store and violate the PII boundary (BN-03).
