import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { assertLoadablePdf, discoverAcroFormFields, extractFieldLabels } from "./parse";
import { fillFormPdf, type FillValue } from "./fill";
import { getFormRegistryEntry } from "./registry";
import type { FormFieldDisposition, FormRegistryEntry, FormRegistryField } from "./registry";
import { buildFormFlow } from "./flow";
import { QUESTION_BY_ID } from "../intake/spec";
import { setLogSink } from "../telemetry";

// The REAL pilot form (Mission v2.1 M6, VAL-PILOTREAL-002): the committed
// DHB-5200 bytes parse honestly — AcroForm discovery first; the registry
// entry records what the form actually is, never a fabricated field name,
// and every registry field is re-verified against the live parse of the
// committed bytes. Label evidence for each mapping is checked against the
// text actually printed on the field's page (the pipeline's own extractor).

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const REAL_FORM_PATH = path.join(FIXTURES, "dhb-5200-ia-9-2020.pdf");
const realBytes = () => new Uint8Array(readFileSync(REAL_FORM_PATH));

const entry = () => getFormRegistryEntry("dhb-5200");

/** Every registry disposition (the mapped/unmapped vocabulary of VAL-FIX-007). */
const DISPOSITIONS: readonly FormFieldDisposition[] = [
  "mapped",
  "not_collected_by_interview",
  "optional_unanswered",
  "agency_use_only",
  "duplicate_structural",
];

function fillValueFor(display: string): FillValue {
  return { display, provenance: "user_supplied", source: "in_request" };
}

/**
 * The state answer's option LABEL — the display the fill renders into the
 * home-address state line (displayValueFor maps option values to labels).
 * Derived from the spec, not spelled out here: this file sits inside
 * src/lib/forms where the pilot-name scan runs (only official_source
 * registry entries may carry jurisdiction names).
 */
const STATE_OPTION_LABEL = QUESTION_BY_ID.state.options!.find(
  (option) => option.value === "NC",
)!.label;

beforeAll(() => {
  setLogSink(() => undefined);
});

