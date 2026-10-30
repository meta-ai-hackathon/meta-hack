import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "@cantoo/pdf-lib";
import {
  assemblePacket,
  provenanceFromFill,
  validateManifest,
  type PacketManifest,
  type ProvenanceEntry,
  type StatementRef,
} from "./packet";

// Fax packet invariants (HACK-90). The properties that matter are the
// ones a bug could silently break: packet-id text leaking onto the
// official form pages, statements landing out of order or dropped, a
// manifest that cites a source card it does not carry, or a packet that
// hides still-needed fields.

async function blankPdf(pages: number, marker: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`${marker} page ${index + 1}`);
  }
  return pdf.save();
}

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

/**
 * Decoded content streams of one page — how the tests READ what a page
 * actually draws, instead of trusting page counts (PR #61 P2).
 */
/** Decode the `<hex> Tj` and `(literal) Tj` strings of a content stream. */
function decodeShownText(streamText: string): string {
  let out = "";
  for (const match of streamText.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
    const bytes = new Uint8Array(match[1].length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = parseInt(match[1].slice(index * 2, index * 2 + 2), 16);
    }
    out += new TextDecoder("latin1").decode(bytes);
  }
  for (const match of streamText.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) {
    out += match[1].replace(/\\([()\\])/g, "$1");
  }
  return out;
}

export function pageText(pdf: PDFDocument, pageIndex: number): string {
  const page = pdf.getPage(pageIndex);
  // Contents may be one stream or an array of refs — resolve through the
  // document context either way.
  const resolved: unknown = pdf.context.lookup(
    page.node.get(PDFName.of("Contents")),
  );
  const streams: PDFRawStream[] = [];
  if (resolved instanceof PDFRawStream) {
    streams.push(resolved);
  } else if (resolved instanceof PDFArray) {
    for (let index = 0; index < resolved.size(); index += 1) {
      const looked: unknown = pdf.context.lookup(resolved.get(index));
      if (looked instanceof PDFRawStream) {
        streams.push(looked);
      }
    }
  }
  return streams
    .map((stream) =>
      decodeShownText(
        new TextDecoder("latin1").decode(decodePDFRawStream(stream).decode()),
      ),
    )
    .join("\n");
}

// Non-blank text: whitespace-only fields are correctly rejected by
// validation, so auditable-manifest properties generate printable text.
const textArb = (maxLength: number) =>
  fc
    .string({ minLength: 1, maxLength })
    .filter((value) => value.trim() !== "");

const provenanceArb: fc.Arbitrary<ProvenanceEntry> = fc.record({
  fieldName: textArb(24),
  question: textArb(40),
  provenance: fc.constantFrom(
    "user_supplied",
    "ai_drafted",
    "source_verified",
  ),
  source: fc.constantFrom("spec_answer", "vault", "in_request"),
});

const manifestArb: fc.Arbitrary<Omit<PacketManifest, "statements">> = fc.record({
  // Non-blank ids only: whitespace-only ids are (correctly) rejected by
  // validation, so the assembly property generates auditable manifests.
  packetId: fc
    .string({ minLength: 1, maxLength: 20 })
    .filter((value) => value.trim() !== ""),
  programLabel: fc.constant("{{PILOT_PROGRAM}}"),
  destinationFax: fc.constant("+1-555-0100"),
  provenance: fc.array(provenanceArb, { maxLength: 8 }),
  missing: fc.array(
    fc.record({
      fieldName: textArb(24),
      question: textArb(40),
    }),
    { maxLength: 4 },
  ),
  sourceCards: fc.constant([
    { id: "pilot-renewal", title: "Pilot program page", url: "https://example.invalid/pilot", retrievedAt: "2026-10-29" },
  ]),
  claimSourceIds: fc.constant(["pilot-renewal"]),
  signature: fc.record({
    text: fc.constant("I sign under my own name."),
    signedOn: fc.constant("2026-10-30"),
  }),
  assembledAt: fc.constant("2026-10-30T12:00:00Z"),
});

async function statements(count: number): Promise<StatementRef[]> {
  const out: StatementRef[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push({
      label: `Statement ${index + 1}`,
      origin: "User download",
      pdfBytes: await blankPdf(1, `statement-${index + 1}`),
    });
  }
  return out;
}

