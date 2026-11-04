import {
  conversationErrorResponse,
  loadTurns,
  nextUnansweredQuestion,
} from "../../../../lib/conversation";
import {
  loadAnswers,
  loadSession,
  readSessionCookie,
} from "../../../../lib/intake/store";
import {
  assertNoPiiValues,
  buildClientState,
} from "../../../../lib/intake/serialize";
import {
  logInfo,
  requestIdFromHeaders,
  runWithRequestId,
} from "../../../../lib/telemetry";

// GET /api/conversation/history (Mission v2 M1): the resume surface. Read-only
// — no session creation, no cookie writes. The transcript stored in
// conversation_turn is already redacted at write time; the answer state goes
// through the same client-state boundary the wizard uses (pii values
// structurally omitted). All state lives in Postgres: reload and server
// restart restore byte-identical history (VAL-CONV-007).

// HACK-160 (VAL-UX-004): the empty-chat seed's source — the question
// engine's own next unanswered talk-saveable question, computed with the
// same pure function every turn uses (no model call). Serialized to the
// bubble's display shape: spec prompt + id only, never an answer value.
function nextSeedQuestion(answers: Parameters<typeof nextUnansweredQuestion>[0]): {
  id: string;
  prompt: string;
} | null {
  const next = nextUnansweredQuestion(answers);
  return next ? { id: next.id, prompt: next.prompt } : null;
}

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      if (!cookieValue) {
        return Response.json({
          turns: [],
          state: buildClientState({}),
          nextQuestion: nextSeedQuestion({}),
        });
      }
      const sessionId = await loadSession(cookieValue);
      if (!sessionId) {
        // Fail open like the flow does: a junk or stale cookie is a fresh
        // visitor, not an error.
        return Response.json({
          turns: [],
          state: buildClientState({}),
          nextQuestion: nextSeedQuestion({}),
        });
      }
      const turns = await loadTurns(sessionId);
      const answers = await loadAnswers(sessionId);
      const state = buildClientState(answers);
      assertNoPiiValues(state);
      logInfo("conversation_history_loaded");
      return Response.json({
        turns,
        state,
        nextQuestion: nextSeedQuestion(answers),
      });
    } catch (error) {
      return conversationErrorResponse(error);
    }
  });
}
