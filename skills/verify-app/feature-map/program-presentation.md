# Program presentation

After intake, the app presents the pilot program as "this may be worth pursuing," with the reasons it may fit the person's situation and what applying needs — never an eligibility determination.

## Sub-features

- `prog-present` shows the pilot program with "may be worth pursuing" framing (BN-14).
- `prog-reasons` lists reasons drawn from the session's answers and knowledge-base entries.
- `prog-needs` states what is needed to apply and links onward to the requirements checklist.
- `prog-screener-gated` shows a labeled screener only if the legal review permits it.

## How to get to it (user POV)

- Finish the intake flow; the presentation follows the last question.
- Reach it from the AI guide after the guide covers the program.
- Return to it from the requirements checklist via a back link.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- A synthetic persona fixture (BN-37) whose answers map to the pilot program in the fixture knowledge base has completed intake.

- **Complete intake.** Finish the intake flow with the fixture's answers. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the program presentation appears, naming the pilot program.
- **Check the framing.** Read the presentation screen. Command: TBD — lands with the verify-app skill (HACK-8). Expected: "may be worth pursuing" wording, reasons traceable to the session's answers, and a "what's needed" list linking to the requirements checklist.
- **Check the screener gate.** Run once with the screener permitted by the fixture's legal-review flag and once without. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the labeled screener appears only when permitted; absent by default.
- **Proof.** Capture the presentation screen and, when permitted, the labeled screener. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-14`.

## Gotchas

- Any eligibility-determination language — "you qualify", "you are eligible", "you will be approved" — is a failure (BN-05).
- A screener without its label is a failure; the label is the feature, not decoration.
- Reasons must trace to the session's answers and knowledge-base entries. A reason that cannot be traced to either is a fabricated claim.
- The pilot program is not chosen until HACK-16; verify against the fixture program and do not encode pilot-specific copy into the check.
