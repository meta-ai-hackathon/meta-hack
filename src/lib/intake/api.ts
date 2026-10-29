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

/**
 * Parse an OPTIONAL JSON request body: an absent or empty body means {}
 * (e.g. POST /api/session with no payload), malformed JSON is the taxonomy
 * validation_error, same as parseJsonBody.
 */
export async function optionalJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("validation_error", userMessageFor("validation_error"));
  }
}
