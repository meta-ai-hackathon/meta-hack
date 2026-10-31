import {
  AppError,
  requestIdFromHeaders,
  runWithRequestId,
  userMessageFor,
} from "../../../../lib/telemetry";
import { errorResponse, optionalJsonBody } from "../../../../lib/intake/api";
import {
  loadSession,
  loadSessionState,
  readSessionCookie,
} from "../../../../lib/intake/store";
import { purgeSessionData } from "../../../../lib/purge";

// POST /api/session/purge (HACK-80, VAL-DEMOEXP-006/007): the server half
// of the visible purge. Deletes every data row for the caller's session —
// answer, vault_entry, conversation_turn, and the caseworker audit notes —
// and leaves the bare receipt (person + session rows), so a resume after
// the purge shows an empty journey.
//
// Two triggers, both explicit:
// - the manual "delete my answers" control sends { confirmed: true } from
//   the person's click;
// - a session ALREADY carrying user_reported_submitted purges without the
//   flag — that state exists only on the person's own report (no code path
//   sets it; BN-25), so the state IS the confirmation, and the purge
//   behaves identically (data-state-driven).
//
// Anything else — no confirmation flag, any other session state — is
// refused with a validation error and deletes NOTHING: no purge without
// confirmation. An unconfirmed submission therefore leaves every answer in
// place and the journey resumable.

interface PurgeRequestBody {
  confirmed?: unknown;
}

/**
 * The purge is the one IRREVERSIBLE mutation in the app, so it gets the
 * strictest CSRF gate of all routes on top of the session cookie's
 * SameSite=Lax: a browser request whose Sec-Fetch-Site says the call was
 * issued from another site (a cross-site form post, for instance) is
 * refused before anything is read. Browsers set this header on every
 * request they make; non-browser callers (the walkthrough, curl) set none
 * and pass.
 */
function isCrossSiteBrowserRequest(request: Request): boolean {
  return request.headers.get("sec-fetch-site") === "cross-site";
}

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      if (isCrossSiteBrowserRequest(request)) {
        return errorResponse(
          new AppError("validation_error", userMessageFor("validation_error")),
        );
      }
      const parsed = await optionalJsonBody(request);
      const body =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as PurgeRequestBody)
          : null;
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const sessionId = await loadSession(cookieValue);
      if (!sessionId) {
        return errorResponse(
          new AppError("not_found", userMessageFor("not_found")),
        );
      }
      const session = await loadSessionState(sessionId);
      if (!session) {
        return errorResponse(
          new AppError("not_found", userMessageFor("not_found")),
        );
      }
      const confirmedByAction = body?.confirmed === true;
      const confirmedByState = session.status === "user_reported_submitted";
      if (!confirmedByAction && !confirmedByState) {
        // Nothing is touched: the refusal precedes every delete.
        return errorResponse(
          new AppError("validation_error", userMessageFor("validation_error")),
        );
      }
      const deleted = await purgeSessionData(sessionId);
      return Response.json({ purged: true, deleted });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
