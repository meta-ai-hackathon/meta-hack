import { errorResponse, parseJsonBody } from "../../../../../lib/intake/api";
import { loadSession, readSessionCookie } from "../../../../../lib/intake/store";
import { AppError, userMessageFor } from "../../../../../lib/telemetry";
import { PlaidClient } from "../../../../../lib/plaid/client";
import { encryptForBrowser } from "../../../../../lib/plaid/envelope";
import { openPlaidUserId } from "../../../../../lib/plaid/user-handle";
// POST /api/intake/plaid/pull (HACK-140): the blind token broker. It
// creates no Item token here: Bank Income is fetched by Plaid user_id,
// encrypts it to the browser's ephemeral key, and deletes the Plaid user
// after the one fetch in all cases. It writes no database rows
// and logs no payload, account identifier, token, or extracted value.
// Honesty note: plaintext exists in this process's memory while Plaid is
// called -- the claim is no storage, no logs, encrypted return transit,
// discarded token; not end-to-end encryption against our own server.
// Sandbox-only by contract: plaidConfig() refuses any PLAID_ENV other than
// "sandbox" (pinned by config.test.ts). This broker must never run against
// real bank data without a recorded owner decision under HACK-92 and a
// matching person-authored rules.md change (HACK-140 production note
// 7471d535); the income-verification rule keeps that data on the device.
export async function POST(request: Request): Promise<Response> {
  try {
    const sessionId = await loadSession(readSessionCookie(request.headers.get("cookie")));
    if (!sessionId) throw new AppError("validation_error", "Start a session before connecting your bank.");
    const body = (await parseJsonBody(request)) as Record<string, unknown>;
    const pullHandle = body.pullHandle;
    const clientPublicKey = body.clientPublicKey;
    if (typeof pullHandle !== "string" || pullHandle.length < 10 || pullHandle.length > 512 ||
        typeof clientPublicKey !== "string" || clientPublicKey.length < 100 || clientPublicKey.length > 512) {
      throw new AppError("validation_error", userMessageFor("validation_error"));
    }
    const userId = openPlaidUserId(sessionId, pullHandle);
    if (!userId) throw new AppError("validation_error", userMessageFor("validation_error"));
    const { payload, removed } = await new PlaidClient().pullBankIncome(userId);
    const envelope = encryptForBrowser(clientPublicKey, JSON.stringify(payload));
    return Response.json({ envelope, removed }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return errorResponse(new AppError("internal", userMessageFor("internal")));
  }
}
