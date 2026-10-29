import { logInfo, requestIdFromHeaders, runWithRequestId } from "../../../../lib/telemetry";
import { errorResponse } from "../../../../lib/intake/api";
import {
  loadAnswers,
  loadSession,
  readSessionCookie,
} from "../../../../lib/intake/store";
import {
  assertNoPiiValues,
  buildClientState,
} from "../../../../lib/intake/serialize";

// GET /api/intake/state (BN-09): the client-visible intake state — visible
// questions in spec order, stored answers with tri-state statuses, and
// progress. Read-only: a visitor without a recognized session gets the
// empty state and no cookie; the first answer POST creates the session.
// pii:true answer values are structurally absent from the payload (the
// serialization boundary in lib/intake/serialize.ts).

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const sessionId = await loadSession(cookieValue);
      const answers = sessionId ? await loadAnswers(sessionId) : {};
      const state = buildClientState(answers);
      // Defense in depth: never ship a pii value even if a future refactor
      // breaks the structural omission above.
      assertNoPiiValues(state);
      logInfo("intake_state_served", { has_session: sessionId !== null });
      return Response.json(state);
    } catch (error) {
      return errorResponse(error);
    }
  });
}
