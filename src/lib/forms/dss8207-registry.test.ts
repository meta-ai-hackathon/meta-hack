import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assertLoadablePdf, discoverAcroFormFields } from "./parse";
import { QUESTION_BY_ID } from "../intake/spec";
import { setLogSink } from "../telemetry";
import registryJson from "../../../kb/forms/dss-8207.json";

// The second real form (the DSS-8207 registry round, Nov 2026): the
// committed DSS-8207 "Application for Food and Nutrition Services" bytes
// parse honestly, and the registry entry covers EVERY named field the
// template carries — each with its disposition, reason (when unmapped),
// and conflict-group data. This file sits inside src/lib/forms where the
// pilot-name scan runs, so program names appear only via the registry
// entry's own sanctioned data, never spelled here.

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const REAL_FORM_PATH = path.join(FIXTURES, "dss-8207-fns-app-10-2024.pdf");
const realBytes = () => new Uint8Array(readFileSync(REAL_FORM_PATH));

interface RawField {
  readonly name: string;
  readonly type: string;
  readonly label: string;
  readonly question: string;
  readonly spec_question_id: string | null;
  readonly disposition: string;
  readonly disposition_reason?: string;
  readonly pii_likely: boolean;
  readonly required: boolean;
  readonly pages: readonly number[];
  readonly export_value?: string;
  readonly export_values?: { readonly yes: string; readonly no: string };
  readonly conflict_group?: { readonly id: string; readonly kind: string };
}

const registry = registryJson as unknown as {
  id: string;
  version: string;
  kind: string;
  source: { url: string; retrieved_at: string; origin: string };
  pdf_path: string;
  vault_field_allowlist: readonly string[];
  fields: readonly RawField[];
};

const registryFieldNames = new Set(registry.fields.map((field) => field.name));

/**
 * The form's one digital-signature widget: the app-side discovery walks
 * only the five fillable kinds, so it is the exactly-one field the
 * registry carries beyond the discovered set (dispositioned
 * not_collected_by_interview — the person signs the printed form by hand).
 */
const SIGNATURE_WIDGET_NAME = "Your Signature or Authorized Representative";

beforeAll(() => {
  setLogSink(() => undefined);
});

describe("the committed DSS-8207 template bytes", () => {
  it("load as a 10-page AcroForm without encryption or XFA", async () => {
    const pdf = await assertLoadablePdf(realBytes());
    expect(pdf.isEncrypted).toBe(false);
    expect(pdf.getPageCount()).toBe(10);
    expect(registry.kind).toBe("acroform");
  });

  it("discovers 600 widget-level fields across 574 named fields", async () => {
    // pypdf's page-annotation walk sees 601 widgets across 575 named
    // fields (docs/dss8207-field-inventory.md reconciles the two views);
    // the app's discovery pass skips the one digital-signature widget.
    const discovered = discoverAcroFormFields(await assertLoadablePdf(realBytes()));
    expect(discovered.length).toBe(600);
    expect(new Set(discovered.map((field) => field.name)).size).toBe(574);
  });
});

