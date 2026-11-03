import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_DECOMPRESSED_PDF_BYTES,
  decompressedPdfSize,
} from "./pdf-size-bound";

// The pre-parse decompressed-size bound (droid-review ride-along, milestone
// income-capture part 3): the 32MB raw-byte wire cap bounds the WIRE bytes,
// but a small compressed PDF can decompress far past it (a flate bomb). The
// bound inflates every FlateDecode stream with a hard output cap BEFORE the
// parser touches the document, so a bomb is rejected by byte count, never
// by memory pressure.

/** A minimal valid-PDF-shaped wrapper around one or two flate streams. */
function pdfWithFlateStream(
  deflated: Uint8Array,
  second?: Uint8Array,
): Uint8Array {
  const streamObj = (payload: Uint8Array, id: number): Uint8Array[] => {
    const head = Uint8Array.from(
      `${id} 0 obj\n<< /Filter /FlateDecode /Length ${payload.length} >>\nstream\n`,
      (ch) => ch.charCodeAt(0),
    );
    const tail = Uint8Array.from(
      "\nendstream\nendobj\n",
      (ch) => ch.charCodeAt(0),
    );
    return [head, payload, tail];
  };
  const parts = [
    Uint8Array.from("%PDF-1.7\n", (ch) => ch.charCodeAt(0)),
    ...streamObj(deflated, 1),
    ...(second ? streamObj(second, 2) : []),
    Uint8Array.from("%%EOF\n", (ch) => ch.charCodeAt(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe("decompressedPdfSize", () => {
  it("passes the real committed 1040 fixture well under the bound", () => {
    const bytes = readFileSync(
      new URL("./fixtures/f1040.pdf", import.meta.url),
    );
    const size = decompressedPdfSize(new Uint8Array(bytes));
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(MAX_DECOMPRESSED_PDF_BYTES);
  });

  it("sums the decompressed size of every FlateDecode stream", () => {
    // Two streams: the total is their sum, not one stream's size.
    const first = deflateSync(new Uint8Array(5_000).fill(7));
    const second = deflateSync(new Uint8Array(6_000).fill(9));
    const pdf = pdfWithFlateStream(first, second);
    expect(decompressedPdfSize(pdf)).toBe(11_000);
  });

  it("detects a flate bomb: tiny wire bytes, decompressed size past the bound", () => {
    // 200MB of zeros deflate to a few hundred KB — a small upload whose
    // DECOMPRESSED size blows past the bound.
    const bomb = deflateSync(new Uint8Array(200 * 1024 * 1024).fill(0));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const pdf = pdfWithFlateStream(bomb);
    expect(decompressedPdfSize(pdf)).toBeGreaterThan(
      MAX_DECOMPRESSED_PDF_BYTES,
    );
  }, 60_000);

  it("ignores streams that do not inflate (the parser reports those honestly)", () => {
    const corrupt = new Uint8Array(64).fill(9);
    const pdf = pdfWithFlateStream(corrupt);
    expect(() => decompressedPdfSize(pdf)).not.toThrow();
  });
});
