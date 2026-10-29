import {
  conversationErrorResponse,
  processUserTurn,
  validateTurnText,
} from "../../../../lib/conversation";
import {
  ensureSession,
  isSecureRequest,
  loadAnswers,
  readSessionCookie,
  sessionCookieHeader,
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
import { parseJsonBody } from "../../../../lib/intake/api";

// POST /api/conversation/turn (Mission v2 M1, typed text mode): one
// conversational intake turn. Validation runs BEFORE the session is resolved
// (a rejected turn never creates an orphan person/session row); the user's
// words are redacted inside the engine BEFORE storage and client delivery;
// the response carries the assistant reply, the redacted transcript, the
// server-chosen next question id, and the fresh client state (pii values
// structurally omitted). Model failures map to the taxonomy error with the
// wizard fallback link (VAL-CONV-007).

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const text = validateTurnText(await parseJsonBody(request));
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const { sessionId, fresh } = await ensureSession(cookieValue);

      const outcome = await processUserTurn(sessionId, text);

      const answers = await loadAnswers(sessionId);
      const state = buildClientState(answers);
      assertNoPiiValues(state);
      logInfo("conversation_turn_received");

      const headers = new Headers({ "content-type": "application/json" });
      if (fresh) {
        headers.set(
          "set-cookie",
          sessionCookieHeader(sessionId, isSecureRequest(request)),
        );
      }
      return new Response(
        JSON.stringify({
          assistantReply: outcome.assistantReply,
          redactedUserTranscript: outcome.redactedUserTranscript,
          nextQuestionId: outcome.nextQuestionId,
          state,
        }),
        { headers },
      );
    } catch (error) {
      return conversationErrorResponse(error);
    }
  });
}
