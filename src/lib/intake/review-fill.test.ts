import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildFormFlow } from "../forms/flow";
import type { StoredAnswer } from "../intake/flow";
import { parseCommittedRegistryEntries } from "../forms/registry-core";
import {
  fillReviewOnDevice,
  reviewFormEntry,
  type ReviewFillField,
} from "./review-fill";

// The conversation review's browser-side fill (HACK-138). The review
// section's download used to POST /api/forms/<formId>/fill, which filled
// the form on the server from the vault and sent the PDF back — the one
// thing the sanctioned-download rule (rules.md, HACK-115) does not permit:
// "This exception does not permit sending server- or vault-held pii values
// to a page or payload … a form value the client does not already hold
// stays off the client." The download now fills in the browser, from the
// values the review payload already carries and the answers typed into the
// review — the same sanctioned construction the step-by-step page uses
// (device-fill.ts). These tests pin the construction:
//
// - the fill reads ONLY the payload's client-held values and the typed
//   drafts — a private answer the page doesn't hold is never filled and
//   never asked for;
// - the fields the server's skip logic marked not-applicable stay blank
//   and out of the to-resolve list (the review's own states are the
//   decision — the client doesn't re-derive skip logic);
// - box answers typed into the review fill a box only for the words
//   checked/unchecked — anything else is named back, never silently
//   printed unchecked;
// - the typed signature (an unmapped field's draft) fills exactly as
//   typed, and never from anything stored.

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURES = path.join(REPO_ROOT, "src/lib/forms/fixtures");

const SAMPLE_BYTES = () =>
  new Uint8Array(
    readFileSync(path.join(FIXTURES, "sample-form-acroform.pdf")),
  );
const REAL_BYTES = () =>
  new Uint8Array(
    readFileSync(path.join(FIXTURES, "dhb-5200-ia-9-2020.pdf")),
  );

const ENTRIES = parseCommittedRegistryEntries(
  (detail) => new Error(detail),
);
const SAMPLE_ENTRY = ENTRIES.find((entry) => entry.id === "sample-application-form")!;
const REAL_ENTRY = ENTRIES.find((entry) => entry.id === "dhb-5200")!;

/** The review payload's field views, built exactly as the review route builds them. */
function payloadViews(
  entry: typeof SAMPLE_ENTRY,
  answers: Parameters<typeof buildFormFlow>[1],
): readonly ReviewFillField[] {
  return buildFormFlow(entry, answers).fields;
}

describe("reviewFormEntry", () => {
  it("serves every committed registry entry by id", () => {
    for (const entry of ENTRIES) {
      expect(reviewFormEntry(entry.id)).toEqual(entry);
    }
  });

  it("names no entry for an unregistered id", () => {
    expect(reviewFormEntry("not-a-form")).toBeUndefined();
  });
});

