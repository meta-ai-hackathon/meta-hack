import { inflateSync } from "node:zlib";

// The pre-parse decompressed-size bound (milestone income-capture part 3;
// droid-review ride-along on the upload route). The wire cap
// (readBodyCapped, 32MB) bounds the RAW upload bytes, but PDF stream data
// is compressed: a small compressed PDF can decompress far past the cap
// (a flate bomb) and exhaust memory when the parser loads the document.
// This bound inflates every FlateDecode stream with a HARD output cap
// (zlib's maxOutputLength) BEFORE the parser touches the bytes, so a bomb
// is rejected by counted bytes, never by memory pressure.
//
// Server-only (node:zlib): the upload route calls this after the body cap
// and before parse1040Pdf. Streams that fail to inflate are skipped — a
// corrupt stream is not a bomb, and the parser reports unreadable inputs
// honestly on its own.

/**
 * The total decompressed budget across all of one PDF's FlateDecode
 * streams. Comfortably above any real 1040 (a few MB inflated), far below
 * a bomb's blast radius.
 */
export const MAX_DECOMPRESSED_PDF_BYTES = 128 * 1024 * 1024;

/**
 * Walk the raw PDF bytes and sum the DECOMPRESSED size of every
 * FlateDecode stream. Returns the total; a total past
 * MAX_DECOMPRESSED_PDF_BYTES means the upload must be rejected before
 * parsing. Pure: no allocation proportional to the decompressed size —
 * inflate runs with maxOutputLength = the remaining budget, so a bomb
 * throws (caught) instead of materializing.
 */
export function decompressedPdfSize(bytes: Uint8Array): number {
  const latin1 = Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).toString("latin1");
  let total = 0;
  let streamIndex = latin1.indexOf("stream");
  while (streamIndex !== -1) {
    // "endstream" also contains "stream" — skip matches inside it.
    if (
      streamIndex >= 3 &&
      latin1.slice(streamIndex - 3, streamIndex + 6) === "endstream"
    ) {
      streamIndex = latin1.indexOf("stream", streamIndex + 6);
      continue;
    }
    const dataStart = streamIndex + "stream".length;
    // Skip the EOL after the stream keyword (CRLF or LF).
    let contentStart = dataStart;
    if (latin1[contentStart] === "\r") {
      contentStart += 1;
    }
    if (latin1[contentStart] === "\n") {
      contentStart += 1;
    }
    const endRaw = latin1.indexOf("endstream", contentStart);
    if (endRaw === -1) {
      break;
    }
    let contentEnd = endRaw;
    // Trim the EOL the writer placed before endstream.
    if (latin1[contentEnd - 1] === "\n") {
      contentEnd -= 1;
      if (latin1[contentEnd - 1] === "\r") {
        contentEnd -= 1;
      }
    }
    // The dict is the last "<<" before the stream keyword; the filter name
    // must be a whole token ("/FlateDecode", possibly in an array).
    const dictStart = latin1.lastIndexOf("<<", streamIndex);
    const dict =
      dictStart === -1 ? "" : latin1.slice(dictStart, streamIndex);
    if (dict.includes("FlateDecode")) {
      const remaining = MAX_DECOMPRESSED_PDF_BYTES - total;
      if (remaining <= 0) {
        return total;
      }
      try {
        const inflated = inflateSync(
          bytes.subarray(contentStart, contentEnd),
          { maxOutputLength: remaining },
        );
        total += inflated.length;
      } catch (error) {
        // Overshoot past the remaining budget (ERR_BUFFER_TOO_LARGE): the
        // stream provably inflates beyond the bound — report the breach
        // immediately; the total never materializes.
        if (
          error instanceof RangeError &&
          (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
        ) {
          return MAX_DECOMPRESSED_PDF_BYTES + 1;
        }
        // Anything else is a corrupt stream — not a bomb. Skip it: the
        // parser sees the same bytes and reports unreadable honestly.
      }
    }
    streamIndex = latin1.indexOf("stream", endRaw + "endstream".length);
  }
  return total;
}

/** True when a parsed size is within the bound. */
export function decompressedSizeWithinBound(size: number): boolean {
  return size >= 0 && size <= MAX_DECOMPRESSED_PDF_BYTES;
}