describe("the real DHB-5200 form fixture", () => {
  it("loads without encryption or XFA (honest acroform classification)", async () => {
    const pdf = await assertLoadablePdf(realBytes());
    expect(pdf.isEncrypted).toBe(false);
    // The registry entry's declared kind matches what the bytes actually are.
    expect(entry().kind).toBe("acroform");
  });

  it("is a 21-page AcroForm with 614 widget-level discovered fields", async () => {
    const pdf = await assertLoadablePdf(realBytes());
    expect(pdf.getPageCount()).toBe(21);
    // 614 widget rectangles across the form's 571 named fields — the
    // discovery pass walks widgets, so multi-widget fields count per widget.
    // (pypdf's page-annotation walk sees 615/572: it also sees the form's
    // print pushbutton, which is not fillable — docs/dhb5200-field-inventory.md
    // reconciles the two views.)
    const fields = discoverAcroFormFields(pdf);
    expect(fields.length).toBe(614);
  });

  it("carries the official source URL, retrieval date, and origin", () => {
    const registry = entry();
    expect(registry.source.url).toBe(
      "https://policies.ncdhhs.gov/wp-content/uploads/dhb-5200-ia-9-2020.pdf",
    );
    expect(registry.source.retrievedAt).toBe("2026-10-30");
    expect(registry.source.origin).toBe("official_source");
    expect(registry.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("registers only field names that exist in the real PDF (never fabricated)", async () => {
    const pdf = await assertLoadablePdf(realBytes());
    const discovered = new Set(
      discoverAcroFormFields(pdf).map((field) => field.name),
    );
    const registry = entry();
    expect(registry.fields.length).toBeGreaterThanOrEqual(6);
    for (const field of registry.fields) {
      expect(
        discovered.has(field.name),
        `registry field ${JSON.stringify(field.name)} does not exist in the PDF`,
      ).toBe(true);
    }
  });

  it("has on-page label evidence for every registry field", async () => {
    const pdf = await assertLoadablePdf(realBytes());
    const discovered = discoverAcroFormFields(pdf);
    // The pipeline's own proximity extractor runs on the real form and
    // returns label text for every registry field.
    const extracted = await extractFieldLabels(realBytes(), discovered);
    const pageTexts = new Map<number, string>();
    for (const field of discovered) {
      if (!pageTexts.has(field.page)) {
        pageTexts.set(field.page, normalize(await extractPageText(realBytes(), field.page)));
      }
    }
    for (const field of entry().fields) {
      const evidence = pageTexts.get(field.pages[0]);
      expect(evidence, `no text extracted for page ${field.pages[0]}`).toBeTruthy();
      expect(
        evidence,
        `label ${JSON.stringify(field.label)} not found on page ${field.pages[0]}`,
      ).toContain(normalize(field.label));
      // The pipeline's own extraction finds label text on the field's page
      // too (it falls back to the raw name only when nothing is nearby).
      expect(extracted[field.name]?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  // HACK-116 decision 3 (owner, 2026-10-31): a TYPED e-signature is the
  // person's own signing act — what THEY type renders as the signature.
  // The old rule ("never registers the signature field") encoded the ban on
  // the APP signing for the person; the ban that stands is on auto-fill,
  // so the mapping must be registered yet UNMAPPED: the only source a
  // fill can ever draw from is the fresh typed value riding the request.
  it("registers the signature field as an unmapped text field (typed e-signature)", () => {
    const signature = entry().fields.find(
      (field) => field.name === "Signature",
    );
    expect(signature, "the DHB-5200 Signature field is registered").toBeDefined();
    expect(signature?.type).toBe("text");
    // Unmapped: structurally impossible to auto-populate from stored
    // answers or the vault — the fill's value sources for an unmapped
    // field are the in-request values only.
    expect(signature?.specQuestionId).toBeNull();
    // The person may skip typing: the form downloads unsigned, honestly.
    expect(signature?.required).toBe(false);
    // The person's legal name is sensitive by default.
    expect(signature?.piiLikely).toBe(true);
    expect(signature?.pages).toEqual([20]);
  });

  it("round-trips: fills the real bytes and re-parses the values", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const values: Record<string, FillValue> = {
      "1 First name Middle name Last name  Suffix": {
        display: "Alex Demo Person",
        provenance: "user_supplied",
        source: "in_request",
      },
      "3 Date of Birth mmddyyyy": {
        display: "1988-05-14",
        provenance: "user_supplied",
        source: "vault",
      },
      "14 Phone Number": {
        display: "704-555-0100",
        provenance: "user_supplied",
        source: "vault",
      },
      undefined_10: {
        display: "900",
        provenance: "user_supplied",
        source: "spec_answer",
      },
    };
    const outcome = await fillFormPdf(realBytes(), entry(), values);
    const filledNames = outcome.filled.map((field) => field.fieldName);
    for (const name of Object.keys(values)) {
      expect(filledNames).toContain(name);
    }
    const reparsed = await PDFDocument.load(outcome.bytes, {
      ignoreEncryption: true,
    });
    const form = reparsed.getForm();
    expect(
      form.getTextField("1 First name Middle name Last name  Suffix").getText(),
    ).toBe("Alex Demo Person");
    expect(form.getTextField("3 Date of Birth mmddyyyy").getText()).toBe(
      "1988-05-14",
    );
    expect(form.getTextField("14 Phone Number").getText()).toBe("704-555-0100");
    expect(form.getTextField("undefined_10").getText()).toBe("900");
  });

  it("lists unfilled registry fields as to-resolve, visibly blank", async () => {
    const outcome = await fillFormPdf(realBytes(), entry(), {});
    const resolvedNames = outcome.toResolve.map((item) => item.fieldName);
    // Only MAPPED fields are to-resolve: the dispositioned fields (not
    // collected / optional / agency-use / structural) stay blank by
    // documentation, never as still-needed items.
    const mapped = entry().fields.filter(
      (field) => field.disposition === "mapped",
    );
    expect(resolvedNames.length).toBe(mapped.length);
    for (const item of outcome.toResolve) {
      expect(item.question.length).toBeGreaterThan(0);
      expect(item.reason).toBe("unknown");
      expect(
        mapped.find((field) => field.name === item.fieldName),
      ).toBeDefined();
    }
  });

  // --- full-form mapping, part 1 (pages 1-8) --------------------------------

  it("dispositions every pages 1-8 field - none left undispositioned", async () => {
    const pdf = await assertLoadablePdf(realBytes());
    const discovered = discoverAcroFormFields(pdf);
    const onPages = discovered.filter((field) => field.page <= 8);
    // The committed template's per-page widget counts (the discovery pass's
    // own view, page 1 being the unfillable print pushbutton alone).
    const counts = new Map<number, number>();
    for (const field of onPages) {
      counts.set(field.page, (counts.get(field.page) ?? 0) + 1);
    }
    expect([...counts.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [2, 18],
      [3, 47],
      [4, 19],
      [5, 57],
      [6, 13],
      [7, 46],
      [8, 24],
    ]);
    // Every named field those widgets belong to carries a registry entry
    // with an explicit disposition - mapped, or one of the honest reasons.
    const byName = new Map(entry().fields.map((field) => [field.name, field]));
    const named = new Set(onPages.map((field) => field.name));
    expect(named.size).toBe(204);
    for (const name of named) {
      const field = byName.get(name);
      expect(
        field,
        `pages 1-8 field ${JSON.stringify(name)} has no registry entry`,
      ).toBeDefined();
      expect(DISPOSITIONS).toContain(field!.disposition);
      if (field!.disposition !== "mapped") {
        expect(
          field!.dispositionReason?.length ?? 0,
          `field ${JSON.stringify(name)} lacks a disposition reason`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("the expanded flow view asks only mapped fields", () => {
    const registry = entry();
    const view = buildFormFlow(registry, {});
    // 205 registry fields, 11 mapped: the dispositioned fields (not
    // collected / optional / agency-use / structural) never join the asked
    // flow - part 3 of the mapping makes the full disposition report
    // retrievable; the flow asks only what the person answers.
    expect(registry.fields.length).toBe(205);
    expect(view.fields.length).toBe(11);
    for (const field of view.fields) {
      const source = registry.fields.find((f) => f.name === field.fieldName);
      expect(source?.disposition).toBe("mapped");
    }
  });

  it("round-trips every pages 1-8 mapped field through fillFormPdf with read-back", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const registry = entry();
    const persona: Record<string, FillValue> = {
      "1 First name Middle name Last name  Suffix": {
        display: "Alex Demo Person",
        provenance: "user_supplied",
        source: "in_request",
      },
      "2 Home address Leave blank if you dont have one": {
        display: "123 Main St, Sample City, NC 00000",
        provenance: "user_supplied",
        source: "in_request",
      },
      "8 Mailing Address if different from home address": {
        display: "PO Box 1, Sample City, NC 00001",
        provenance: "user_supplied",
        source: "in_request",
      },
      "14 Phone Number": {
        display: "704-555-0100",
        provenance: "user_supplied",
        source: "vault",
      },
      "5 State": {
        display: STATE_OPTION_LABEL,
        provenance: "user_supplied",
        source: "spec_answer",
      },
      "7 County": {
        display: "Sample County",
        provenance: "user_supplied",
        source: "vault",
      },
      "3 Date of Birth mmddyyyy": {
        display: "05/14/1988",
        provenance: "user_supplied",
        source: "vault",
      },
      "5 Social Security Number SSN": {
        display: "000-00-0000",
        provenance: "user_supplied",
        source: "in_request",
      },
      undefined_10: {
        display: "900",
        provenance: "user_supplied",
        source: "spec_answer",
      },
      "Your total income next year if you think it will be different": {
        display: "18000",
        provenance: "user_supplied",
        source: "in_request",
      },
    };
    // The persona covers EXACTLY the mapped fields whose pages sit within
    // 1-8 (part 1's scope) - self-checking the persona against the registry.
    const mappedOnPages = registry.fields
      .filter(
        (field) =>
          field.disposition === "mapped" &&
          field.pages.every((page) => page <= 8),
      )
      .map((field) => field.name)
      .sort();
    expect(Object.keys(persona).sort()).toEqual(mappedOnPages);

    const outcome = await fillFormPdf(realBytes(), registry, persona);
    // The ONLY mapped field outside pages 1-8 is the signature (page 20) —
    // the person's fresh typed input, never a persona answer. Everything
    // else in the persona filled.
    expect(outcome.toResolve.map((item) => item.fieldName)).toEqual([
      "Signature",
    ]);
    const reparsed = await PDFDocument.load(outcome.bytes, {
      ignoreEncryption: true,
    });
    const form = reparsed.getForm();
    // Read-back of EVERY mapped pages 1-8 field: what the persona carries
    // is what the filled form shows - byte for byte.
    expect(
      form.getTextField("1 First name Middle name Last name  Suffix").getText(),
    ).toBe("Alex Demo Person");
    expect(
      form.getTextField("2 Home address Leave blank if you dont have one").getText(),
    ).toBe("123 Main St, Sample City, NC 00000");
    expect(
      form.getTextField("8 Mailing Address if different from home address").getText(),
    ).toBe("PO Box 1, Sample City, NC 00001");
    expect(form.getTextField("14 Phone Number").getText()).toBe("704-555-0100");
    expect(form.getTextField("5 State").getText()).toBe(STATE_OPTION_LABEL);
    expect(form.getTextField("7 County").getText()).toBe("Sample County");
    expect(form.getTextField("3 Date of Birth mmddyyyy").getText()).toBe(
      "05/14/1988",
    );
    expect(form.getTextField("5 Social Security Number SSN").getText()).toBe(
      "000-00-0000",
    );
    expect(form.getTextField("undefined_10").getText()).toBe("900");
    expect(
      form.getTextField(
        "Your total income next year if you think it will be different",
      ).getText(),
    ).toBe("18000");
  });

  // Property (skills/property-based-testing): a mapped yes/no radio pair
  // fills from the pair's DISCOVERED export values - checked selects the
  // yes-state, unchecked the no-state, nothing else ever lands in the
  // group. The synthetic entry rides the real template bytes (the
  // third-party integration is what's proven).
  it("radio fields fill by their discovered export values (yes/no semantics)", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const radioField: FormRegistryField = {
      name: "Will you file jointly with a spouse",
      type: "radio",
      label: "a. Will you file jointly with a spouse?",
      question:
        "Synthetic mapping entry for the radio-fill property (not committed data).",
      specQuestionId: null,
      piiLikely: true,
      required: false,
      pages: [3],
      disposition: "mapped",
      exportValues: { yes: "Yes_3", no: "No" },
    };
    const synthetic: FormRegistryEntry = { ...entry(), fields: [radioField] };
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (answer) => {
        const outcome = await fillFormPdf(realBytes(), synthetic, {
          "Will you file jointly with a spouse": fillValueFor(
            answer ? "checked" : "unchecked",
          ),
        });
        const reparsed = await PDFDocument.load(outcome.bytes, {
          ignoreEncryption: true,
        });
        const group = reparsed
          .getForm()
          .getRadioGroup("Will you file jointly with a spouse");
        expect(group.getSelected()).toBe(answer ? "Yes_3" : "No");
      }),
      // Each run fills + re-parses the 21-page PDF (~0.5 s) - few runs.
      { numRuns: 4 },
    );
  }, 30000);

  // Property: a dispositioned field is UNFILLABLE by construction - even a
  // caller that sends a value for one gets blank bytes, no fill entry, and
  // no to-resolve item (the disposition documents why it stays blank).
  // The mapped control field behaves normally: filled when answered,
  // to-resolve when not.
  it("non-mapped dispositions stay blank, never asked, never to-resolve (property)", async () => {
    const dispositions = [
      "not_collected_by_interview",
      "optional_unanswered",
      "agency_use_only",
      "duplicate_structural",
    ] as const;
    const dispositionedField = (disposition: FormFieldDisposition): FormRegistryField => ({
      name: "5 Social Security Number SSN",
      type: "text",
      label: "5. Social Security Number (SSN):",
      question:
        "Synthetic mapping entry for the disposition-exclusion property (not committed data).",
      specQuestionId: null,
      piiLikely: true,
      required: false,
      pages: [3],
      disposition,
      ...(disposition === "mapped" ? {} : { dispositionReason: "test reason" }),
    });
    const mappedField: FormRegistryField = {
      name: "14 Phone Number",
      type: "text",
      label: "14. Phone Number",
      question:
        "Synthetic mapping entry for the disposition-exclusion property (not committed data).",
      specQuestionId: null,
      piiLikely: true,
      required: false,
      pages: [2],
      disposition: "mapped",
    };
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...dispositions),
        fc.boolean(),
        async (disposition, mappedAnswered) => {
          const synthetic: FormRegistryEntry = {
            ...entry(),
            fields: [mappedField, dispositionedField(disposition)],
          };
          // A value rides the request for BOTH fields - the dispositioned
          // one must still come out blank and unfilled.
          const values: Record<string, FillValue> = {
            "5 Social Security Number SSN": fillValueFor("000-00-0000"),
          };
          if (mappedAnswered) {
            values["14 Phone Number"] = fillValueFor("704-555-0100");
          }
          const outcome = await fillFormPdf(realBytes(), synthetic, values);
          expect(
            outcome.filled.find((f) => f.fieldName === "5 Social Security Number SSN"),
          ).toBeUndefined();
          const resolved = outcome.toResolve.map((item) => item.fieldName);
          expect(resolved).not.toContain("5 Social Security Number SSN");
          expect(resolved).toEqual(
            mappedAnswered ? [] : ["14 Phone Number"],
          );
          // And the flow view never asks a dispositioned field.
          const view = buildFormFlow(synthetic, {});
          expect(view.fields.map((field) => field.fieldName)).toEqual([
            "14 Phone Number",
          ]);
        },
      ),
      { numRuns: 12 },
    );
  }, 30000);

  // --- end full-form mapping part 1 -----------------------------------------

  // Property (skills/property-based-testing): whatever the person TYPES as
  // their signature — arriving exactly as the real typed-signature step
  // sends it — is what the filled form carries, and nothing else ever
  // populates that field. The signature value is arbitrary (printable
  // WinAnsi text, the fonts the fill embeds), the persona fields are
  // arbitrary too: the invariant is that the output's Signature equals the
  // typed value when present, and stays blank + to-resolve when absent.
  it("the signature fills with EXACTLY the typed value, or stays blank when absent (VAL-VJS2-002)", async () => {
    const signatureArb = fc
      .string({ minLength: 1, maxLength: 80 })
      .filter((s) => /^[\x20-\x7E\xA0-\xFF\t\n\r]*$/.test(s) && s.trim().length > 0)
      .map((s) => s.trim());
    const personaArb = fc.record({
      homeAddress: fc.option(fc.string({ minLength: 1, maxLength: 80 }), { nil: undefined }),
      nextYearIncome: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: undefined }),
    });
    await fc.assert(
      fc.asyncProperty(
        signatureArb,
        fc.option(signatureArb, { nil: undefined }),
        personaArb,
        async (typedName, absentCase, persona) => {
          // `absentCase` toggles whether this run carries a typed signature
          // at all — the empty path must behave identically every time.
          const signature = absentCase === undefined ? typedName : undefined;
          const values: Record<string, FillValue> = {};
          if (persona.homeAddress !== undefined) {
            values["2 Home address Leave blank if you dont have one"] = {
              display: persona.homeAddress,
              provenance: "user_supplied",
              source: "in_request",
            };
          }
          if (persona.nextYearIncome !== undefined) {
            values[
              "Your total income next year if you think it will be different"
            ] = { display: persona.nextYearIncome, provenance: "user_supplied", source: "in_request" };
          }
          if (signature !== undefined) {
            values.Signature = {
              display: signature,
              provenance: "user_supplied",
              source: "in_request",
            };
          }
          const outcome = await fillFormPdf(realBytes(), entry(), values);
          const { PDFDocument } = await import("@cantoo/pdf-lib");
          const reparsed = await PDFDocument.load(outcome.bytes, {
            ignoreEncryption: true,
          });
          const signatureField = reparsed
            .getForm()
            .getTextField("Signature");
          if (signature === undefined) {
            // The app never signs: no typed value → the field stays
            // VISIBLY blank and the to-resolve list says so.
            expect(signatureField.getText() ?? "").toBe("");
            expect(
              outcome.toResolve.map((item) => item.fieldName),
            ).toContain("Signature");
          } else {
            // Exactly what was typed — never trimmed further, never
            // copied from another field, never a store's value.
            expect(signatureField.getText()).toBe(signature);
            expect(
              outcome.filled.find((f) => f.fieldName === "Signature")
                ?.provenance,
            ).toBe("user_supplied");
            expect(
              outcome.toResolve.map((item) => item.fieldName),
            ).not.toContain("Signature");
          }
        },
      ),
      // Each run fills + re-parses the 21-page official PDF (~0.5 s local,
      // slower on CI runners) — 8 randomized combinations with an explicit
      // 30 s budget keeps the property affordable in CI.
      { numRuns: 8 },
    );
  }, 30000);
});

// --- helpers -----------------------------------------------------------------

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function extractPageText(
  bytes: Uint8Array,
  pageNumber: number,
): Promise<string> {
  // Mirrors parse.ts's pdfjs import (the legacy build's shape is the one
  // the pipeline codes against).
  const pdfjs = (await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  )) as unknown as {
    getDocument: (params: {
      data: Uint8Array;
      isEvalSupported: boolean;
    }) => {
      promise: Promise<{
        getPage: (n: number) => Promise<{
          getTextContent: () => Promise<{ items: { str: string }[] }>;
        }>;
      }>;
      destroy?: () => Promise<void>;
    };
  };
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    return content.items.map((item) => item.str).join(" ");
  } finally {
    await task.destroy?.();
  }
}
