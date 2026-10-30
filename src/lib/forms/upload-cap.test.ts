import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, readBodyCapped } from "./upload-cap";

// The fill route's upload cap, unit-tested against plain streams: a full
// body under the cap round-trips; a body that would exceed the cap is
// refused after ~cap bytes are read (no unbounded buffering); a null body
// is an empty buffer. No Request/undici involvement — the route-level
// wiring is exercised by the route tests' small multipart bodies.

function chunkStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]);
        index += 1;
      } else {
        controller.close();
      }
    },
  });
}

/** A stream that would emit `totalBytes` in 1 MiB chunks if fully consumed. */
function oversizedStream(totalBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(1024 * 1024, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size));
    },
  });
}

describe("readBodyCapped (the fill route's upload cap)", () => {
  it("round-trips a body under the cap", async () => {
    const payload = new Uint8Array(5000).fill(7);
    const bytes = await readBodyCapped(chunkStream([payload]));
    expect(bytes.byteLength).toBe(5000);
    expect(bytes[4999]).toBe(7);
  });

  it("yields an empty buffer for a null body", async () => {
    expect((await readBodyCapped(null)).byteLength).toBe(0);
  });

  it("refuses a body that would exceed the cap, early", async () => {
    let enqueued = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        enqueued += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
    });
    await expect(readBodyCapped(stream)).rejects.toThrow("upload too large");
    // ~33 MiB read in 1 MiB chunks — the reader stops right after the cap.
    expect(enqueued).toBeLessThan(40);
  });

  it("accepts a body exactly at the cap", async () => {
    const stream = oversizedStream(MAX_UPLOAD_BYTES);
    const bytes = await readBodyCapped(stream);
    expect(bytes.byteLength).toBe(MAX_UPLOAD_BYTES);
  });
});
