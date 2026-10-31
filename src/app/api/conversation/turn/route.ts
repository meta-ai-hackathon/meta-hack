import {
  conversationErrorResponse,
  processUserTurn,
  transcribeTurnAudio,
  turnSessionContext,
  validateTurnText,
} from "../../../../lib/conversation";
import {
  consentPathEnabled,
  parseConsentReceipt,
  CONSENT_HEADER,
  type ConsentPathId,
} from "../../../../lib/consent";
import {
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
  AppError,
  logInfo,
  requestIdFromHeaders,
  runWithRequestId,
  userMessageFor,
} from "../../../../lib/telemetry";
import { parseJsonBody } from "../../../../lib/intake/api";

// POST /api/conversation/turn — one conversational intake turn, typed text
// (JSON) or spoken audio (multipart, Mission v2 M2). Validation runs BEFORE
// the session is resolved (a rejected turn never creates an orphan
// person/session row); the session itself is only created after extraction
// succeeds; the user's words are redacted inside the engine BEFORE storage
// and client delivery; both turns persist only after the assistant reply
// succeeds (a retry never duplicates a transcript). The response carries
// the assistant reply, the redacted transcript, the server-chosen next
// question id, and the fresh client state (pii values structurally omitted).
// Model failures map to the taxonomy error with the wizard fallback link
// (VAL-CONV-007).
//
// CONSENT GATE (Mission v2.1 M5, HACK-81, VAL-CONSENT-001/003): the FIRST
// thing this route does is check the per-device consent receipt the client
// sends with every request. HONEST FRAMING: downstream, the extraction call
// sees the raw typed sentence before classification — redaction protects
// storage and the screen, not that send. This gate therefore runs before
// the body is even read: a refused turn is never parsed, never persisted,
// and never forwarded to any provider. Typed turns require the AI consent;
// voice turns additionally require the voice toggle (their own gate).

/** Refuse the request unless the receipt allows this path. */
function requireConsent(request: Request, pathId: ConsentPathId): void {
  const receipt = parseConsentReceipt(request.headers.get(CONSENT_HEADER));
  if (!consentPathEnabled(pathId, receipt)) {
    throw new AppError("consent_required", userMessageFor("consent_required"));
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const routeStarted = Date.now();
      const contentType = request.headers.get("content-type") ?? "";
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      // Consent FIRST — a refused turn never reads user content.
      const isVoice = contentType.includes("multipart/form-data");
      if (isVoice) {
        requireConsent(request, "voice");
      } else {
        requireConsent(request, "ai-conversation");
      }
      // Voice turns arrive as multipart audio; typed turns as JSON. Both
      // produce the turn text and share everything downstream.
      // Per-segment timing (VAL-FIX-004): the STT segment is timed here;
      // the engine segment wraps processUserTurn; numbers only, never
      // content.
      const sttStarted = Date.now();
      const userText = isVoice
        ? await transcribeTurnAudio(
            await voiceAudioBytes(request),
            cookieValue,
          )
        : validateTurnText(await parseJsonBody(request));
      const sttMs = Date.now() - sttStarted;

      const engineStarted = Date.now();
      const { sessionId, assistantTurnId, ...outcome } = await processUserTurn(
        userText,
        cookieValue,
      );
      const engineMs = Date.now() - engineStarted;

      const stateStarted = Date.now();
      const answers = await loadAnswers(sessionId);
      const state = buildClientState(answers);
      assertNoPiiValues(state);
      const stateMs = Date.now() - stateStarted;
      logInfo("conversation_turn_received");
      logInfo("conversation_turn_route_timings", {
        mode: isVoice ? "voice" : "typed",
        sttMs,
        engineMs,
        stateMs,
        totalMs: Date.now() - routeStarted,
      });

      const headers = new Headers({ "content-type": "application/json" });
      if (outcome.fresh) {
        headers.set(
          "set-cookie",
          sessionCookieHeader(sessionId, isSecureRequest(request)),
        );
      }
      return new Response(
        JSON.stringify({
          ...outcome,
          assistantTurnId,
          state,
        }),
        { headers },
      );
    } catch (error) {
      // A fresh visitor whose reply failed already has a session with
      // saved answers (claude-review P2-3): issue the cookie on the error
      // response so a retry RESUMES it instead of orphaning the rows.
      const sessionContext = turnSessionContext(error);
      const response = conversationErrorResponse(error);
      if (sessionContext) {
        response.headers.set(
          "set-cookie",
          sessionCookieHeader(
            sessionContext.sessionId,
            isSecureRequest(request),
          ),
        );
      }
      return response;
    }
  });
}

/** The uploaded audio part of a multipart voice turn, as bytes. */
async function voiceAudioBytes(request: Request): Promise<Uint8Array> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new AppError(
      "validation_error",
      userMessageFor("validation_error"),
    );
  }
  const part = form.get("audio");
  if (!part || typeof part === "string") {
    throw new AppError(
      "validation_error",
      userMessageFor("validation_error"),
    );
  }
  return new Uint8Array(await part.arrayBuffer());
}
