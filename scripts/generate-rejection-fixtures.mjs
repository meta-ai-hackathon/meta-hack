// Generates the two committed REJECTION fixtures for the forms pipeline
// (VAL-PDF-004): an XFA-carrying PDF and a password-encrypted PDF. Both must
// be rejected by the parse/fill paths with clear taxonomy errors — never a
// stack trace or a partial fill.
//
//   node scripts/generate-rejection-fixtures.mjs
//
// Both fixtures are hand-crafted (correct xref offsets, computed below):
// pdf-lib deliberately strips XFA data on save, so the XFA fixture cannot be
// produced through the library itself. The XFA key hangs off the AcroForm
// dictionary the way real XFA writers do. The encrypted fixture is a minimal
// /Encrypt standard-security-handler document — no readable content is
// needed, since the pipeline rejects on detection, before any decrypt
// attempt.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.resolve(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "forms",
  "fixtures",
);

function buildPdf(objects, trailer) {
  let out = "%PDF-1.7\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n${trailer}\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function buildXfaFixture() {
  // catalog → AcroForm (Fields + XFA stream) → page. The XFA payload is
  // filler XML; detection only requires the key to be present. Stream
  // objects need a byte-accurate /Length, so object 5 is built by hand.
  const xfaXml = "<xdp><template><subform name=\"fixture\"/></template></xdp>";
  let out = "%PDF-1.7\n";
  const offsets = [];
  const heads = [
    "<< /Type /Catalog /Pages 2 0 R /AcroForm 4 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Fields [] /XFA 5 0 R >>",
  ];
  heads.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  offsets.push(out.length);
  out += `5 0 obj\n<< /Length ${xfaXml.length} >>\nstream\n${xfaXml}\nendstream\nendobj\n`;
  const xrefStart = out.length;
  out += `xref\n0 6\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out +=
    "trailer\n<< /Size 6 /Root 1 0 R " +
    "/ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>] >>\n" +
    `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

function buildEncryptedFixture() {
  // A minimal, structurally valid PDF whose trailer carries /Encrypt with
  // the standard security handler.
  return buildPdf(
    [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
      "<< /Filter /Standard /V 1 /R 2 " +
        "/O <0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20> " +
        "/U <303132333435363738393a3b3c3d3e3f303132333435363738393a3b3c3d3e3f> " +
        "/P -4 >>",
    ],
    "<< /Size 5 /Root 1 0 R /Encrypt 4 0 R " +
      "/ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>] >>",
  );
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  path.join(OUT_DIR, "sample-form-xfa.pdf"),
  buildXfaFixture(),
);
writeFileSync(
  path.join(OUT_DIR, "sample-form-encrypted.pdf"),
  buildEncryptedFixture(),
);
console.log(`wrote ${OUT_DIR}/sample-form-xfa.pdf and sample-form-encrypted.pdf`);
