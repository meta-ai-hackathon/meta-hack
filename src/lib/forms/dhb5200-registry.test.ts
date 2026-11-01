import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";
import { assertLoadablePdf, discoverAcroFormFields, extractFieldLabels } from "./parse";
import { fillFormPdf, type FillValue } from "./fill";
import { getFormRegistryEntry } from "./registry";
import type { FormFieldDisposition, FormRegistryEntry, FormRegistryField } from "./registry";
import { buildFormFlow } from "./flow";
import { buildDispositionReport } from "./disposition";
import { QUESTION_BY_ID } from "../intake/spec";
import { setLogSink } from "../telemetry";
import fullPersonaJson from "./fixtures/dhb5200-full-persona.json";

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

/**
 * The full-form persona's in-request answers (fixture data, NOT product
 * data): a clearly-synthetic persona answering every mapped field the
 * spec doesn't ask, keyed by the DHB-5200's real AcroForm field names —
 * exactly what the review-and-complete step sends with the fill request.
 */
const DHB5200_FULL_PERSONA = fullPersonaJson as Record<string, string>;

/**
 * The residency field's name carries the form's own printed wording
 * (derived from the spec's option label, the way this file derives the
 * state display — the file sits inside src/lib/forms where the pilot-name
 * scan runs).
 */
