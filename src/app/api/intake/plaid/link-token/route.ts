import { errorResponse } from "../../../../../lib/intake/api";
import { loadSession, readSessionCookie } from "../../../../../lib/intake/store";
import { AppError, userMessageFor } from "../../../../../lib/telemetry";
import { PlaidClient } from "../../../../../lib/plaid/client";
import { sealPlaidUserId } from "../../../../../lib/plaid/user-handle";
// POST /api/intake/plaid/link-token (HACK-140): mint a Plaid Bank Income Link token for
// the Sandbox demo. Returns only the link token -- the Plaid secret stays
// server-side. Requires the existing intake session like the tax routes.
export async function POST(request: Request): Promise<Response> {
  try {
    const sessionId = await loadSession(readSessionCookie(request.headers.get("cookie")));
    if (!sessionId) throw new AppError("validation_error", "Start a session before connecting your bank.");
    const { linkToken, userId } = await new PlaidClient().createLinkToken(sessionId);
    // The user_id is sealed to THIS session; the pull route refuses a
    // handle minted for any other session (stateless, no DB row).
    return Response.json({ linkToken, pullHandle: sealPlaidUserId(sessionId, userId) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return errorResponse(new AppError("internal", userMessageFor("internal")));
  }
}
