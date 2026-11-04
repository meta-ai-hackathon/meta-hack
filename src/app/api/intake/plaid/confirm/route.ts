import { errorResponse, parseJsonBody } from "../../../../../lib/intake/api";
import {
  ensureSession,
  isSecureRequest,
  loadAnswers,
  readSessionCookie,
  sessionCookieHeader,
} from "../../../../../lib/intake/store";
import {
  parsePlaidConfirmations,
  saveConfirmedPlaidAnswers,
} from "../../../../../lib/intake/plaid-confirm";
import {
  assertNoPiiValues,
  buildClientState,
} from "../../../../../lib/intake/serialize";
import { requestIdFromHeaders, runWithRequestId } from "../../../../../lib/telemetry";

// POST /api/intake/plaid/confirm (HACK-140): the bank card's save step.
// The broker returned ciphertext and stored nothing; this call writes only
// a value the person typed or chose, through the standard answer store:
//
// A person-corrected value saves `known`/`user`. An untouched proposal is
// rejected and never written — it is Sandbox income-verification data and
// stays on the device, so synthetic figures and schedules cannot become a
// real person's answers. The bank's institution name is pii:true metadata
// sealed by the browser in the client-side encrypted store; it never
// reaches this route or the answer table.
//
// Every entry is validated against the income spec BEFORE the session is
// resolved, so a rejected batch saves nothing. Re-saving overwrites the
// same rows (update-not-duplicate). The response carries the saved
// ids/statuses/provenances plus the fresh client state — no values echo
// back in the saved list itself.

interface ConfirmBody {
  confirmations?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const body = (await parseJsonBody(request)) as ConfirmBody | null;
      // Validate the whole batch first: a bad entry anywhere saves nothing.
      const confirmations = parsePlaidConfirmations(
        body?.confirmations ?? null,
      );
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const { sessionId, fresh } = await ensureSession(cookieValue);
      const saved = await saveConfirmedPlaidAnswers(sessionId, confirmations);
      const answers = await loadAnswers(sessionId);
      const state = buildClientState(answers);
      // Defense in depth: the income questions are pii:false, so a
      // confirmed value may appear — but a pii value never may.
      assertNoPiiValues(state);
      const headers = new Headers({ "content-type": "application/json" });
      if (fresh) {
        headers.set(
          "set-cookie",
          sessionCookieHeader(sessionId, isSecureRequest(request)),
        );
      }
      return new Response(JSON.stringify({ saved, state }), { headers });
    } catch (error) {
      return errorResponse(error);
    }
  });
}