const RESIDENCY_P3_FIELD = `13 Is PERSON 3 a resident of ${STATE_OPTION_LABEL}`;

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
    // 571 registry fields after part 3 (pages 16-21 complete the form),
    // 355 mapped: every person-answerable field on all 21 pages is now an
    // in-request answer carrier (the owner's full-form mapping decision),
    // so the review-and-complete step asks it at fill time; the
    // dispositioned fields (not collected / optional / agency-use /
    // structural) never join the asked flow, and the full disposition
    // report is retrievable on the review surface.
    expect(registry.fields.length).toBe(571);
    expect(view.fields.length).toBe(355);
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
    // Everything in the persona filled; the to-resolve list is exactly the
    // mapped fields the persona does NOT cover: the pages 9-15 mapped
    // fields (part 2's scope, covered by its own persona below) plus the
    // signature (page 20) — the person's fresh typed input, never a
    // persona answer.
    const personaNames = new Set(Object.keys(persona));
    expect(outcome.toResolve.map((item) => item.fieldName).sort()).toEqual(
      registry.fields
        .filter(
          (field) =>
            field.disposition === "mapped" && !personaNames.has(field.name),
        )
        .map((field) => field.name)
        .sort(),
    );
    expect(outcome.toResolve.map((item) => item.fieldName)).toContain(
      "Signature",
    );
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

  // --- full-form mapping, part 2 (pages 9-15) --------------------------------

  it("dispositions every pages 9-15 field - none left undispositioned", async () => {
    const pdf = await assertLoadablePdf(realBytes());
    const discovered = discoverAcroFormFields(pdf);
    const onPages = discovered.filter(
      (field) => field.page >= 9 && field.page <= 15,
    );
    // The committed template's per-page widget counts (the discovery pass's
    // own view) - pinned like part 1's pages 1-8 block.
    const counts = new Map<number, number>();
    for (const field of onPages) {
      counts.set(field.page, (counts.get(field.page) ?? 0) + 1);
    }
    expect([...counts.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [9, 58],
      [10, 13],
      [11, 47],
      [12, 24],
      [13, 57],
      [14, 14],
      [15, 47],
    ]);
    // Every named field those widgets belong to carries a registry entry
    // with an explicit disposition - mapped, or one of the honest reasons.
    const byName = new Map(entry().fields.map((field) => [field.name, field]));
    const named = new Set(onPages.map((field) => field.name));
    expect(named.size).toBe(246);
    for (const name of named) {
      const field = byName.get(name);
      expect(
        field,
        `pages 9-15 field ${JSON.stringify(name)} has no registry entry`,
      ).toBeDefined();
      expect(DISPOSITIONS).toContain(field!.disposition);
      if (field!.disposition !== "mapped") {
        expect(
          field!.dispositionReason?.length ?? 0,
          `field ${JSON.stringify(name)} lacks a disposition reason`,
        ).toBeGreaterThan(0);
      }
      // Part 2's fields take in-request answers only (the spec doesn't ask
      // about household members): every one is spec-null and therefore
      // sensitive-by-default.
      expect(field!.specQuestionId).toBeNull();
      expect(field!.piiLikely).toBe(true);
    }
  });

  it("maps the owner-flagged answerable topics on pages 9-15 as in-request carriers", () => {
    const registry = entry();
    const byName = new Map(registry.fields.map((field) => [field.name, field]));
    // The owner flagged these topics explicitly for the full-form mapping:
    // they are answered by the person at the review-and-complete step, so
    // they must be MAPPED (fillable in-request), with the checkbox/radio
    // export-value semantics the template itself discovered.
    const flagged: [string, "checkbox" | "radio", string?][] = [
      // Person 3's race/ethnicity checkboxes (page 11, OPTIONAL on the form)
      ["White or Caucasian_3", "checkbox", "On"],
      ["Black or AfricanAmerican_3", "checkbox", "On"],
      ["Asian_3", "checkbox", "On"],
      ["Native Hawaiian_3", "checkbox", "On"],
      ["Other Pacific Islander_3", "checkbox", "On"],
      [
        "American Indian or Alaska Native If so complete Appendix B_2",
        "checkbox",
        "On",
      ],
      ["Other_6", "checkbox", "On"],
      ["Mexican_3", "checkbox", "On"],
      // Residency (page 12)
      [RESIDENCY_P3_FIELD, "radio"],
      // Pregnancy (page 12)
      ["14 Is PERSON 3 pregnant", "radio"],
      // Child under 18 (page 12)
      ["Check Box14", "checkbox", "Yes"],
      ["No_39", "checkbox", "On"],
      // Foster care (page 12)
      ["Carolina_2", "radio"],
      // Disability + age/blind (page 12)
      ["undefined_55", "checkbox", "On"],
      ["undefined_56", "checkbox", "On"],
      ["older_2", "radio"],
      ["undefined_57", "checkbox", "On"],
      ["undefined_58", "checkbox", "On"],
      // CAP condition (page 12)
      [
        "living such as bathing dressing daily chores etc live in a medical facility nursing home andor need home and_2",
        "radio",
      ],
      // Help paying medical bills (page 12)
      [
        "19 Does PERSON 3 need help paying for medical bills in the last 3 months",
        "radio",
      ],
      // Person 4's race/ethnicity checkboxes (page 15)
      ["White or Caucasian_4", "checkbox", "On"],
      ["Mexican_4", "checkbox", "On"],
    ];
    for (const [name, type, onValue] of flagged) {
      const field = byName.get(name);
      expect(field, `flagged field ${JSON.stringify(name)} registered`).toBeDefined();
      expect(field!.disposition, name).toBe("mapped");
      expect(field!.type, name).toBe(type);
      if (onValue !== undefined) {
        expect(field!.exportValue, name).toBe(onValue);
      }
    }
    // Mapped radio pairs carry their discovered yes/no export values so the
    // fill never guesses a side.
    const residency = byName.get(RESIDENCY_P3_FIELD);
    expect(residency!.exportValues).toBeDefined();
    const helpPaying = byName.get(
      "19 Does PERSON 3 need help paying for medical bills in the last 3 months",
    );
    expect(helpPaying!.exportValues!.yes).toMatch(/^Yes_/);
    expect(helpPaying!.exportValues!.no).toMatch(/^No_/);
  });

  it("round-trips every pages 9-15 mapped field through fillFormPdf with read-back (in-request persona riding the raised cap)", async () => {
    const { PDFDocument } = await import("@cantoo/pdf-lib");
    const registry = entry();
    // The full-form persona's in-request answers (the same fixture the
    // fill route's full-coverage test rides): coherent synthetic answers
    // for every mapped field the spec doesn't ask, keyed by the form's
    // real field names - exactly what the review-and-complete step sends.
    // Self-checking: the persona covers EXACTLY the entry's mapped
    // spec-null fields (the in-request carriers - pages 9-15's mapped
    // fields plus part 1's own, signature included) - and the count rides
    // the RAISED cap (650); the old cap (50) would have refused the
    // persona outright.
    const inRequestMapped = registry.fields
      .filter(
        (field) =>
          field.disposition === "mapped" && field.specQuestionId === null,
      )
      .map((field) => field.name)
      .sort();
    expect(Object.keys(DHB5200_FULL_PERSONA).sort()).toEqual(inRequestMapped);
    const mappedOnPages = registry.fields
      .filter(
        (field) =>
          field.disposition === "mapped" &&
          field.pages.every((page) => page >= 9 && page <= 15),
      )
      .map((field) => field.name)
      .sort();
    expect(mappedOnPages.length).toBeGreaterThan(50);

    const persona: Record<string, FillValue> = {};
    for (const name of mappedOnPages) {
      persona[name] = {
        display: DHB5200_FULL_PERSONA[name]!,
        provenance: "user_supplied",
        source: "in_request",
      };
    }
    const outcome = await fillFormPdf(realBytes(), registry, persona);
    // The ONLY to-resolve items are the mapped fields OUTSIDE pages 9-15
    // (this test runs without a session and the persona covers the 9-15
    // in-request carriers only): part 1's five spec-mapped fields (no
    // answers on file here) plus part 1's six in-request carriers — the
    // typed signature among them, which only ever fills from fresh input.
    expect(outcome.toResolve.map((item) => item.fieldName).sort()).toEqual(
      registry.fields
        .filter(
          (field) =>
            field.disposition === "mapped" &&
            !field.pages.every((page) => page >= 9 && page <= 15),
        )
        .map((field) => field.name)
        .sort(),
    );

    // Read-back: EVERY mapped pages 9-15 field returns the fixture value -
    // checkbox states included, radios by their discovered export values.
    const reparsed = await PDFDocument.load(outcome.bytes, {
      ignoreEncryption: true,
    });
    const form = reparsed.getForm();
    for (const field of registry.fields) {
      if (
        field.disposition !== "mapped" ||
        !field.pages.every((page) => page >= 9 && page <= 15)
      ) {
        continue;
      }
      const expected = DHB5200_FULL_PERSONA[field.name]!;
      if (field.type === "checkbox") {
        expect(form.getCheckBox(field.name).isChecked(), field.name).toBe(
          expected === "checked",
        );
      } else if (field.type === "radio") {
        expect(form.getRadioGroup(field.name).getSelected(), field.name).toBe(
          expected === "checked"
            ? field.exportValues!.yes
            : field.exportValues!.no,
        );
      } else {
        expect(form.getTextField(field.name).getText(), field.name).toBe(
          expected,
        );
      }
    }
  });

  // --- end full-form mapping part 2 -----------------------------------------

