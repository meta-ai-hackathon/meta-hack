import {
  AppError,
  logInfo,
  requestIdFromHeaders,
  runWithRequestId,
  userMessageFor,
} from "../../../lib/telemetry";
import { errorResponse } from "../../../lib/intake/api";
import {
  ensureSession,
  loadAnswers,
  loadSession,
  loadSessionState,
  readSessionCookie,
  recordCaseworkerAssist,
  sessionCookieHeader,
} from "../../../lib/intake/store";
import {
  assertNoPiiValues,
  buildClientState,
} from "../../../lib/intake/serialize";

// /api/session (BN-13 / HACK-40): create and resume a benefits session.
//
// POST — create the session up front (before the first answer) and tie this
// browser to it with the httpOnly bn_session cookie, or resume the session
// the cookie already names. An optional { caseworkerAssisted, note } body
// records caseworker assistance as an audit note (BN-10); the note is
// required whenever a caseworker-assisted session is requested.
// GET — resume with the token: the client-visible state (answers, tri-state
// statuses, flow position) plus the session's lifecycle summary, all read
// fresh from Postgres. There is no in-memory session state anywhere, so a
// resumed session is identical across reloads and server restarts.
//
// Session-token choice (documented in docs/save-resume.md): the token lives
// ONLY in an httpOnly cookie. Page scripts can neither read nor exfiltrate
// it, and its 30-day Max-Age keeps the tie across browser restarts. A
// URL-borne return token was rejected — URLs leak via history and referrer
// headers, and the cookie fully covers the same-browser sitting-to-sitting
// case BN-13 describes.

interface SessionRequestBody {
  caseworkerAssisted?: unknown;
  note?: unknown;
}

function validationError(): AppError {
  return new AppError("validation_error", userMessageFor("validation_error"));
}

/** Parse an optional JSON body; an absent or empty body means {}. */
async function optionalJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw validationError();
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const parsed = await optionalJsonBody(request);
      const body =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as SessionRequestBody)
          : null;
      if (body === null) {
        return errorResponse(validationError());
      }
      // Validate the request BEFORE touching the database: a rejected
      // caseworker-assisted request must not leave an orphan person/session.
      const assistRequested = body.caseworkerAssisted;
      if (assistRequested !== undefined && typeof assistRequested !== "boolean") {
        return errorResponse(validationError());
      }
      const note = body.note;
      if (note !== undefined && typeof note !== "string") {
        return errorResponse(validationError());
      }
      if (assistRequested === true && (note === undefined || note.trim() === "")) {
        return errorResponse(validationError());
      }

      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const { sessionId, fresh } = await ensureSession(cookieValue);
      if (assistRequested === true && typeof note === "string") {
        await recordCaseworkerAssist(sessionId, note);
      }

      const answers = await loadAnswers(sessionId);
      const session = await loadSessionState(sessionId);
      const state = buildClientState(answers);
      assertNoPiiValues(state);
      logInfo("session_created_or_resumed", {
        fresh,
        assisted: assistRequested === true,
      });
      const headers = new Headers({ "content-type": "application/json" });
      if (fresh) {
        headers.set("set-cookie", sessionCookieHeader(sessionId));
      }
      return new Response(JSON.stringify({ session, state }), {
        status: fresh ? 201 : 200,
        headers,
      });
    } catch (error) {
      return errorResponse(error);
    }
  });
}

// GET /api/session: resume with the session token. A visitor with no
// recognizable token has nothing to resume — 404, never a session creation
// (GET stays side-effect-free, like /api/intake/state).

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const sessionId = await loadSession(cookieValue);
      const answers = sessionId ? await loadAnswers(sessionId) : {};
      const session = sessionId ? await loadSessionState(sessionId) : null;
      if (!sessionId || !session) {
        return errorResponse(
          new AppError("not_found", userMessageFor("not_found")),
        );
      }
      const state = buildClientState(answers);
      assertNoPiiValues(state);
      logInfo("session_resumed");
      return Response.json({ session, state });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
