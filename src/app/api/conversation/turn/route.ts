import {
  conversationErrorResponse,
  processUserTurn,
  transcribeTurnAudio,
  validateTurnText,
} from "../../../../lib/conversation";
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

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const contentType = request.headers.get("content-type") ?? "";
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      // Voice turns arrive as multipart audio; typed turns as JSON. Both
      // produce the turn text and share everything downstream.
      const userText = contentType.includes("multipart/form-data")
        ? await transcribeTurnAudio(
            await voiceAudioBytes(request),
            cookieValue,
          )
        : validateTurnText(await parseJsonBody(request));

      const { sessionId, fresh, ...outcome } = await processUserTurn(
        userText,
        cookieValue,
      );

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
          ...outcome,
          state,
        }),
        { headers },
      );
    } catch (error) {
      return conversationErrorResponse(error);
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