describe("fillReviewOnDevice — the values the page already holds", () => {
  it("fills the payload's non-private display values and the typed drafts, and reads them back", async () => {
    // The sample payload: the two non-private answers the client holds,
    // the private ones known on the server but valueless on the page.
    const fields = payloadViews(SAMPLE_ENTRY, {
      household_size: { status: "known", value: 3 },
      housing_cost: { status: "known", value: 900 },
      date_of_birth: { status: "known", value: "1979-07-08" },
      phone_contact: { status: "known", value: "704-555-0110" },
    });
    const result = await fillReviewOnDevice(SAMPLE_BYTES(), fields, {
      applicant_name: "Alex Rivera Demo",
    }, SAMPLE_ENTRY);
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    const form = pdf.getForm();
    expect(form.getTextField("household_size_count").getText()).toBe("3");
    expect(form.getTextField("monthly_rent_amount").getText()).toBe("900");
    // The typed draft rides the fill: the person's own typed value, in
    // memory, once — provenance user_supplied, source in_request.
    expect(form.getTextField("applicant_name").getText()).toBe("Alex Rivera Demo");
    const filled = result.outcome.filled.map((item) => item.fieldName);
    expect(filled).toContain("household_size_count");
    expect(filled).toContain("monthly_rent_amount");
    expect(filled).toContain("applicant_name");
    expect(
      result.outcome.filled.find((item) => item.fieldName === "applicant_name")
        ?.provenance,
    ).toBe("user_supplied");
    expect(
      result.outcome.filled.find((item) => item.fieldName === "household_size_count")
        ?.provenance,
    ).toBe("user_supplied");
  });

  it("never fills a private answer the page doesn't hold — blank and to-resolve", async () => {
    // The payload carries the private answers' STATUS badges, never their
    // values (the review route omits them structurally): date of birth and
    // phone were answered known, yet the view has no value to fill from.
    const fields = payloadViews(SAMPLE_ENTRY, {
      household_size: { status: "known", value: 3 },
      date_of_birth: { status: "known", value: "1979-07-08" },
      phone_contact: { status: "known", value: "704-555-0110" },
    });
    const result = await fillReviewOnDevice(SAMPLE_BYTES(), fields, {}, SAMPLE_ENTRY);
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    const form = pdf.getForm();
    // Blank on the file, for the person to finish by hand.
    expect(form.getTextField("applicant_date_of_birth").getText() ?? "").toBe("");
    expect(form.getTextField("contact_phone").getText() ?? "").toBe("");
    const filled = result.outcome.filled.map((item) => item.fieldName);
    expect(filled).not.toContain("applicant_date_of_birth");
    expect(filled).not.toContain("contact_phone");
    // Named in the to-resolve list, so the person knows what to finish.
    const toResolve = result.outcome.toResolve.map((item) => item.fieldName);
    expect(toResolve).toContain("applicant_date_of_birth");
    expect(toResolve).toContain("contact_phone");
  });

  it("fills a payload box value only for the words the fill trusts — anything else stays blank and to-resolve", async () => {
    // A box the fill can't trust prints unchecked for any other word
    // (claude-review P2, PR #150): a payload display value outside the
    // checked/unchecked words — the review's own option label, say —
    // degrades to blank + to-resolve instead of silently printing the
    // opposite of the review's answer. No shipped form maps a non-private
    // checkbox (the sample's is piiLikely, so its view never carries a
    // value), so the view is built by hand to pin the rule itself.
    const box = (
      value: string,
    ): ReviewFillField => ({
      fieldName: "mail_consent",
      state: "prefilled",
      specQuestionId: "shelter_mail_consent",
      piiLikely: false,
      value,
    });
    const untrustedFill = await fillReviewOnDevice(
      SAMPLE_BYTES(),
      [box("yes"), ...payloadViews(SAMPLE_ENTRY, { household_size: { status: "known", value: 3 } })],
      {},
      SAMPLE_ENTRY,
    );
    if (untrustedFill.kind !== "filled") {
      throw new Error(`expected a fill, got ${untrustedFill.kind}`);
    }
    const untrustedPdf = await PDFDocument.load(untrustedFill.outcome.bytes);
    expect(untrustedPdf.getForm().getCheckBox("mail_consent").isChecked()).toBe(false);
    const untrustedToResolve = untrustedFill.outcome.toResolve.map((item) => item.fieldName);
    expect(untrustedToResolve).toContain("mail_consent");
    // The word the fill trusts rides the payload as itself and checks the box.
    const trustedFill = await fillReviewOnDevice(SAMPLE_BYTES(), [box("CHECKED")], {}, SAMPLE_ENTRY);
    if (trustedFill.kind !== "filled") {
      throw new Error(`expected a fill, got ${trustedFill.kind}`);
    }
    const trustedPdf = await PDFDocument.load(trustedFill.outcome.bytes);
    expect(trustedPdf.getForm().getCheckBox("mail_consent").isChecked()).toBe(true);
    expect(trustedFill.outcome.toResolve.map((item) => item.fieldName)).not.toContain("mail_consent");
  });

  it("keeps the review's own not-applicable states: blank and not to-resolve", async () => {
    // The server's skip decision rides the payload (the review renders it
    // "Not needed for you"); the fill honors it without re-deriving skip
    // logic from values the client can't see.
    const fields: readonly ReviewFillField[] = payloadViews(SAMPLE_ENTRY, {
      household_size: { status: "known", value: 3 },
    }).map((field) =>
      field.fieldName === "monthly_rent_amount"
        ? { ...field, state: "not_applicable" as const }
        : field,
    );
    const result = await fillReviewOnDevice(SAMPLE_BYTES(), fields, {}, SAMPLE_ENTRY);
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    expect(pdf.getForm().getTextField("monthly_rent_amount").getText() ?? "").toBe("");
    const toResolve = result.outcome.toResolve.map((item) => item.fieldName);
    expect(toResolve).not.toContain("monthly_rent_amount");
  });

  it("fills the real form's client-held values field for field, never its private ones", async () => {
    // The real template, the real registry: the non-private answers fill
    // exactly as the server's fill of the same answers would (the display
    // vocabulary is the review payload's own), and the vault-held answers
    // (date of birth, phone, county — the entry's allowlist) stay blank.
    const fields = payloadViews(REAL_ENTRY, {
      state: { status: "known", value: "NC" },
      job_income_amount: { status: "known", value: 1500 },
      date_of_birth: { status: "known", value: "1979-07-08" },
      phone_contact: { status: "known", value: "704-555-0110" },
      county: { status: "known", value: "Mecklenburg" },
    });
    const result = await fillReviewOnDevice(REAL_BYTES(), fields, {}, REAL_ENTRY);
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    const form = pdf.getForm();
    expect(form.getTextField("5 State").getText()).toBe("North Carolina");
    expect(form.getTextField("undefined_10").getText()).toBe("1500");
    expect(form.getTextField("3 Date of Birth mmddyyyy").getText() ?? "").toBe("");
    expect(form.getTextField("14 Phone Number").getText() ?? "").toBe("");
    expect(form.getTextField("7 County").getText() ?? "").toBe("");
  });
});

