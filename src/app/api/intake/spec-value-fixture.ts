import type { Question } from "../../../lib/intake/spec";

// Test fixture shared by the intake and conversation route suites (the
// quick-questions proof files): ONE spec-valid known value per question
// type, so the two suites can never drift apart on what counts as a
// valid answer shape. Not a route, not runtime code — imported only by
// *.test.ts files.

/** A spec-valid known value for each question type (test fixture only). */
export function specValueFor(
  question: Question,
): string | number | boolean | string[] {
  switch (question.type) {
    case "text":
    case "address":
      return `A test answer for ${question.id}`;
    case "number":
      return 3;
    case "boolean":
      return false;
    case "date":
      return "1990-05-14";
    case "single_select":
      return question.options![0]!.value;
    case "multi_select":
      return [question.options![0]!.value];
  }
}
