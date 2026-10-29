# Caseworker-assisted mode

Caseworker-assisted mode lets a helper operate the same session under an "I'm helping someone else" choice, with an audit note recording that a third party assisted, so a resident can get help without giving up the app's data boundaries.

## Sub-features

- `cw-optin` marks the session as helper-assisted via the "I'm helping someone else" choice (BN-10).
- `cw-same-flow` gives the helper the identical one-question-per-screen flow, save and resume included.
- `cw-audit` records an audit note that a helper assisted the session.
- `cw-own-backend` routes helper access through the app's own backend authorization.

## How to get to it (user POV)

- Choose "I'm helping someone else" on the home screen before starting intake.
- Switch an in-progress session into helper mode from the session's own controls.
- Reopen a shared session link as the helper in a later sitting.

## Driving it with the verify-app harness

Preconditions:

- The app is healthy at its local URL (port TBD — lands with HACK-8) and the doctor-style check passes.
- A synthetic persona fixture (BN-37) is loaded; the helper and the resident are different fixture identities.
- No helper-assisted session exists yet.

- **Declare helping.** Choose "I'm helping someone else" on the home screen. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the session is marked helper-assisted and the audit note records the choice.
- **Drive the flow.** Answer one intake question as the helper. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the same one-question-per-screen flow as a self-driven session; the answer saves.
- **Verify the audit note.** Reopen the session's audit or history view read-only. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the audit note shows that a helper assisted, tied to this session — the read-only second view is the mutation proof.
- **Resume as helper.** Reopen the shared session link in a fresh context and answer one more question. Command: TBD — lands with the verify-app skill (HACK-8). Expected: the flow resumes with prior answers intact and the audit note still present.
- **Proof.** Capture the helper-mode declaration, an answered screen, and the audit note. Command: TBD — lands with the verify-app skill (HACK-8). Expected: artifacts labeled with `BN-10` show the flagged session and the audit record.

## Gotchas

- Helper access must go through our own backend. docassemble's native `multi_user` mode disables session encryption (verified against its documentation); never verify that behavior and never copy it.
- The audit note must survive resume. A note that disappears on the second sitting fails.
- Helper mode changes nothing else: same questions, same skip logic, same honest-answers refusals. A "helper shortcut" that alters the flow is a failure.
- Do not treat the helper's presence as license to enter the resident's real identity details; synthetic fixtures still govern every field (BN-37, BN-03).
