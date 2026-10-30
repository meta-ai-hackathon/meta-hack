import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { AppError, logInfo } from "../telemetry";
import type { FillOutcome } from "./fill";

// Auditable fax packet assembly (HACK-90, under HACK-75): turns the filled,
// user-reviewed application PDF into the complete packet a fax carries —
// cover sheet first, then the application, then the supporting statements
// the user pulled. Nothing here is persisted: the packet exists only as
// bytes in memory (client-side or in the one request), exactly like the
// filled PDF itself (VAL-PDF-005). Transmission is HACK-88; the vendor
// contract is HACK-89. This module never dials, never stores, never logs a
// value.
//
// Audit discipline (BN-27 extended to the packet):
// - Provenance rides along per filled field: who supplied each value
//   (user_supplied / ai_drafted / source_verified) and where it came from
//   (spec answer, vault, or in-request), rendered on the provenance page
//   so a caseworker — or a reviewer — can trace every entry on the form.
// - Source cards cite where program facts came from (title, URL,
//   retrieval date). A claim without a resolvable source card is refused.
// - Still-needed fields are listed, never hidden: an incomplete packet
//   reads as incomplete.
// - A packet id, when the caller uses one, is printed ONLY on the cover
//   sheet. The official form pages are copied byte-for-byte from the fill
//   output; nothing is ever drawn onto them here.
//
// Signing: the application is signed by the user under their own name —
// the packet records the attestation text and the date the user signed,
// on the cover sheet. The app never signs, submits, or represents the
// user (BN-25): assembling a packet sets no lifecycle state.

/** Where a filled value came from, mirroring the fill module's vocabulary. */
export type PacketValueSource = "spec_answer" | "vault" | "in_request";

export type PacketProvenance =
  | "user_supplied"
  | "ai_drafted"
  | "source_verified";

/** One filled field's audit line: field, who supplied it, from where. */
export interface ProvenanceEntry {
  readonly fieldName: string;
  /** The plain-language question the field answers, as printed on the manifest. */
  readonly question: string;
  readonly provenance: PacketProvenance;
  readonly source: PacketValueSource;
}

/** A field the form still needs — listed on the cover, never hidden. */
export interface MissingEntry {
  readonly fieldName: string;
  readonly question: string;
}

/** One supporting statement the user pulled (bank, Stripe, employer). */
export interface StatementRef {
  /** Plain label, e.g. "Bank statement — March 2026". */
  readonly label: string;
  /** Where the user pulled it from, e.g. "First Bank (user download)". */
  readonly origin: string;
  /** The statement's own bytes, appended after the application. */
  readonly pdfBytes: Uint8Array;
}

/** A source card: the cited origin of a program fact used in the packet. */
export interface SourceCard {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  /** ISO date the source was retrieved, as recorded when it was checked. */
  readonly retrievedAt: string;
}

/** The user's own signing attestation, recorded verbatim on the cover. */
export interface SignatureAttestation {
  /** The exact attestation text the user affirmed. */
  readonly text: string;
  /** ISO date the user signed under their own name. */
  readonly signedOn: string;
}

/** Everything one packet carries. Assembled by the caller; never stored. */
export interface PacketManifest {
  /** Printed ONLY on the cover sheet, e.g. "PKT-2026-0001". */
  readonly packetId: string;
  /** Program + jurisdiction, e.g. "NC Medicaid (MAGI)". */
  readonly programLabel: string;
  /** Destination fax number as the user confirmed it (test destinations for rehearsal). */
  readonly destinationFax: string;
  readonly provenance: readonly ProvenanceEntry[];
  readonly missing: readonly MissingEntry[];
  readonly statements: readonly StatementRef[];
  readonly sourceCards: readonly SourceCard[];
  /** Source-card ids each program claim in the cover cites. */
  readonly claimSourceIds: readonly string[];
  readonly signature: SignatureAttestation;
  /** ISO timestamp of assembly, printed on the cover for the audit trail. */
  readonly assembledAt: string;
}

export interface PacketOutcome {
  /** The complete packet: cover page(s) + application + statements. */
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  /** Pages before the application: the cover/provenance block. */
  readonly coverPages: number;
}

function packetError(detail: string): AppError {
  return new AppError("internal", "The fax packet could not be assembled.", {
    cause: { detail },
  });
}

const PROVENANCE_KINDS: readonly string[] = [
  "user_supplied",
  "ai_drafted",
  "source_verified",
];
const SOURCE_KINDS: readonly string[] = ["spec_answer", "vault", "in_request"];

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw packetError(`manifest field ${field} is empty`);
  }
}