// --- full-form mapping, part 3 (pages 16-21 + full-form coverage) ----------

it("dispositions every pages 16-21 field - none left undispositioned", async () => {
  const pdf = await assertLoadablePdf(realBytes());
  const discovered = discoverAcroFormFields(pdf);
  const onPages = discovered.filter((field) => field.page >= 16);
  // The committed template's per-page widget counts (the discovery pass's
  // own view) - pinned like parts 1-2's blocks. Page 20 carries the
  // Signature field registered back at v1.1.0; page 21 is the voter
  // registration question's second appearance.
  const counts = new Map<number, number>();
  for (const field of onPages) {
    counts.set(field.page, (counts.get(field.page) ?? 0) + 1);
  }
  expect([...counts.entries()].sort((a, b) => a[0] - b[0])).toEqual([
    [16, 24],
    [17, 57],
    [18, 13],
    [19, 26],
    [20, 8],
    [21, 2],
  ]);
  // Every named field those widgets belong to carries a registry entry
  // with an explicit disposition - mapped, or one of the honest reasons.
  const byName = new Map(entry().fields.map((field) => [field.name, field]));
  const named = new Set(onPages.map((field) => field.name));
  expect(named.size).toBe(121);
  for (const name of named) {
    const field = byName.get(name);
    expect(
      field,
      `pages 16-21 field ${JSON.stringify(name)} has no registry entry`,
    ).toBeDefined();
    expect(DISPOSITIONS).toContain(field!.disposition);
    if (field!.disposition !== "mapped") {
      expect(
        field!.dispositionReason?.length ?? 0,
        `field ${JSON.stringify(name)} lacks a disposition reason`,
      ).toBeGreaterThan(0);
    }
    // Part 3's fields take in-request answers only (the spec doesn't ask
    // about household members' details): every one is spec-null and
    // therefore sensitive-by-default.
    expect(field!.specQuestionId).toBeNull();
    expect(field!.piiLikely).toBe(true);
  }
});

