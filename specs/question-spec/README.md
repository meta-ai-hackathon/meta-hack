# Question spec

The question spec is the data contract for the Benefits Navigator interview: a single, pilot-agnostic JSON document that lists every question the app can ask, the plain-language help text for each, and the deterministic rules for which question comes next. It implements the docassemble "YAML interview as data" pattern (COPY-SEMANTICS, see `feature.md`) in our own stack: the flow is a pure function of the stored answers, one question per screen. Program-specific and pilot-specific questions (verified content from HACK-17) fill the same schema later and append to this generic set.

Since the pilot lock (HACK-16 Done, Oct 30), this directory also carries the **program-requirements layer** (`program-requirements.json`): a committed, reviewed decision naming which question ids each program's application actually needs. It selects from `generic-questions.json` — which stays the single source of truth for question definitions and the only pilot-agnostic file here; the requirements layer names program ids and links committed form registries by design.

## Spec format: field meanings

Each question-spec document is a JSON object with a `questions` array and an `answer_statuses` array, the latter declaring the tri-state answer-status vocabulary (`known`, `unknown`, `unverified`, per BN-05) that every answer in the document can carry. Each entry in `questions` is one screen.

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Snake_case identifier, unique in the document. Referenced by `skip_conditions` and by the answer store. |
| `prompt` | string | The question as shown on screen. One short sentence in plain language. |
| `type` | string | Input control. One of `text`, `number`, `boolean`, `single_select`, `multi_select`, `date`, `address`. |
| `help` | string | Plain-language help text shown under the question. Short sentences, no jargon. |
| `terms` | array of strings | Optional glossary term IDs (plain-language glossary, BN-30) shown as links on the same screen. |
| `pii` | boolean | Marks the field as personally identifiable. `pii: true` fields never leave the server: they live only in the encrypted session store and are never placed in an LLM prompt (PII boundary, BN-03). |
| `required` | boolean | Whether the flow can advance without an answer. Non-required questions can be left blank. |
| `options` | array of `{value, label}` | Allowed choices for `single_select` and `multi_select` questions. Required for those types and forbidden for all others. `value` is snake_case and is what skip conditions reference; `label` is the plain-language text shown on screen. |
| `skip_conditions` | array | Conditions under which the engine skips this question. Each entry is `{question_id, operator, value}`. Empty array means always asked. |
| `provenance` | string | Where the answer comes from. Constant `user-supplied` in this skeleton; later specs may add engine-supplied sources. |

## Deterministic traversal contract

Next-question selection is pure code. There is no model in the flow-decision loop.

- **Evaluation order.** The engine walks the `questions` array in order and shows the first unanswered, unskipped question. Skip conditions are evaluated in array order.
- **Skip semantics.** A question is skipped when any one of its `skip_conditions` matches (OR across entries). For a `multi_select` question, the condition's comma-separated `value` is split into a list: `equals`/`in` match when at least one listed value is among the selected options, and `not_equals`/`not_in` match when none of the listed values is among the selected options (any-overlap semantics).
- **Operators.** `equals`, `not_equals` (exact match on the stored answer), `in`, `not_in` (value is / is not in a comma-separated list; for `multi_select` answers the list is split per skip semantics above), `gt` (numeric, for `number` answers).
- **No model in the loop.** The LLM contributes phrasing of the prompt, help text variants, and next-step framing only (BN-18, BN-40). Which question comes next, whether a question is skipped, and whether the flow may advance are decided by this contract alone, so the flow completes end to end with the model unavailable.
- **Tri-state answers.** Every answer is `known`, `unknown` ("I don't know"), or `unverified` (answered but not checked against a source), per the honest-answers contract (BN-05). An `unknown` or `unverified` answer still satisfies `required` — the flow never blocks on uncertainty, and downstream claims reflect the state instead of overstating it. Help text invites "not sure" where it applies.
- **Skip conditions on non-`known` answers.** A condition whose referenced answer is `unknown` or `unverified`, or absent because the question was skipped or left blank, never matches — only a `known` value can satisfy an operator, so the dependent question is asked. The flow never silently skips on uncertainty.
- **PII boundary.** `pii: true` fields stay server-side in the encrypted session store. They are never included in any model prompt, log line, or client-visible payload outside the user's own session (BN-03). The spec is the machine-checkable source of this classification. All free-text fields (`type: text` or `type: address`) are `pii: true` by rule, because users predictably type identifying content into them.
- **Resumable by construction.** Answers live in a server-side session dict keyed by question `id` (BN-13). Resume means: re-run this traversal over the stored answers and land on the first unanswered, unskipped question.

## Consumers

The same spec drives both user-facing journeys:

- **Intake (BN-09).** The structured first-sitting flow renders one question per screen from this spec, applies the skip logic, and saves each answer to the session store without an explicit save action. Resume re-runs the traversal.
- **Form prep (BN-18).** The application-prep flow consumes the same spec in "questionless interview" mode: it advances to the next needed field, asks it one at a time, and folds the answers into the prepared package. The package review (BN-21) lists answered vs still-needed items read back from the same store. Prepared is never submitted (BN-25).

## Files

| File | Purpose |
| --- | --- |
| `schema.json` | JSON Schema (draft-07) for any question-spec document. |
| `generic-questions.json` | Pilot-agnostic generic question set, valid against `schema.json`. |
| `program-requirements.schema.json` | JSON Schema (draft-07) for the program-requirements layer. |
| `program-requirements.json` | Per-program required question ids plus the form registries whose `spec_question_id` links join each program's required universe. Gated by `tests/test_program_requirements.py`; consumed read-only by `src/lib/intake/requirements.ts`. |
