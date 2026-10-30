import { PILOT_CONFIG } from "../../../../../lib/pilot";
import { getFormRegistryEntry } from "../../../../../lib/forms/registry";
import { buildFormFlow, FORM_SESSION_TRANSITIONS } from "../../../../../lib/forms/flow";
import { conversationErrorResponse } from "../../../../../lib/conversation";
import {
  loadAnswerRecords,
  loadAnswers,
  loadSession,
  loadSessionState,
  readSessionCookie,
} from "../../../../../lib/intake/store";
import { logInfo, requestIdFromHeaders, runWithRequestId } from "../../../../../lib/telemetry";

// GET /api/forms/<formId>/review (Mission v2 M4, BN-21/BN-23/BN-24): the
// prepared-package review surface. Returns the form-driven field view —
// every field with its provenance ("you told us" vs drafted), pre-filled /
// asked / not-applicable state, and the to-resolve list — plus the session's
// BN-25 lifecycle status, the pilot seam's official-portal links, and the
// ordered handoff steps.
//
// Pii discipline: the view structurally omits every pii-likely field's
// VALUE (status + provenance render instead) — the same boundary
// serialize.ts enforces for the intake, extended to form fields. The review
// route never creates a session; an anonymous request gets an honest empty
// payload.

export async function GET(
  request: Request,
  { params }: { params: Promise<{ formId: string }> },
): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const { formId } = await params;
      const entry = getFormRegistryEntry(formId);

      const sessionId = await loadSession(
        readSessionCookie(request.headers.get("cookie")),
      );
      if (!sessionId) {
        return Response.json({ hasSession: false });
      }

      const [answers, records] = await Promise.all([
        loadAnswers(sessionId),
        loadAnswerRecords(sessionId),
      ]);
      const provenances = Object.fromEntries(
        Object.entries(records).map(
          ([questionId, record]) => [questionId, record.provenance],
        ),
      );
      const view = buildFormFlow(entry, answers, provenances);
      const sessionState = await loadSessionState(sessionId);
      logInfo("form_review_loaded");

      return Response.json({
        hasSession: true,
        form: {
          id: entry.id,
          title: entry.title,
          version: entry.version,
          sourceUrl: entry.source.url,
          retrievedAt: entry.source.retrievedAt,
        },
        fields: view.fields,
        toResolve: view.toResolve,
        counts: view.counts,
        sessionStatus: sessionState?.status ?? "draft",
        allowedSessionTransitions: FORM_SESSION_TRANSITIONS,
        portalLinks: PILOT_CONFIG.portalLinks,
        steps: HANDOFF_STEPS,
      });
    } catch (error) {
      return conversationErrorResponse(error);
    }
  });
}

/**
 * The ordered handoff steps (BN-23/24): what the person does with the
 * prepared package, in order, with the honesty boundaries built in — the
 * app prepares and hands off; the person reviews, downloads, and submits
 * through the official portal themselves; submission is only ever reported
 * back to us, never assumed.
 */
const HANDOFF_STEPS: readonly { title: string; detail: string }[] = [
  {
    title: "Review every field",
    detail:
      "Check each answer below. Anything marked as still needed is left blank on the form.",
  },
  {
    title: "Download your application",
    detail:
      "The filled PDF is generated when you tap download, and nothing is saved on our side.",
  },
  {
    title: "Submit it yourself",
    detail:
      "Use the official portal link, or mail or drop off the printed form — the app never submits for you.",
  },
  {
    title: "Tell us what happened",
    detail:
      "After you submit, let us know so your progress here reflects reality.",
  },
];
