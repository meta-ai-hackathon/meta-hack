import { fillForSession } from "../../../../../lib/forms/fill";
import { getFormRegistryEntry, loadTemplatePdf } from "../../../../../lib/forms/registry";
import { conversationErrorResponse } from "../../../../../lib/conversation";
import { loadSession, readSessionCookie } from "../../../../../lib/intake/store";
import {
  AppError,
  logInfo,
  requestIdFromHeaders,
  runWithRequestId,
  userMessageFor,
} from "../../../../../lib/telemetry";

// POST /api/forms/<formId>/fill (Mission v2 M4, VAL-PDF-003..005): fill the
// registered application form with the session's stored answers and return
// the filled PDF as an attachment.
//
// - The template PDF MAY arrive as the multipart `file` part (the contract
//   tests and the walkthrough submit the committed sample this way); a
//   request without one fills the registry entry's committed template (the
//   UI download path). The session's answers come from the server-side
//   stores (answer table + vault via the registry entry's per-form
//   allowlist + the form-answer store) — the client never uploads answer
//   data, so answers cannot be spoofed.
// - XFA and encrypted (and corrupt) inputs are rejected with clear taxonomy
//   errors before anything is filled (VAL-PDF-004).
// - The filled PDF exists ONLY in memory for the duration of the request:
//   no filesystem write, no database column, no log line ever sees the
//   bytes or any answer value (VAL-PDF-005). The person's own data returns
//   to them in the attachment — nothing is persisted server-side.

export async function POST(
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
        throw new AppError(
          "validation_error",
          "Start a session before preparing your application.",
        );
      }

      const uploaded = await optionalTemplateBytes(request);
      const template = uploaded ?? loadTemplatePdf(entry);
      const outcome = await fillForSession(template, entry, sessionId);
      logInfo("form_fill_route_completed", {
        filledCount: outcome.filled.length,
        toResolveCount: outcome.toResolve.length,
      });

      return new Response(Buffer.from(outcome.bytes), {
        headers: new Headers({
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${entry.id}.pdf"`,
          "cache-control": "no-store",
        }),
      });
    } catch (error) {
      return conversationErrorResponse(error);
    }
  });
}

/**
 * The OPTIONAL uploaded template part of the multipart fill request. A
 * non-multipart request (the UI download path) or a multipart request
 * without a file part yields undefined — the route falls back to the
 * registry's committed template.
 */
async function optionalTemplateBytes(
  request: Request,
): Promise<Uint8Array | undefined> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return undefined;
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new AppError(
      "validation_error",
      userMessageFor("validation_error"),
    );
  }
  const part = form.get("file");
  if (!part || typeof part === "string") {
    return undefined;
  }
  return new Uint8Array(await part.arrayBuffer());
}
