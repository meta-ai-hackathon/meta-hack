import { readBodyCapped } from "../../../../lib/forms/upload-cap";
import {
  MAX_DECOMPRESSED_PDF_BYTES,
  decompressedPdfSize,
} from "../../../../lib/income/pdf-size-bound";
import {
  parse1040Pdf,
  PdfEnvironmentError,
} from "../../../../lib/income/tax-parse";
import { errorResponse } from "../../../../lib/intake/api";
import {
  loadSession,
  readSessionCookie,
} from "../../../../lib/intake/store";
import {
  AppError,
  logInfo,
  requestIdFromHeaders,
  runWithRequestId,
  userMessageFor,
} from "../../../../lib/telemetry";

// POST /api/intake/tax-return (milestone income-capture part 2; VAL-INC-006
// /007/008/013): parse an uploaded IRS 1040 PDF deterministically, in
// memory, and return typed findings for the person to review.
//
// - The document is NEVER persisted, logged, or echoed anywhere: the bytes
//   live in memory for the duration of this request only, the parser is a
//   pure function of those bytes (LLM-free by construction — the
//   tax-parse import-boundary test), and the response to the person
//   carries the typed findings plus nothing else. No storage row, no
//   storage object, no log line ever sees a value or a raw byte, and the
//   path makes zero outbound network calls (sentinel-proven in
//   route.test.ts).
// - Nothing saves until the person confirms: this route writes no answer
//   rows at all. The confirm call
//   (POST /api/intake/tax-return/confirm, or the stage UI in part 3)
//   writes the confirmed values through the standard answer store.
// - An unreadable input (scanned/flat, not a 1040, not a PDF, encrypted)
//   gets an honest fallback message pointing at the manual typing path —
//   nothing saved, nothing fabricated.
// - The request body is capped by readBodyCapped BEFORE any parsing, so
//   an oversized (or chunked, length-less) upload throws a taxonomy error
//   without ever reaching PDFDocument.load (VAL-INC-008).

/**
 * The honest fallback for anything the parser cannot read as a Form 1040.
 * One message covers every unreadable shape (scanned, flat, encrypted,
 * not a 1040, not a PDF) without fabricating a diagnosis; it points at
 * the manual typing path, which is always available.
 */
const UNREADABLE_MESSAGE =
  "We couldn't read a tax return from that file, so nothing was saved. " +
  "No problem — you can type your income instead. A rough idea is okay.";

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, async () => {
    try {
      const sessionId = await loadSession(
        readSessionCookie(request.headers.get("cookie")),
      );
      if (!sessionId) {
        throw new AppError(
          "validation_error",
          "Start a session before uploading your tax return.",
        );
      }
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.includes("multipart/form-data")) {
        throw new AppError(
          "validation_error",
          userMessageFor("validation_error"),
        );
      }
      const file = await multipartFile(request);
      // The decompressed-size bound (milestone part 3 ride-along): the
      // wire cap bounds RAW bytes, but a small compressed PDF can
      // decompress far past it (a flate bomb). Every FlateDecode stream
      // is inflate-probed with a hard output cap BEFORE the parser loads
      // the document — a bomb is rejected by counted bytes, never by
      // memory pressure.
      const decompressed = decompressedPdfSize(file);
      if (decompressed > MAX_DECOMPRESSED_PDF_BYTES) {
        throw new AppError(
          "validation_error",
          "That file is too large to read. You can type your income instead — a rough idea is okay.",
        );
      }
      const parsed = await parse1040Pdf(file);
      // Counts only: no field name, value, or byte ever enters the log.
      logInfo("tax_return_upload_completed", {
        readable: parsed.readable,
        findingCount: parsed.findings.length,
      });
      return Response.json({
        readable: parsed.readable,
        findings: parsed.findings,
        // A PRIOR-YEAR AGI proposal: the person confirms or corrects it
        // (provenance tax_return / user on the confirm path) — never a
        // computed claim about their current monthly income. Null when
        // no usable AGI was found (never a confident 0).
        monthlyDerived: parsed.monthlyDerived,
        message: parsed.readable ? null : UNREADABLE_MESSAGE,
      });
    } catch (error) {
      if (error instanceof PdfEnvironmentError) {
        // The PDF engine itself failed to load (module or worker chunk):
        // bundler/runtime breakage, never a statement about the upload.
        // Surface the distinct internal taxonomy error — the honest-
        // unreadable fallback above is reserved for genuine content
        // verdicts and must never cover engine breakage.
        return errorResponse(
          new AppError("internal", userMessageFor("internal"), {
            cause: error,
          }),
        );
      }
      return errorResponse(error);
    }
  });
}

/**
 * The uploaded document's bytes, extracted from the `file` part. The body
 * is memory-capped by readBodyCapped (streamed, byte-counted) BEFORE any
 * parsing — a chunked request with no declared length is bounded too —
 * then the bounded bytes are rebuilt into a request for formData(). An
 * arbitrarily large untrusted upload never reaches PDFDocument.load.
 */
async function multipartFile(request: Request): Promise<Uint8Array> {
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
  const part = form.get("file");
  if (!part || typeof part === "string") {
    throw new AppError(
      "validation_error",
      userMessageFor("validation_error"),
    );
  }
  return new Uint8Array(await part.arrayBuffer());
}