/**
 * Fail-closed manifest validation. A packet that cannot be audited must
 * not be assembled: every cited source must resolve, every provenance
 * row must use the known vocabularies, and the signature attestation
 * must be the user's own recorded text.
 */
export function validateManifest(manifest: PacketManifest): void {
  requireText(manifest.packetId, "packetId");
  requireText(manifest.programLabel, "programLabel");
  requireText(manifest.destinationFax, "destinationFax");
  requireText(manifest.signature.text, "signature.text");
  requireText(manifest.signature.signedOn, "signature.signedOn");
  requireText(manifest.assembledAt, "assembledAt");

  const cardIds = new Set<string>();
  for (const card of manifest.sourceCards) {
    requireText(card.id, "sourceCard.id");
    requireText(card.title, "sourceCard.title");
    requireText(card.url, "sourceCard.url");
    requireText(card.retrievedAt, "sourceCard.retrievedAt");
    if (cardIds.has(card.id)) {
      throw packetError(`duplicate source card id: ${card.id}`);
    }
    cardIds.add(card.id);
  }
  for (const claimId of manifest.claimSourceIds) {
    if (!cardIds.has(claimId)) {
      throw packetError(`claim cites unknown source card: ${claimId}`);
    }
  }
  for (const entry of manifest.provenance) {
    requireText(entry.fieldName, "provenance.fieldName");
    requireText(entry.question, "provenance.question");
    if (!PROVENANCE_KINDS.includes(entry.provenance)) {
      throw packetError(`unknown provenance: ${String(entry.provenance)}`);
    }
    if (!SOURCE_KINDS.includes(entry.source)) {
      throw packetError(`unknown value source: ${String(entry.source)}`);
    }
  }
  for (const item of manifest.missing) {
    requireText(item.fieldName, "missing.fieldName");
    requireText(item.question, "missing.question");
  }
  manifest.statements.forEach((statement, index) => {
    requireText(statement.label, "statement.label");
    requireText(statement.origin, "statement.origin");
    if (statement.pdfBytes.length === 0) {
      // Index, never the label: labels can be user-entered text and error
      // details may reach telemetry (PR #61 P3).
      throw packetError(`statement ${index} has no bytes`);
    }
  });
}

// ---------------------------------------------------------------------------
// Cover-sheet rendering. One flowing document: cover lines, then the
// per-field provenance table, then the source-card appendix. Text is
// WinAnsi-safe (StandardFonts), long lines wrap, and the block paginates.
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 612; // US Letter
const PAGE_HEIGHT = 792;
const MARGIN = 56;
const LINE_HEIGHT = 15;
const BODY_SIZE = 10.5;
const MAX_LINE_CHARS = 92;

/**
 * Cover text is drawn with a WinAnsi standard font (no fontkit in the
 * fork), so non-WinAnsi characters would throw mid-assembly (PR #61
 * P2). Replace each such character with '?' — the packet still
 * assembles, and the substitution is visible rather than silent data
 * loss. Mirrors the fill module's WinAnsi discipline.
 */
function toWinAnsi(text: string): string {
  return text.replace(/[^\x20-\x7E\xA0-\xFF\t\n\r]/g, "?");
}

function wrapLine(line: string): string[] {
  if (line.length <= MAX_LINE_CHARS) {
    return [line];
  }
  const words = line.split(" ");
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    if (current !== "" && current.length + 1 + word.length > MAX_LINE_CHARS) {
      out.push(current);
      current = word;
    } else {
      current = current === "" ? word : `${current} ${word}`;
    }
  }
  if (current !== "") {
    out.push(current);
  }
  return out;
}

