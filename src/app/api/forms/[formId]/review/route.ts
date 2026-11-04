import { PILOT_CONFIG, pilotApplicationForForm } from "../../../../../lib/pilot";
import { getFormRegistryEntry } from "../../../../../lib/forms/registry";
import { buildFormFlow, FORM_SESSION_TRANSITIONS } from "../../../../../lib/forms/flow";
import { buildDispositionReport } from "../../../../../lib/forms/disposition";
import { assertNoPiiValuesInFormReview } from "../../../../../lib/forms/review-pii";
import { conversationErrorResponse } from "../../../../../lib/conversation";
import {
  loadAnswerRecords,
  loadAnswers,
  loadSession,
  loadSessionState,
  readSessionCookie,
} from "../../../../../lib/intake/store";
import { logInfo, requestIdFromHeaders, runWithRequestId } from "../../../../../lib/telemetry";

// GET /api/forms/<formId>/review (Mission v2 M4, BN-21/23/24): the
// prepared-package review surface. Returns the form-driven field view —
// every field with its provenance ("you told us" vs drafted), pre-filled /
// asked / not-applicable state, and the to-resolve list — plus the session's
// BN-25 lifecycle status, the pilot seam's official-portal links (with the
// date each was verified), and the household size the person answered, for
// the review's person scoping. The handoff's steps are NOT served here
// (HACK-119): the client renders the KB-sourced companion steps instead of
// the unsourced generic list this route used to carry.
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
      // Defense in depth before anything leaves for the client: a pii
      // value never reaches the review payload (the flow view omits it
      // structurally; this check throws loudly if that ever changes).
      // The still-needed questions serialize alongside the fields — they
      // join the needle haystack too.
      assertNoPiiValuesInFormReview(view.fields, answers, entry, [
        view.toResolve,
      ]);
      const sessionState = await loadSessionState(sessionId);
      logInfo("form_review_loaded");

      // The per-form program identity (pilot seam): the pilot's primary
      // program for its own form; the additional applications (ask-once
      // reuse) carry theirs. Forms outside the pilot's programs (the
      // sample fixtures) fall back to the pilot's identity.
      const application = pilotApplicationForForm(entry.id);

      // The household size the person answered (a plain, non-pii answer):
      // the count the review scopes the form's per-person sections
      // against (HACK-153). Unknown when the question isn't answered yet;
      // the answer arrives as a number or the number typed as text.
      const householdValue = answers.household_size?.value;
      const size =
        typeof householdValue === "number"
          ? householdValue
          : typeof householdValue === "string"
            ? Number(householdValue)
            : Number.NaN;
      const householdSize =
        answers.household_size?.status === "known" && Number.isFinite(size) && size > 0
          ? size
          : undefined;

      return Response.json({
        hasSession: true,
        form: {
          id: entry.id,
          title: entry.title,
          version: entry.version,
          sourceUrl: entry.source.url,
          retrievedAt: entry.source.retrievedAt,
        },
        householdSize,
        programName: application?.programName ?? PILOT_CONFIG.programName,
        countyName: PILOT_CONFIG.countyName,
        fields: view.fields,
        toResolve: view.toResolve,
        counts: view.counts,
        // The full-form disposition report (VAL-FIX-007): every field on
        // the template, mapped or carrying its reviewed blank-reason, so
        // nothing is silently unmapped. Registry data only — field names,
        // printed labels' questions, and dispositions; no person values.
        coverage: buildDispositionReport(entry),
        sessionStatus: sessionState?.status ?? "draft",
        allowedSessionTransitions: FORM_SESSION_TRANSITIONS,
        portalLinks: application?.portalLinks ?? PILOT_CONFIG.portalLinks,
      });
    } catch (error) {
      return conversationErrorResponse(error);
    }
  });
}