it("dispositions every discovered field across all 21 pages - zero undispositioned (VAL-FIX-007)", async () => {
  const pdf = await assertLoadablePdf(realBytes());
  const discovered = discoverAcroFormFields(pdf);
  const registry = entry();
  const byName = new Map(registry.fields.map((field) => [field.name, field]));
  // The owner's full-form decision, completed: walk EVERY widget the
  // template discovers (614 across the 571 named fields) and require a
  // dispositioned registry entry for its name - mapped, or one of the
  // honest reasons. Nothing is silently unmapped anywhere on the form.
  const undispositioned: string[] = [];
  for (const widget of discovered) {
    const field = byName.get(widget.name);
    if (!field) {
      undispositioned.push(widget.name);
      continue;
    }
    expect(DISPOSITIONS).toContain(field.disposition);
    if (field.disposition !== "mapped") {
      expect(
        field.dispositionReason?.length ?? 0,
        `field ${JSON.stringify(widget.name)} lacks a disposition reason`,
      ).toBeGreaterThan(0);
    }
  }
  expect(undispositioned).toEqual([]);
  // The registry is EXACTLY the template's named-field set: 571 entries,
  // no padding, no omissions (the multi-widget radio pairs account for
  // the 614-vs-571 difference).
  expect(registry.fields.length).toBe(571);
  expect(new Set(discovered.map((widget) => widget.name)).size).toBe(571);
});

it("maps the pages 16-21 answerable topics as in-request carriers", () => {
  const registry = entry();
  const byName = new Map(registry.fields.map((field) => [field.name, field]));
  // Person 4's question block (page 16) mirrors Person 3's pages 12
  // mappings: residency (derived like part 2's - this file sits inside
  // src/lib/forms where the pilot-name scan runs), pregnancy, foster
  // care, disability, age/blind, CAP condition, help paying medical
  // bills, and the job-insurance Yes/No boxes.
  const residencyP4Field = `13 Is PERSON 4 a resident of ${STATE_OPTION_LABEL}`;
  const flagged: [string, "checkbox" | "radio", string?][] = [
    [residencyP4Field, "radio"],
    ["14 Is PERSON 4 pregnant", "radio"],
    ["Check Box15", "checkbox", "Yes"],
    ["undefined_79", "checkbox", "On"],
    ["undefined_80", "checkbox", "On"],
    ["undefined_81", "checkbox", "On"],
    ["undefined_82", "checkbox", "On"],
    ["undefined_83", "checkbox", "On"],
    ["older_3", "radio"],
    ["undefined_84", "checkbox", "On"],
    ["undefined_85", "checkbox", "On"],
    [
      "living such as bathing dressing daily chores etc live in a medical facility nursing home andor need home and_3",
      "radio",
    ],
    ["Check Box17", "checkbox", "Yes"],
    ["Check Box18", "checkbox", "Yes"],
    ["undefined_86", "checkbox", "On"],
    ["No_56", "checkbox", "On"],
  ];
  for (const [name, type, onValue] of flagged) {
    const field = byName.get(name);
    expect(field, `flagged field ${JSON.stringify(name)} registered`).toBeDefined();
    expect(field!.disposition, name).toBe("mapped");
    expect(field!.type, name).toBe(type);
    if (onValue !== undefined) {
      expect(field!.exportValue, name).toBe(onValue);
    }
  }
  // Mapped radio pairs carry their discovered yes/no export values so the
  // fill never guesses a side.
  const pregnancy = byName.get("14 Is PERSON 4 pregnant");
  expect(pregnancy!.exportValues!.yes).toMatch(/^Yes_/);
  expect(pregnancy!.exportValues!.no).toMatch(/^No_/);
  // The household coverage rows (page 19) are mapped row-by-row: every
  // checkbox the coverage list prints is an answer carrier, named by the
  // form's own row label (some row names carry program names, so this
  // file asserts them structurally - the Step 3 pair plus every page-19
  // coverage-list checkbox is mapped).
  const page19Checkboxes = registry.fields.filter(
    (field) =>
      field.pages[0] === 19 && field.type === "checkbox",
  );
  expect(page19Checkboxes.length).toBe(9);
  for (const field of page19Checkboxes) {
    expect(field.disposition, field.name).toBe("mapped");
    expect(field.exportValue, field.name).toBe("On");
  }
  // The renewal election (page 20): all five term boxes plus the opt-out
  // are mapped - the person's own election at review time.
  const page20Mapped = registry.fields.filter(
    (field) => field.pages[0] === 20 && field.disposition === "mapped",
  );
  expect(page20Mapped.map((field) => field.name).sort()).toEqual(
    [
      "5 years the maximum number of years allowed",
      "4 years",
      "3 years",
      "2 year",
      "1 year",
      "Do not use information from tax returns to renew my coverage",
      "Date mmddyyyy",
      "Signature",
    ].sort(),
  );
  // The signature date rides the typed-signature step: a date box in the
  // form's own printed format.
  const dateSigned = byName.get("Date mmddyyyy");
  expect(dateSigned!.type).toBe("text");
  expect(dateSigned!.displayFormat).toBe("mm/dd/yyyy");
});

