import { saveFormAnswer } from "../../../../../lib/forms/answers";
import { getFormRegistryEntry } from "../../../../../lib/forms/registry";
import { conversationErrorResponse } from "../../../../../lib/conversation";
import {
  ensureSession,
  isSecureRequest,
  readSessionCookie,
  sessionCookieHeader,
} from "../../../../../lib/intake/store";
import {
  AppError,
  logInfo,
  requestIdFromHeaders,
  runWithRequestId,
  userMessageFor,
} from "../../../../../lib/telemetry";
import { parseJsonBody } from "../../../../../lib/intake/api";

// POST /api/forms/<formId>/answer (Mission v2 M4): save an answer to a
// form-driven question that does NOT map to a question-spec id — the fields
// the flow asks and the registry lists. Spec-mapped questions never come
// here (the conversation pipeline owns those). Like the intake answer
// route, a fresh visitor's first form answer may create their session.

interface FormAnswerBody {
  fieldName?: unknown;
  value?: unknown;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ formId: string }> },
): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const { formId } = await params;
      const entry = getFormRegistryEntry(formId);

      const body = await parseJsonBody(request);
      const { fieldName, value } =
        typeof body === "object" && body !== null && !Array.isArray(body)
          ? (body as FormAnswerBody)
          : { fieldName: undefined, value: undefined };
      if (typeof fieldName !== "string" || typeof value !== "string") {
        throw new AppError(
          "validation_error",
          userMessageFor("validation_error"),
        );
      }

      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const { sessionId, fresh } = await ensureSession(cookieValue);
      await saveFormAnswer(sessionId, entry, fieldName, value);

      const headers = new Headers({ "content-type": "application/json" });
      if (fresh) {
        headers.set(
          "set-cookie",
          sessionCookieHeader(sessionId, isSecureRequest(request)),
        );
      }
      logInfo("form_answer_route_saved");
      return new Response(JSON.stringify({ saved: true }), { headers });
    } catch (error) {
      return conversationErrorResponse(error);
    }
  });
}
