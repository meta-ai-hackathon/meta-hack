import {
  AppError,
  logInfo,
  requestIdFromHeaders,
  runWithRequestId,
  userMessageFor,
} from "../../../lib/telemetry";
import {
  isAppSettableSessionStatus,
  isUserReportedSessionStatus,
} from "../../../lib/honesty";
import { errorResponse, optionalJsonBody, parseJsonBody } from "../../../lib/intake/api";
import {
  ensureSession,
  isSecureRequest,
  loadAnswers,
  loadSession,
  loadSessionState,
  readSessionCookie,
  recordCaseworkerAssist,
  reportUserReportedStatus,
  sessionCookieHeader,
  setSessionStatus,
  validateAssistNote,
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
      if (assistRequested === true) {
        if (note === undefined) {
          return errorResponse(validationError());
        }
        // Full note validation (non-empty, length bound) pre-DB — the same
        // invariant the answer route follows.
        validateAssistNote(note);
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
        headers.set(
          "set-cookie",
          sessionCookieHeader(sessionId, isSecureRequest(request)),
        );
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

interface SessionStatusBody {
  status?: unknown;
  userReportedStatus?: unknown;
}

// PATCH /api/session (Mission v2 M4, BN-25): the session's lifecycle
// transitions. Exactly one of two fields, each with its own vocabulary:
// - `status` — an app-settable state only (draft / prepared / handed_off).
//   The type excludes every user_reported_* value, so no code path through
//   this route can set a submitted state: prepared ≠ submitted.
// - `userReportedStatus` — what the person TOLD us happened outside the app
//   (user_reported_submitted / user_reported_decided). Recorded as a report,
//   never as an app-set state.
export async function PATCH(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const body = await parseJsonBody(request);
      const { status, userReportedStatus } =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as SessionStatusBody)
          : { status: undefined, userReportedStatus: undefined };
      if (
        (status === undefined) === (userReportedStatus === undefined)
      ) {
        // Exactly one of the two fields — anything else is a bad request.
        return errorResponse(validationError());
      }
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const sessionId = await loadSession(cookieValue);
      if (!sessionId) {
        return errorResponse(
          new AppError("not_found", userMessageFor("not_found")),
        );
      }
      let session;
      if (status !== undefined) {
        if (!isAppSettableSessionStatus(status)) {
          return errorResponse(validationError());
        }
        session = await setSessionStatus(sessionId, status);
      } else {
        if (!isUserReportedSessionStatus(userReportedStatus)) {
          return errorResponse(validationError());
        }
        session = await reportUserReportedStatus(
          sessionId,
          userReportedStatus,
        );
      }
      logInfo("session_status_changed");
      return Response.json({ session });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
