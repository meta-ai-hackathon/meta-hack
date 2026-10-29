import { loadTurnText } from "../../../../lib/conversation";
import {
  loadSession,
  readSessionCookie,
} from "../../../../lib/intake/store";
import {
  AppError,
  requestIdFromHeaders,
  reportError,
  runWithRequestId,
  toErrorCode,
  userMessageFor,
} from "../../../../lib/telemetry";
import { MAX_SPEAK_TEXT_LENGTH, speakText } from "../../../../lib/tts";

// POST /api/conversation/speak (Mission v2 M2): spoken assistant replies.
// The browser asks this route for audio of a reply it just displayed as a
// subtitle; the Gemini key stays server-side.
//
// Contract (claude-review P1-1/P2-1): the request carries a TURN ID, not
// free text — the route speaks only a stored, REDACTED assistant turn that
// belongs to the caller's session, and the reply text already passed the
// banned-claim and pii-echo gates before it was persisted. No arbitrary
// text ever reaches the TTS provider. On any failure the client falls back
// to browser speechSynthesis — the route never blocks the conversation.

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new AppError(
          "validation_error",
          userMessageFor("validation_error"),
        );
      }
      const turnId =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { turnId?: unknown }).turnId
          : undefined;

      // The caller's session — required: spoken replies are session data.
      const sessionId = await loadSession(
        readSessionCookie(request.headers.get("cookie")),
      );
      if (!sessionId || typeof turnId !== "string") {
        throw new AppError("not_found", userMessageFor("not_found"));
      }
      const replyText = await loadTurnText(sessionId, turnId, "assistant");
      if (replyText === null) {
        throw new AppError("not_found", userMessageFor("not_found"));
      }
      if (replyText.length > MAX_SPEAK_TEXT_LENGTH) {
        // Bounded defense: replies are short; never speak a wall of text.
        throw new AppError(
          "validation_error",
          userMessageFor("validation_error"),
        );
      }

      const result = await speakText(replyText);
      return new Response(new Uint8Array(result.audio), {
        headers: {
          "content-type": "audio/wav",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      reportError(error, { event: "conversation.speak_failed" });
      const code = toErrorCode(error);
      const status =
        code === "validation_error"
          ? 400
          : code === "not_found"
            ? 404
            : code === "rate_limited"
              ? 429
              : code === "model_unavailable"
                ? 503
                : 500;
      return Response.json(
        { error: { code, message: userMessageFor(code) } },
        { status },
      );
    }
  });
}
