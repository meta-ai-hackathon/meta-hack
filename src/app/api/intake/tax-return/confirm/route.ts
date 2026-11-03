import { errorResponse, parseJsonBody } from "../../../../../lib/intake/api";
import {
  ensureSession,
  isSecureRequest,
  loadAnswers,
  readSessionCookie,
  sessionCookieHeader,
} from "../../../../../lib/intake/store";
import {
  parseTaxReturnConfirmations,
  saveConfirmedTaxAnswers,
} from "../../../../../lib/intake/tax-return-confirm";
import {
  assertNoPiiValues,
  buildClientState,
} from "../../../../../lib/intake/serialize";
import { requestIdFromHeaders, runWithRequestId } from "../../../../../lib/telemetry";

// POST /api/intake/tax-return/confirm (milestone income-capture part 2;
// VAL-INC-007/013): the SECOND call of the two-step flow. The upload route
// returned typed findings and persisted nothing; this call writes what the
// person actually decided, through the standard answer store:
//
// - action "confirm" — the person accepts a parsed proposal: saved with
//   provenance `tax_return` (the origin badge "From your tax return").
// - action "correct" — the person typed their own value: saved with
//   provenance `user`.
//
// Every entry is validated against the income spec questions (and ONLY
// those — the confirm path can never write a pii vault question) BEFORE
// the session is resolved, so a rejected first confirm never leaves an
// orphan row behind, and a rejected batch saves nothing. Re-confirming
// overwrites the same rows (update-not-duplicate). The response carries
// the saved ids/provenances plus the fresh client state — the person's
// confirmed income answers, and nothing else.

interface ConfirmBody {
  confirmations?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const body = (await parseJsonBody(request)) as ConfirmBody | null;
      // Validate the whole batch first: a bad entry anywhere saves nothing.
      const confirmations = parseTaxReturnConfirmations(
        body?.confirmations ?? null,
      );
      const cookieValue = readSessionCookie(request.headers.get("cookie"));
      const { sessionId, fresh } = await ensureSession(cookieValue);
      const saved = await saveConfirmedTaxAnswers(sessionId, confirmations);
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
