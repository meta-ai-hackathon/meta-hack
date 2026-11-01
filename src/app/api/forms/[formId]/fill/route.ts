import { fillForSession, parseFormValues } from "../../../../../lib/forms/fill";
import { readBodyCapped } from "../../../../../lib/forms/upload-cap";
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
// registered application form and return the filled PDF as an attachment.
//
// - The template PDF MAY arrive as the multipart `file` part (the contract
//   tests and the walkthrough submit the committed sample this way); a
//   request without one fills the registry entry's committed template (the
//   UI download path).
// - Unmapped form-field answers MAY arrive as the multipart `answers` part
//   (a JSON object keyed by field name). They are validated against the
//   entry (unmapped names only, bounded) and live ONLY in memory for this
//   one fill — the real data rules forbid any new server-side store for
//   answers, so nothing here or anywhere else writes them down. Mapped
//   fields cannot be spoofed this way: the session's own server-side
//   stores (answer table + vault via the entry's per-form allowlist) are
//   the only sources for those.
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

      const { uploaded, formValues } = await multipartParts(request, entry);
      const template = uploaded ?? loadTemplatePdf(entry);
      const outcome = await fillForSession(template, entry, sessionId, formValues);
      logInfo("form_fill_route_completed", {
        filledCount: outcome.filled.length,
        toResolveCount: outcome.toResolve.length,
        conflictCount: outcome.conflicts.length,
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
 * The OPTIONAL multipart parts of the fill request: the uploaded template
 * (`file`) and the in-request form values (`answers`, a JSON object). A
 * non-multipart request (the UI download path without drafted answers) or
 * a multipart request without a part yields undefined for that part.
 *
 * The body is memory-capped by readBodyCapped (streamed, byte-counted)
 * BEFORE any parsing — a chunked request with no declared length is bounded
 * too — then the file part's bytes are read. An arbitrarily large
 * untrusted upload never reaches PDFDocument.load.
 */
async function multipartParts(
  request: Request,
  entry: ReturnType<typeof getFormRegistryEntry>,
): Promise<{
  uploaded: Uint8Array | undefined;
  formValues: Record<string, string> | undefined;
}> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return { uploaded: undefined, formValues: undefined };
  }
  // Read the body under the cap, then rebuild the request around the
  // bounded bytes so formData() parses a bounded body no matter how the
  // upload arrived.
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readBodyCapped(request.body);
  } catch {
    throw new AppError(
      "validation_error",
      userMessageFor("validation_error"),
    );
  }
  const replay = new Request(request.url, {
    method: "POST",
    headers: request.headers,
    body: bytes,
  });
  let form: FormData;
  try {
    form = await replay.formData();
  } catch {
    throw new AppError(
      "validation_error",
      userMessageFor("validation_error"),
    );
  }
  const filePart = form.get("file");
  const uploaded = await uploadedBytes(filePart);
  const answersPart = form.get("answers");
  if (answersPart === null) {
    return { uploaded, formValues: undefined };
  }
  if (typeof answersPart !== "string") {
    throw new AppError("validation_error", userMessageFor("validation_error"));
  }
  let parsedAnswers: unknown;
  try {
    parsedAnswers = JSON.parse(answersPart) as unknown;
  } catch {
    throw new AppError("validation_error", userMessageFor("validation_error"));
  }
  return { uploaded, formValues: parseFormValues(entry, parsedAnswers) };
}

async function uploadedBytes(
  part: FormDataEntryValue | null,
): Promise<Uint8Array | undefined> {
  if (!part || typeof part === "string") {
    return undefined;
  }
  return new Uint8Array(await part.arrayBuffer());
}
