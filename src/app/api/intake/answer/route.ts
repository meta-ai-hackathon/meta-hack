import { isAnswerStatus } from "../../../../lib/honesty";
import {
  AppError,
  logInfo,
  requestIdFromHeaders,
  runWithRequestId,
  userMessageFor,
} from "../../../../lib/telemetry";
import { errorResponse, parseJsonBody } from "../../../../lib/intake/api";
import {
  ensureSession,
  isSecureRequest,
  loadAnswers,
  readSessionCookie,
  saveAnswer,
  sessionCookieHeader,
  validateAnswerInput,
} from "../../../../lib/intake/store";
import {
  assertNoPiiValues,
  buildClientState,
} from "../../../../lib/intake/serialize";

// POST /api/intake/answer (BN-09): validate and persist one tri-state
// answer, then return the fresh client-visible state. The response carries
// only pii:false values — pii:true answers surface as their status alone.
// Validation runs BEFORE the session is resolved: a rejected answer (in
// particular a visitor's very first POST) must never create an orphan
// person/session row (BN-13 hygiene).

interface AnswerBody {
  questionId?: unknown;
  status?: unknown;
  value?: unknown;
}

function validationError(): AppError {
  return new AppError("validation_error", userMessageFor("validation_error"));
}

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const body = (await parseJsonBody(request)) as AnswerBody | null;
      if (!body || typeof body.questionId !== "string" || typeof body.status !== "string") {
        return errorResponse(validationError());
      }
      if (!isAnswerStatus(body.status)) {
        return errorResponse(validationError());
      }
      // Spec validation (question id, status, value shape) before any DB
      // write — throws a taxonomy validation_error, caught below.
      validateAnswerInput(body.questionId, body.status, body.value);

      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const { sessionId, fresh } = await ensureSession(cookieValue);
      await saveAnswer(sessionId, body.questionId, body.status, body.value);

      const answers = await loadAnswers(sessionId);
      const state = buildClientState(answers);
      assertNoPiiValues(state);
      logInfo("intake_answer_received");
      const headers = new Headers({ "content-type": "application/json" });
      if (fresh) {
        headers.set(
          "set-cookie",
          sessionCookieHeader(sessionId, isSecureRequest(request)),
        );
      }
      return new Response(JSON.stringify(state), { headers });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