describe("the dss-8207 registry entry", () => {
  it("carries the official source, retrieval date, and version", () => {
    expect(registry.id).toBe("dss-8207");
    expect(registry.source.url).toBe(
      "https://policies.ncdhhs.gov/wp-content/uploads/DSS-8207-FNS-App_10.2024.pdf",
    );
    expect(registry.source.retrieved_at).toBe("2026-11-01");
    expect(registry.source.origin).toBe("official_source");
    expect(registry.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("covers exactly the template's 575 named fields", async () => {
    expect(registry.fields.length).toBe(575);
    expect(registryFieldNames.size).toBe(575);
    const discovered = discoverAcroFormFields(await assertLoadablePdf(realBytes()));
    const discoveredNames = new Set(discovered.map((field) => field.name));
    for (const name of discoveredNames) {
      expect(registryFieldNames.has(name), `registry misses ${name}`).toBe(true);
    }
    // The registry's exactly-one extra field is the digital-signature
    // widget, carried with its not-collected story.
    const extras = registry.fields.filter(
      (field) => !discoveredNames.has(field.name),
    );
    expect(extras.map((field) => field.name)).toEqual([SIGNATURE_WIDGET_NAME]);
    expect(extras[0]!.disposition).toBe("not_collected_by_interview");
    expect(extras[0]!.disposition_reason).toBeTruthy();
  });

  it("agrees with the discovery pass on every field's kind and pages", async () => {
    const discovered = discoverAcroFormFields(await assertLoadablePdf(realBytes()));
    const byName = new Map(registry.fields.map((field) => [field.name, field]));
    for (const widget of discovered) {
      const field = byName.get(widget.name)!;
      expect(field, widget.name).toBeDefined();
      expect(field.type, `${widget.name} kind`).toBe(widget.kind);
      expect(
        field.pages.includes(widget.page),
        `${widget.name} page ${widget.page}`,
      ).toBe(true);
    }
  });

  it("dispositions every field, with a reason on every unmapped one", () => {
    const counts = new Map<string, number>();
    for (const field of registry.fields) {
      counts.set(field.disposition, (counts.get(field.disposition) ?? 0) + 1);
      if (field.disposition !== "mapped") {
        expect(
          field.disposition_reason,
          `${field.name} carries no reason`,
        ).toBeTruthy();
      } else {
        expect(field.spec_question_id === null || QUESTION_BY_ID[field.spec_question_id]).toBeDefined();
      }
    }
    // The reviewed arithmetic: 525 mapped + 32 optional + 5 not-collected
    // + 2 agency-use + 11 structural = 575.
    expect(counts.get("mapped")).toBe(525);
    expect(counts.get("optional_unanswered")).toBe(32);
    expect(counts.get("not_collected_by_interview")).toBe(5);
    expect(counts.get("agency_use_only")).toBe(2);
    expect(counts.get("duplicate_structural")).toBe(11);
  });

  it("links the spec questions the interview collects, allowlisted for the vault", () => {
    const links = registry.fields
      .filter((field) => field.spec_question_id !== null)
      .map((field) => field.spec_question_id as string);
    // Every link resolves to a real spec question; the PII links sit on
    // the entry's vault fill allowlist (the fill reads them through it);
    // non-pii links (state, costs, booleans) come from the answer table.
    expect(new Set(links).size).toBe(links.length);
    for (const id of links) {
      expect(QUESTION_BY_ID[id], id).toBeDefined();
      if (QUESTION_BY_ID[id]!.pii) {
        expect(registry.vault_field_allowlist, id).toContain(id);
      }
    }
    expect([...new Set(links)].sort()).toEqual([
      "date_of_birth",
      "email_contact",
      "housing_cost",
      "phone_contact",
      "received_benefits_before",
      "state",
      "utilities_cost",
      "veteran_status",
    ]);
    expect([...registry.vault_field_allowlist].sort()).toEqual([
      "date_of_birth",
      "email_contact",
      "phone_contact",
    ]);
  });

  it("carries conflict groups on the yes/no pairs and the check-one group", () => {
    const groups = new Map<string, { kind: string; members: string[] }>();
    for (const field of registry.fields) {
      const group = field.conflict_group;
      if (group === undefined) {
        continue;
      }
      const entry = groups.get(group.id) ?? { kind: group.kind, members: [] };
      entry.members.push(field.name);
      groups.set(group.id, entry);
    }
    // Eleven printed Yes/No checkbox pairs plus the check-one
    // living-situation group; check-all-that-apply lists carry NO group
    // (pinned below).
    expect(groups.size).toBe(12);
    for (const [id, { kind, members }] of groups) {
      if (kind === "yes_no") {
        expect(members.length, id).toBe(2);
      } else {
        expect(kind, id).toBe("single_choice");
        expect(members.length, id).toBeGreaterThanOrEqual(2);
      }
      for (const member of members) {
        const field = registry.fields.find((f) => f.name === member)!;
        expect(field.disposition, member).toBe("mapped");
        expect(field.type, member).toBe("checkbox");
        expect(field.export_value, member).toBeTruthy();
      }
    }
  });

  it("leaves check-all-that-apply lists without a conflict group", () => {
    // The situations checklist, the other-money checklist, and the utility
    // list are check-all-that-apply — their boxes carry no group.
    const grouped = new Set(
      registry.fields
        .filter((field) => field.conflict_group !== undefined)
        .map((field) => field.name),
    );
    for (const name of ["A veteran", "Alimony", "Electricity", "Social Security"]) {
      expect(grouped.has(name), `${name} must carry no group`).toBe(false);
    }
  });

  it("records the discovered radio export values", () => {
    const benefitsRadio = registry.fields.find(
      (field) => field.spec_question_id === "received_benefits_before",
    )!;
    expect(benefitsRadio.type).toBe("radio");
    expect(benefitsRadio.export_values?.yes).toMatch(/^Yes/);
    expect(benefitsRadio.export_values?.no).toMatch(/^No/);
    // Every radio field carries its discovered yes/no export pair.
    for (const field of registry.fields) {
      if (field.type === "radio") {
        expect(field.export_values?.yes, field.name).toBeTruthy();
        expect(field.export_values?.no, field.name).toBeTruthy();
      }
      if (field.type === "checkbox") {
        expect(field.export_value, field.name).toBeTruthy();
      }
    }
  });
});