describe("fillReviewOnDevice — the answers typed into the review", () => {
  it("fills a checkbox draft only for the words checked and unchecked, in any casing", async () => {
    // The sample entry has no unmapped checkbox; the real form's
    // employment checkboxes are unmapped — use the real template.
    const realFields = payloadViews(REAL_ENTRY, {});
    const real = await fillReviewOnDevice(REAL_BYTES(), realFields, {
      Employed_2: "  CHECKED ",
    }, REAL_ENTRY);
    if (real.kind !== "filled") {
      throw new Error(`expected a fill, got ${real.kind}`);
    }
    const pdf = await PDFDocument.load(real.outcome.bytes);
    expect(pdf.getForm().getCheckBox("Employed_2").isChecked()).toBe(true);
    expect(real.outcome.filled.map((item) => item.fieldName)).toContain("Employed_2");
    // A checkbox word fills; the field is not to-resolve.
    expect(real.outcome.toResolve.map((item) => item.fieldName)).not.toContain("Employed_2");
  });

  it("names a box answer typed in any other word, and fills nothing", async () => {
    // "yes" would print an unchecked box with no word to the person (the
    // step-by-step path fixed this in device-form.ts) — here it is named
    // back before anything is filled.
    const realFields = payloadViews(REAL_ENTRY, {});
    const real = await fillReviewOnDevice(REAL_BYTES(), realFields, {
      Employed_2: "yes",
    }, REAL_ENTRY);
    expect(real.kind).toBe("unreadable_boxes");
    if (real.kind === "unreadable_boxes") {
      expect(real.fields).toEqual(["Employed_2"]);
    }
  });

  it("leaves a blank draft no answer: the field stays blank and to-resolve", async () => {
    const fields = payloadViews(SAMPLE_ENTRY, {
      household_size: { status: "known", value: 3 },
    });
    const result = await fillReviewOnDevice(SAMPLE_BYTES(), fields, {
      applicant_name: "   ",
    }, SAMPLE_ENTRY);
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    expect(pdf.getForm().getTextField("applicant_name").getText() ?? "").toBe("");
    expect(result.outcome.toResolve.map((item) => item.fieldName)).toContain("applicant_name");
  });

  it("refuses an in-request answer for a spec-mapped field (answers live in the stores)", async () => {
    const fields = payloadViews(SAMPLE_ENTRY, {
      household_size: { status: "known", value: 3 },
    });
    const result = await fillReviewOnDevice(SAMPLE_BYTES(), fields, {
      household_size_count: "17",
    }, SAMPLE_ENTRY);
    expect(result.kind).toBe("invalid_answers");
  });

  it("refuses an oversized draft", async () => {
    const fields = payloadViews(SAMPLE_ENTRY, {
      household_size: { status: "known", value: 3 },
    });
    const result = await fillReviewOnDevice(SAMPLE_BYTES(), fields, {
      applicant_name: "A".repeat(201),
    }, SAMPLE_ENTRY);
    expect(result.kind).toBe("invalid_answers");
  });
});

describe("fillReviewOnDevice — the template", () => {
  it("fills nothing when the blank form can't be opened", async () => {
    const fields = payloadViews(SAMPLE_ENTRY, {
      household_size: { status: "known", value: 3 },
    });
    const result = await fillReviewOnDevice(
      new Uint8Array(0),
      fields,
      {},
      SAMPLE_ENTRY,
    );
    expect(result.kind).toBe("unreadable_form");
  });
});

