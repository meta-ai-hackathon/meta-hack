import {
  buildMatchResponse,
  assertNoPiiValuesInMatch,
  composeFallbackExplanation,
  explainEntry,
  type MatchExplainer,
} from "../../../lib/match";
import {
  consentPathEnabled,
  parseConsentReceipt,
  CONSENT_HEADER,
} from "../../../lib/consent";
import {
  conversationErrorResponse,
} from "../../../lib/conversation";
import { loadAnswers, loadSession, readSessionCookie } from "../../../lib/intake/store";
import { logInfo, requestIdFromHeaders, runWithRequestId } from "../../../lib/telemetry";

// POST /api/match (and GET) — the ranked benefit match for the session
// (Mission v2 M3, VAL-MATCH-001..005). Read-only: the route loads the
// session's stored answers server-side (answers never arrive from the
// client, so they cannot be spoofed) and returns the ranked, source-linked
// cards plus the explicit to-resolve list. No session is ever created
// here; an anonymous or junk cookie gets an honest empty payload. The
// response passes the pii defense-in-depth check before it leaves, and a
// database failure maps onto the shared taxonomy error response.
//
// The route imports the conversation module's shared error mapper: match
// requests that cannot reach the database degrade through the same
// taxonomy + wizard-fallback payload as every other app surface.
//
// CONSENT GATE (Mission v2.1 M5, HACK-81, VAL-CONSENT-001): the model
// explanation call fires ONLY for a client whose receipt allows AI
// sharing — even though that call carries no user content (it is grounded
// on the matched KB entry alone). Without a receipt the route spends ZERO
// provider calls and the cards carry the deterministic entry-fact
// explanation, so a declined session completes the match with no
// provider traffic at all.

export async function GET(request: Request): Promise<Response> {
  return matchResponse(request);
}

export async function POST(request: Request): Promise<Response> {
  return matchResponse(request);
}

async function matchResponse(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const sessionId = await loadSession(cookieValue);
      if (!sessionId) {
        // Read-only, fail-open: no session, no match surface, nothing created.
        return Response.json({ hasSession: false, matches: [], toResolve: [] });
      }
      const receipt = parseConsentReceipt(request.headers.get(CONSENT_HEADER));
      const explainer: MatchExplainer = consentPathEnabled(
        "ai-conversation",
        receipt,
      )
        ? explainEntry
        : (entry) =>
            Promise.resolve({
              text: composeFallbackExplanation(entry),
              source: "facts",
            });
      const answers = await loadAnswers(sessionId);
      const match = await buildMatchResponse(answers, { explainer });
      assertNoPiiValuesInMatch(match, answers);
      logInfo("match_request_completed");
      return Response.json({ hasSession: true, ...match });
    } catch (error) {
      return conversationErrorResponse(error);
    }
  });
}
