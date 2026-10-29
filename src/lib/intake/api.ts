import { AppError, reportError, toErrorCode, userMessageFor } from "../telemetry";

// Shared helpers for the /api/intake/* route handlers (BN-09).

/**
 * Map any thrown value to a safe HTTP response: the taxonomy code, the
 * canonical user-facing copy for that code, and nothing else — no internals,
 * no question ids, no values. Validation problems are 400, things that were
 * looked for and not found (e.g. resuming an unknown session) are 404,
 * anything unknown is a generic 500.
 */
export function errorResponse(error: unknown): Response {
  reportError(error, { event: "intake.request_failed" });
  const code = toErrorCode(error);
  const status =
    code === "validation_error" ? 400 : code === "not_found" ? 404 : 500;
  return Response.json(
    { error: { code, message: userMessageFor(code) } },
    { status },
  );
}

/** Parse a JSON request body, mapping malformed JSON to a taxonomy error. */
export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new AppError("validation_error", userMessageFor("validation_error"));
  }
}
