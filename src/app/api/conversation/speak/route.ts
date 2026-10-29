import {
  MAX_SPEAK_TEXT_LENGTH,
  speakText,
} from "../../../../lib/tts";
import {
  AppError,
  requestIdFromHeaders,
  reportError,
  runWithRequestId,
  toErrorCode,
  userMessageFor,
} from "../../../../lib/telemetry";

// POST /api/conversation/speak (Mission v2 M2): spoken assistant replies.
// The browser asks this route for audio of the reply it just displayed as a
// subtitle; the Gemini key stays server-side. On any failure the client
// falls back to browser speechSynthesis — the route never blocks the
// conversation itself.

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
      const text =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as { text?: unknown }).text
          : undefined;
      if (
        typeof text !== "string" ||
        text.trim() === "" ||
        text.length > MAX_SPEAK_TEXT_LENGTH
      ) {
        throw new AppError(
          "validation_error",
          userMessageFor("validation_error"),
        );
      }

      const result = await speakText(text);
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
