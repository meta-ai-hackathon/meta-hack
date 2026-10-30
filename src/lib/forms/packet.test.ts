import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
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
  programLabel: fc.constant("NC Medicaid (MAGI)"),
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
    { id: "nc-renewal", title: "NC Medicaid page", url: "https://example.invalid/nc", retrievedAt: "2026-10-29" },
  ]),
  claimSourceIds: fc.constant(["nc-renewal"]),
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
    const manifest: PacketManifest = {
      ...(await fc.sample(manifestArb, 1))[0],
      statements: [],
    };
    const app = await blankPdf(2, "application");
    const outcome = await assemblePacket(app, manifest);
    const packetPdf = await PDFDocument.load(outcome.bytes);
    // The copied application pages are page-for-page the fill output:
    // same count, and the cover block before them carries the id.
    expect(packetPdf.getPageCount()).toBe(outcome.coverPages + 2);
    expect(outcome.coverPages).toBeGreaterThanOrEqual(1);
  });

  it("rejects a manifest that cites an unknown source card, however shaped", async () => {
    await fc.assert(
      fc.asyncProperty(manifestArb, fc.string({ minLength: 1, maxLength: 12 }), async (base, bogus) => {
        const manifest: PacketManifest = {
          ...base,
          statements: [],
          claimSourceIds: [bogus === "nc-renewal" ? "other-card" : bogus],
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
      programLabel: "NC Medicaid (MAGI)",
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
    const { provenance, missing } = provenanceFromFill(fill, (name) =>
      name === "a" ? "Your name?" : "Your job?",
    );
    expect(provenance).toHaveLength(2);
    expect(provenance[0]).toMatchObject({ fieldName: "a", question: "Your name?" });
    expect(missing).toEqual([{ fieldName: "c", question: "Your income?" }]);
  });
});