describe("the browser fill's invariants (property)", () => {
  it("fills exactly the client-held values — every held value reads back, every private field stays blank", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.integer({ min: 1, max: 15 }), { nil: undefined }),
        fc.option(fc.integer({ min: 100, max: 4000 }), { nil: undefined }),
        fc.option(fc.constant("1990-01-01"), { nil: undefined }),
        fc.option(fc.constant("704-555-0110"), { nil: undefined }),
        fc.option(fc.stringMatching(/^[\x20-\x7E]{1,40}$/), { nil: undefined }),
        fc.constantFrom("user_supplied", "ai_drafted", "source_verified", "tax_return", "user"),
        async (householdSize, housingCost, dateOfBirth, phone, nameDraft, provenance) => {
          // The review payload, built exactly as the review route builds
          // it: the answers below, private ones valueless in the view.
          const answers: Record<string, StoredAnswer> = {};
          if (householdSize !== undefined) {
            answers.household_size = { status: "known", value: householdSize, provenance };
          }
          if (housingCost !== undefined) {
            answers.housing_cost = { status: "known", value: housingCost, provenance };
          }
          if (dateOfBirth !== undefined) {
            answers.date_of_birth = { status: "known", value: dateOfBirth, provenance };
          }
          if (phone !== undefined) {
            answers.phone_contact = { status: "known", value: phone, provenance };
          }
          const fields = payloadViews(SAMPLE_ENTRY, answers);
          const drafts: Record<string, string> =
            nameDraft !== undefined ? { applicant_name: nameDraft } : {};
          const result = await fillReviewOnDevice(SAMPLE_BYTES(), fields, drafts, SAMPLE_ENTRY);
          if (result.kind !== "filled") {
            throw new Error(`expected a fill, got ${result.kind}`);
          }
          const pdf = await PDFDocument.load(result.outcome.bytes);
          const form = pdf.getForm();
          const filled = new Map(
            result.outcome.filled.map((item) => [item.fieldName, item.provenance]),
          );
          const toResolve = new Set(result.outcome.toResolve.map((item) => item.fieldName));

          // A held value fills and reads back exactly what the review
          // shows, under its own provenance.
          if (householdSize !== undefined) {
            expect(form.getTextField("household_size_count").getText()).toBe(
              String(householdSize),
            );
            expect(filled.get("household_size_count")).toBe(provenance);
            expect(toResolve.has("household_size_count")).toBe(false);
          } else {
            expect(form.getTextField("household_size_count").getText() ?? "").toBe("");
            expect(filled.has("household_size_count")).toBe(false);
            expect(toResolve.has("household_size_count")).toBe(true);
          }
          if (housingCost !== undefined) {
            expect(form.getTextField("monthly_rent_amount").getText()).toBe(
              String(housingCost),
            );
          } else {
            expect(form.getTextField("monthly_rent_amount").getText() ?? "").toBe("");
            expect(toResolve.has("monthly_rent_amount")).toBe(true);
          }

          // THE INVARIANT THE FIX EXISTS FOR: the private answers are
          // known on the server — sometimes with provenance and a value —
          // yet the page holds none of them, so they never fill. Blank on
          // the file, and named for the person to finish by hand.
          const privateFields = [
            "applicant_date_of_birth",
            "contact_phone",
            "housing_situation",
            "contact_email",
            "mail_consent",
            "id_problem_explanation",
          ];
          for (const name of privateFields) {
            expect(filled.has(name), name).toBe(false);
            expect(toResolve.has(name), name).toBe(true);
          }

          // The typed draft fills as typed; absent or blank after
          // trimming (the fill's no-answer rule), blank + to-resolve.
          if (nameDraft !== undefined && nameDraft.trim() !== "") {
            expect(form.getTextField("applicant_name").getText()).toBe(nameDraft.trim());
          } else {
            expect(form.getTextField("applicant_name").getText() ?? "").toBe("");
            expect(toResolve.has("applicant_name")).toBe(true);
          }

          // And no field the review marks not-applicable is ever filled
          // or to-resolve (the payload's own states are the decision).
          for (const field of fields) {
            if (field.state === "not_applicable") {
              expect(filled.has(field.fieldName), field.fieldName).toBe(false);
              expect(toResolve.has(field.fieldName), field.fieldName).toBe(false);
            }
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
