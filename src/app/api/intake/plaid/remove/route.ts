import { errorResponse, parseJsonBody } from "../../../../../lib/intake/api";
import {
  loadSession,
  readSessionCookie,
} from "../../../../../lib/intake/store";
import { AppError, userMessageFor } from "../../../../../lib/telemetry";
import { PlaidApiError, PlaidClient } from "../../../../../lib/plaid/client";
import { openPlaidUserId } from "../../../../../lib/plaid/user-handle";

// POST /api/intake/plaid/remove (HACK-140, review P3): cleanup for the
// Link-exit path. Link can be closed after /user/create minted a Plaid user
// but before a Bank Income pull, and the pull route deletes the user itself
// after its one fetch. This route covers the case the pull never ran, so
// the card's "test connection is removed right after" copy stays true.
//
// It is idempotent for the one expected no-op: Plaid's USER_NOT_FOUND means
// the user is already gone, so that error (and only that one) still reports
// success. Any other failure is a real cleanup failure and returns an error,
// so the card never claims removal it could not confirm. It writes no
// database rows and logs no payload, user_id, token, or handle.
export async function POST(request: Request): Promise<Response> {
  try {
    const sessionId = await loadSession(
      readSessionCookie(request.headers.get("cookie")),
    );
    if (!sessionId) {
      throw new AppError(
        "validation_error",
        "Start a session before connecting your bank.",
      );
    }
    const body = ((await parseJsonBody(request)) ?? {}) as Record<
      string,
      unknown
    >;
    const pullHandle = body.pullHandle;
    if (
      typeof pullHandle !== "string" ||
      pullHandle.length < 10 ||
      pullHandle.length > 512
    ) {
      throw new AppError("validation_error", userMessageFor("validation_error"));
    }
    const userId = openPlaidUserId(sessionId, pullHandle);
    if (!userId) {
      throw new AppError("validation_error", userMessageFor("validation_error"));
    }
    try {
      await new PlaidClient().removeUser(userId);
    } catch (error) {
      if (!(error instanceof PlaidApiError) || error.code !== "USER_NOT_FOUND") {
        throw new AppError("internal", userMessageFor("internal"));
      }
    }
    return Response.json(
      { removed: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return errorResponse(new AppError("internal", userMessageFor("internal")));
  }
}