it("round-trips every pages 16-21 mapped field through fillFormPdf with read-back (in-request persona riding the raised cap)", async () => {
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  const registry = entry();
  // The full-form persona's in-request answers: coherent synthetic
  // answers for every mapped field the spec doesn't ask - the fixture now
  // covers pages 16-21's carriers too (part 3's scope), still riding the
  // RAISED cap (650).
  const inRequestMapped = registry.fields
    .filter(
      (field) =>
        field.disposition === "mapped" && field.specQuestionId === null,
    )
    .map((field) => field.name)
    .sort();
  expect(Object.keys(DHB5200_FULL_PERSONA).sort()).toEqual(inRequestMapped);
  const mappedOnPages = registry.fields
    .filter(
      (field) =>
        field.disposition === "mapped" &&
        field.pages.every((page) => page >= 16 && page <= 21),
    )
    .map((field) => field.name)
    .sort();
  // 116 part-3 mappings plus the Signature field (registered back at
  // v1.1.0, page 20) - the persona covers it exactly as the real
  // typed-signature step sends it.
  expect(mappedOnPages.length).toBe(117);

  const persona: Record<string, FillValue> = {};
  for (const name of mappedOnPages) {
    persona[name] = {
      display: DHB5200_FULL_PERSONA[name]!,
      provenance: "user_supplied",
      source: "in_request",
    };
  }
  const outcome = await fillFormPdf(realBytes(), registry, persona);
  // The ONLY to-resolve items are the mapped fields OUTSIDE pages 16-21
  // (parts 1-2's scope, covered by their own rounds above).
  expect(outcome.toResolve.map((item) => item.fieldName).sort()).toEqual(
    registry.fields
      .filter(
        (field) =>
          field.disposition === "mapped" &&
          !field.pages.every((page) => page >= 16 && page <= 21),
      )
      .map((field) => field.name)
      .sort(),
  );

  // Read-back: EVERY mapped pages 16-21 field returns the fixture value -
  // checkbox states included, radios by their discovered export values.
  const reparsed = await PDFDocument.load(outcome.bytes, {
    ignoreEncryption: true,
  });
  const form = reparsed.getForm();
  for (const field of registry.fields) {
    if (
      field.disposition !== "mapped" ||
      !field.pages.every((page) => page >= 16 && page <= 21)
    ) {
      continue;
    }
    const expected = DHB5200_FULL_PERSONA[field.name]!;
    if (field.type === "checkbox") {
      expect(form.getCheckBox(field.name).isChecked(), field.name).toBe(
        expected === "checked",
      );
    } else if (field.type === "radio") {
      expect(form.getRadioGroup(field.name).getSelected(), field.name).toBe(
        expected === "checked"
          ? field.exportValues!.yes
          : field.exportValues!.no,
      );
    } else {
      expect(form.getTextField(field.name).getText(), field.name).toBe(
        expected,
      );
    }
  }
});

it("the disposition report covers every field across all 21 pages (VAL-FIX-007)", () => {
  const registry = entry();
  const report = buildDispositionReport(registry);
  // The complete honest arithmetic: every one of the template's 571 named
  // fields lands in exactly one disposition bucket.
  expect(report.counts.total).toBe(571);
  expect(report.counts.mapped).toBe(355);
  expect(report.counts.not_collected_by_interview).toBe(164);
  expect(report.counts.optional_unanswered).toBe(29);
  expect(report.counts.agency_use_only).toBe(0);
  expect(report.counts.duplicate_structural).toBe(23);
  // The per-field rows carry every registry field with its disposition -
  // the review surface renders or serves these, so nothing is silently
  // unmapped.
  expect(report.fields.length).toBe(571);
  const byName = new Map(registry.fields.map((field) => [field.name, field]));
  for (const row of report.fields) {
    const source = byName.get(row.fieldName);
    expect(source).toBeDefined();
    expect(row.disposition).toBe(source!.disposition);
    if (row.disposition !== "mapped") {
      expect(
        row.dispositionReason?.length ?? 0,
        `report row ${JSON.stringify(row.fieldName)} lacks a reason`,
      ).toBeGreaterThan(0);
    }
  }
  // Every page 2-21 appears (page 1 is the unfillable print pushbutton).
  const pages = new Set(report.fields.flatMap((row) => row.pages));
  for (let page = 2; page <= 21; page++) {
    expect(pages.has(page), `page ${page} missing from the report`).toBe(true);
  }
});

// --- end full-form mapping part 3 -----------------------------------------

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