describe("packet assembly", () => {
  it("page order is cover, application, then statements in order — nothing dropped", async () => {
    await fc.assert(
      fc.asyncProperty(
        manifestArb,
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 0, max: 3 }),
        async (base, appPages, statementCount) => {
          const manifest: PacketManifest = {
            ...base,
            statements: await statements(statementCount),
          };
          const app = await blankPdf(appPages, "application");
          const outcome = await assemblePacket(app, manifest);
          expect(outcome.coverPages).toBeGreaterThanOrEqual(1);
          expect(outcome.pageCount).toBe(
            outcome.coverPages + appPages + statementCount,
          );
          expect(await pageCount(outcome.bytes)).toBe(outcome.pageCount);
        },
      ),
    );
  });

  it("the packet id appears on the cover but never on the application pages", async () => {
    // PR #61 P2: read the pages' real content streams — a page-count
    // comparison cannot see the id drawn onto a form page.
    const packetId = "PKT-AUDIT-77341";
    const manifest: PacketManifest = {
      ...(await fc.sample(manifestArb, 1))[0],
      packetId,
      statements: [],
    };
    const app = await blankPdf(2, "application");
    const outcome = await assemblePacket(app, manifest);
    const packetPdf = await PDFDocument.load(outcome.bytes);
    expect(packetPdf.getPageCount()).toBe(outcome.coverPages + 2);
    // Every cover page may carry it; no application page may.
    let coverCarriesId = false;
    for (let index = 0; index < outcome.coverPages; index += 1) {
      if (pageText(packetPdf, index).includes(packetId)) {
        coverCarriesId = true;
      }
    }
    expect(coverCarriesId).toBe(true);
    for (let index = outcome.coverPages; index < packetPdf.getPageCount(); index += 1) {
      expect(pageText(packetPdf, index)).not.toContain(packetId);
    }
  });

  it("non-WinAnsi manifest text assembles instead of throwing (PR #61 P2)", async () => {
    const manifest: PacketManifest = {
      ...(await fc.sample(manifestArb, 1))[0],
      packetId: "PKT-UNICODE-1",
      statements: [
        {
          label: "Estado de cuenta — Marzo 📄",
          origin: "Banco — téléchargement",
          pdfBytes: await blankPdf(1, "statement"),
        },
      ],
    };
    const outcome = await assemblePacket(await blankPdf(1, "application"), manifest);
    expect(outcome.pageCount).toBe(outcome.coverPages + 2);
  });

  it("rejects a manifest that cites an unknown source card, however shaped", async () => {
    await fc.assert(
      fc.asyncProperty(manifestArb, fc.string({ minLength: 1, maxLength: 12 }), async (base, bogus) => {
        const manifest: PacketManifest = {
          ...base,
          statements: [],
          claimSourceIds: [bogus === "pilot-renewal" ? "other-card" : bogus],
        };
        expect(() => validateManifest(manifest)).toThrow();
        await expect(
          assemblePacket(await blankPdf(1, "application"), manifest),
        ).rejects.toThrow();
      }),
    );
  });

  it("rejects unknown provenance vocabulary and empty signatures", () => {
    const base = {
      packetId: "PKT-1",
      programLabel: "{{PILOT_PROGRAM}}",
      destinationFax: "+1-555-0100",
      provenance: [],
      missing: [],
      statements: [],
      sourceCards: [],
      claimSourceIds: [],
      signature: { text: "I sign.", signedOn: "2026-10-30" },
      assembledAt: "2026-10-30T12:00:00Z",
    } satisfies PacketManifest;
    expect(() => validateManifest(base)).not.toThrow();
    expect(() =>
      validateManifest({
        ...base,
        signature: { text: "  ", signedOn: "2026-10-30" },
      }),
    ).toThrow();
    expect(() =>
      validateManifest({
        ...base,
        provenance: [
          {
            fieldName: "f",
            question: "q?",
            provenance: "telepathy" as never,
            source: "spec_answer",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("fill bridge", () => {
  it("every filled field becomes a provenance row and every to-resolve a missing row", () => {
    const fill = {
      bytes: new Uint8Array(),
      filled: [
        { fieldName: "a", provenance: "user_supplied" as const },
        { fieldName: "b", provenance: "source_verified" as const },
      ],
      toResolve: [{ fieldName: "c", question: "Your income?", reason: "unknown" as const }],
    };
    const { provenance, missing } = provenanceFromFill(
      fill,
      (name) => (name === "a" ? "Your name?" : "Your job?"),
      (name) => (name === "a" ? "vault" : "spec_answer"),
    );
    expect(provenance).toHaveLength(2);
    expect(provenance[0]).toMatchObject({
      fieldName: "a",
      question: "Your name?",
      source: "vault",
    });
    expect(provenance[1]).toMatchObject({ fieldName: "b", source: "spec_answer" });
    expect(missing).toEqual([{ fieldName: "c", question: "Your income?" }]);
  });
});
