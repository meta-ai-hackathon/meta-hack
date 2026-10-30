// Generates the two committed sample application forms used by the PDF
// pipeline (Mission v2 M4): an AcroForm variant and a flat (non-interactive)
// variant. Both are SYNTHETIC and pilot-agnostic — they model no real
// application, program, or jurisdiction (the pilot decision is still open,
// HACK-16). The committed form-registry entries under kb/forms/ describe
// these files; tests re-parse them and must agree with the registry.
//
// Run from the repo root after installing dependencies:
//   node scripts/generate-sample-forms.mjs
//
// The output is deterministic: same code, same bytes (fixed strings, no
// timestamps), so re-running never produces registry-puzzling churn.

import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
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

// Page geometry (US letter) and the shared layout for both variants.
const PAGE_SIZE = [612, 792];

// Each row: registry field name, its displayed label, and the input-box
// rectangle (AcroForm widget on the interactive variant; the flat variant
// draws only an underline where an answer would go — the registry records
// the same rectangle as the drawText coordinates).
const ROWS = [
  {
    name: "applicant_name",
    label: "Your full name",
    box: { x: 220, y: 640, width: 300, height: 22 },
  },
  {
    name: "applicant_date_of_birth",
    label: "Date of birth",
    box: { x: 220, y: 600, width: 150, height: 22 },
  },
  {
    name: "household_size_count",
    label: "How many people live in your household?",
    box: { x: 340, y: 560, width: 80, height: 22 },
  },
  {
    name: "housing_situation",
    label: "What is your current housing situation?",
    box: { x: 220, y: 520, width: 260, height: 22 },
  },
  {
    name: "monthly_rent_amount",
    label: "Monthly rent or housing cost",
    box: { x: 220, y: 480, width: 120, height: 22 },
  },
  {
    name: "contact_phone",
    label: "Phone number",
    box: { x: 220, y: 440, width: 180, height: 22 },
  },
  {
    name: "contact_email",
    label: "Email address",
    box: { x: 220, y: 400, width: 260, height: 22 },
  },
  {
    name: "mail_consent",
    label: "May we send mail to a shelter address?",
    box: { x: 420, y: 370, width: 14, height: 14 },
  },
  {
    name: "id_problem_explanation",
    label:
      "If you have trouble getting an ID, tell us what the problem is",
    box: { x: 220, y: 290, width: 320, height: 44 },
  },
  {
    name: "case_number",
    label: "Case number, if you already have one (optional)",
    box: { x: 220, y: 250, width: 200, height: 22 },
  },
];

const TITLE = "Sample benefits application (synthetic fixture)";
const FOOTER =
  "Generated test fixture — models no real application, program, or jurisdiction.";

async function buildAcroFormVariant() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage(PAGE_SIZE);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const small = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(TITLE, { x: 72, y: 720, font, size: 16 });
  page.drawText(FOOTER, { x: 72, y: 80, font: small, size: 8 });

  const form = pdf.getForm();
  const dropdownOptions = [
    "In a shelter",
    "In a car or vehicle",
    "Outdoors or in a place not meant for sleeping",
    "I had nowhere to sleep",
    "Staying with family or friends",
    "In a place I rent or own",
  ];
  for (const row of ROWS) {
    page.drawText(row.label, {
      x: 72,
      y: row.box.y + row.box.height + 8,
      font: small,
      size: 10,
    });
    if (row.name === "housing_situation") {
      const dropdown = form.createDropdown(row.name);
      dropdown.addOptions(dropdownOptions);
      dropdown.addToPage(page, {
        x: row.box.x,
        y: row.box.y,
        width: row.box.width,
        height: row.box.height,
      });
    } else if (row.name === "mail_consent") {
      const checkbox = form.createCheckBox(row.name);
      checkbox.addToPage(page, {
        x: row.box.x,
        y: row.box.y,
        width: row.box.width,
        height: row.box.height,
      });
    } else {
      const field = form.createTextField(row.name);
      field.addToPage(page, {
        x: row.box.x,
        y: row.box.y,
        width: row.box.width,
        height: row.box.height,
      });
    }
  }
  return pdf.save();
}

async function buildFlatVariant() {
  // Same layout, but nothing interactive: no AcroForm dictionary at all.
  // The pipeline fills it through the drawText coordinate fallback, using
  // the box rectangles recorded in the registry entry as draw positions.
  const pdf = await PDFDocument.create();
  const page = pdf.addPage(PAGE_SIZE);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(TITLE, { x: 72, y: 720, font, size: 16 });
  page.drawText(FOOTER, { x: 72, y: 80, font, size: 8 });
  for (const row of ROWS) {
    page.drawText(row.label, {
      x: 72,
      y: row.box.y + row.box.height + 8,
      font,
      size: 10,
    });
    // An answer line where the interactive variant's widget would be.
    page.drawLine({
      start: { x: row.box.x, y: row.box.y },
      end: { x: row.box.x + row.box.width, y: row.box.y },
      thickness: 0.75,
      color: rgb(0.4, 0.4, 0.4),
    });
  }
  return pdf.save();
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  path.join(OUT_DIR, "sample-form-acroform.pdf"),
  await buildAcroFormVariant(),
);
writeFileSync(
  path.join(OUT_DIR, "sample-form-flat.pdf"),
  await buildFlatVariant(),
);
console.log(`wrote ${OUT_DIR}/sample-form-acroform.pdf and sample-form-flat.pdf`);