function coverLines(manifest: PacketManifest): string[] {
  const lines: string[] = [
    "FAX COVER SHEET — BENEFITS APPLICATION PACKET",
    "",
    `Program: ${manifest.programLabel}`,
    `Packet ID (cover sheet only): ${manifest.packetId}`,
    `To (fax): ${manifest.destinationFax}`,
    `Assembled: ${manifest.assembledAt}`,
    "",
    "This packet contains, in order: this cover sheet, the application",
    "signed by the applicant, the supporting statements",
    "listed below, and a provenance summary so every entry on the form",
    "can be traced to its source.",
    "",
    "SIGNATURE",
    `Attestation affirmed by the applicant: "${manifest.signature.text}"`,
    `Signed by the applicant under their own name on ${manifest.signature.signedOn}.`,
    "The preparer did not sign on the applicant's behalf and is not the",
    "applicant's authorized representative.",
    "",
    `PROVENANCE — ${manifest.provenance.length} filled field(s)`,
  ];
  for (const entry of manifest.provenance) {
    lines.push(
      `- ${entry.fieldName} — ${entry.question} [${entry.provenance} via ${entry.source}]`,
    );
  }
  lines.push("", `STILL NEEDED — ${manifest.missing.length} field(s)`);
  if (manifest.missing.length === 0) {
    lines.push("- None. Every field on the form has an answer.");
  }
  for (const item of manifest.missing) {
    lines.push(`- ${item.fieldName} — ${item.question}`);
  }
  lines.push("", `SUPPORTING STATEMENTS — ${manifest.statements.length}`);
  if (manifest.statements.length === 0) {
    lines.push("- None attached.");
  }
  for (const statement of manifest.statements) {
    lines.push(`- ${statement.label} (${statement.origin})`);
  }
  lines.push("", "SOURCE CARDS");
  for (const card of manifest.sourceCards) {
    lines.push(`- [${card.id}] ${card.title} — ${card.url} (retrieved ${card.retrievedAt})`);
  }
  if (manifest.claimSourceIds.length > 0) {
    lines.push(`Claims in this packet cite: ${manifest.claimSourceIds.join(", ")}`);
  }
  lines.push(
    "",
    "Prepared with the applicant's knowledge and consent. Please route",
    "any questions to the applicant at the contact information on the",
    "application itself.",
  );
  return lines.map(toWinAnsi).flatMap(wrapLine);
}

/**
 * Assemble the auditable packet: cover/provenance pages first, then the
 * filled application pages copied unchanged, then each statement's pages
 * in manifest order. Bytes in, bytes out — nothing is written anywhere.
 */
export async function assemblePacket(
  applicationBytes: Uint8Array,
  manifest: PacketManifest,
): Promise<PacketOutcome> {
  validateManifest(manifest);

  const packet = await PDFDocument.create();
  const font = await packet.embedFont(StandardFonts.Helvetica);
  const lines = coverLines(manifest);
  const linesPerPage = Math.floor((PAGE_HEIGHT - 2 * MARGIN) / LINE_HEIGHT);
  let coverPages = 0;
  for (let start = 0; start < lines.length; start += linesPerPage) {
    const page = packet.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;
    for (const line of lines.slice(start, start + linesPerPage)) {
      page.drawText(line, { x: MARGIN, y, font, size: BODY_SIZE });
      y -= LINE_HEIGHT;
    }
    coverPages += 1;
  }

  const application = await PDFDocument.load(applicationBytes);
  const copied = await packet.copyPages(
    application,
    application.getPageIndices(),
  );
  for (const page of copied) {
    packet.addPage(page);
  }

  for (const statement of manifest.statements) {
    const statementPdf = await PDFDocument.load(statement.pdfBytes);
    const pages = await packet.copyPages(
      statementPdf,
      statementPdf.getPageIndices(),
    );
    for (const page of pages) {
      packet.addPage(page);
    }
  }

  logInfo("fax_packet_assembled", {
    coverPages,
    provenanceCount: manifest.provenance.length,
    missingCount: manifest.missing.length,
    statementCount: manifest.statements.length,
    pageCount: packet.getPageCount(),
  });
  return {
    bytes: await packet.save(),
    pageCount: packet.getPageCount(),
    coverPages,
  };
}

/**
 * Bridge from the fill pipeline: the manifest rows a fill outcome already
 * knows. Both lookups are REQUIRED inputs (PR #61 P2): the cover is an
 * audit document, so a value's source is never defaulted — a vault or
 * in-request value mislabeled 'spec_answer' would mislead a caseworker.
 * `questionFor` resolves the plain-language question per field (the
 * registry owns that text); values themselves never enter the manifest —
 * provenance only.
 */
export function provenanceFromFill(
  fill: FillOutcome,
  questionFor: (fieldName: string) => string,
  sourceFor: (fieldName: string) => PacketValueSource,
): { provenance: ProvenanceEntry[]; missing: MissingEntry[] } {
  const provenance: ProvenanceEntry[] = fill.filled.map((field) => ({
    fieldName: field.fieldName,
    question: questionFor(field.fieldName),
    provenance: field.provenance,
    source: sourceFor(field.fieldName),
  }));
  const missing: MissingEntry[] = fill.toResolve.map((item) => ({
    fieldName: item.fieldName,
    question: item.question,
  }));
  return { provenance, missing };
}
