import { ATTRIBUTION_QUESTION_ID } from "./attribution";
import { ROSTER_QUESTION_ID } from "./roster";
import { WORK_ROWS_QUESTION_ID } from "./work-activities";

// The talk path's question filter, extracted from src/lib/conversation.ts
// (HACK-160) into a pure, browser-safe module so the CLIENT can pick the
// same next question the server's engine would ask — the empty chat's
// seeded first bubble reads it. The structured wizard-only questions
// (roster, per-person attribution, per-person work rows) are never
// extracted or saved from a model turn (HACK-134/135), so the talk stage
// never opens by asking one. Pure constants and one pure function — no
// storage, no network, no model access.

/** Whether the talk path may save an extracted answer for a question. Structured wizard-only questions (roster, per-person attribution) are never extracted or saved from a model turn (HACK-134/135). */
export function talkPathSavesQuestion(questionId: string): boolean {
  return (
    questionId !== ROSTER_QUESTION_ID &&
    questionId !== ATTRIBUTION_QUESTION_ID &&
    questionId !== WORK_ROWS_QUESTION_ID
  );
}
