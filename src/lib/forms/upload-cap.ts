// Upload cap for the fill route's optional template part: the request body
// is read as a stream with a byte-counting limit BEFORE any parsing, so a
// chunked (length-less) or oversized upload can never exhaust memory —
// formData() on an unbounded body would buffer it all. Deliberately a plain
// stream reader (no Request/undici involvement) so the cap is unit-testable
// and independent of how the route builds its request.

export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;

/**
 * Read a request body stream up to MAX_UPLOAD_BYTES; anything larger throws
 * a taxonomy error without allocating the remainder. A null stream (no
 * body) yields an empty buffer.
 */
export async function readBodyCapped(
  stream: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new Error("upload too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
