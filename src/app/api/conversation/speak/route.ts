import { loadTurnText } from "../../../../lib/conversation";
import {
  consentPathEnabled,
  parseConsentReceipt,
  CONSENT_HEADER,
} from "../../../../lib/consent";
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

// Per-turn audio cache (claude-review P3): a reply is deterministic for its
// turn id, so replaying the same id re-serves the same bytes instead of
// spending a second paid TTS call. Bounded and time-limited; a miss simply
// regenerates.
const SPEAK_CACHE_LIMIT = 50;
const SPEAK_CACHE_TTL_MS = 5 * 60 * 1000;
const speakCache = new Map<string, { audio: Uint8Array; cachedAt: number }>();

function cachedAudioFor(turnId: string): Uint8Array | null {
  const hit = speakCache.get(turnId);
  if (!hit) {
    return null;
  }
  if (Date.now() - hit.cachedAt > SPEAK_CACHE_TTL_MS) {
    speakCache.delete(turnId);
    return null;
  }
  return hit.audio;
}

function rememberAudio(turnId: string, audio: Uint8Array): void {
  if (speakCache.size >= SPEAK_CACHE_LIMIT) {
    const oldest = speakCache.keys().next().value;
    if (oldest !== undefined) {
      speakCache.delete(oldest);
    }
  }
  speakCache.set(turnId, { audio, cachedAt: Date.now() });
}

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
//
// CONSENT GATE (Mission v2.1 M5, HACK-81, VAL-CONSENT-003): the reply text
// goes to Gemini TTS only for a client whose receipt has the voice toggle
// on — checked BEFORE the body is read. Without it, the client's browser
// speechSynthesis (local, no send) is the path.

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      // Consent FIRST — a refused speak never reads the request at all.
      const receipt = parseConsentReceipt(
        request.headers.get(CONSENT_HEADER),
      );
      if (!consentPathEnabled("voice", receipt)) {
        throw new AppError("consent_required", userMessageFor("consent_required"));
      }
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

      const cached = cachedAudioFor(turnId);
      if (cached) {
        return new Response(new Uint8Array(cached), {
          headers: {
            "content-type": "audio/wav",
            "cache-control": "no-store",
          },
        });
      }

      const result = await speakText(replyText);
      rememberAudio(turnId, result.audio);
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
              : code === "consent_required"
                ? 403
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
