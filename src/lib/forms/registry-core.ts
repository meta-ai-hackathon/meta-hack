import { PII_QUESTION_IDS_IN_SPEC, QUESTION_BY_ID } from "../intake/spec";
import acroformEntryJson from "../../../kb/forms/sample-form-acroform.json";
import flatEntryJson from "../../../kb/forms/sample-form-flat.json";
import dhb5200EntryJson from "../../../kb/forms/dhb-5200.json";

// The browser-safe half of the form registry (HACK-115): the entry shapes,
// their runtime validation, and the committed entries' data. Nothing here
// reads the filesystem or touches telemetry, so the step-by-step page can
// review and fill the registered form on the device. registry.ts builds its
// entries from this same data and validation, raises its taxonomy error on
// a malformed entry, and keeps the server-only template read.
//
// The vault fill allowlist lives ON the entry: it is the explicit per-form
// permit the fill passes to readVaultFields (VAL-PDF-006), committed so the
// exact set of vault fields a form may read is reviewable in git.

export type FormFieldKind = "text" | "checkbox" | "dropdown" | "radio" | "optionlist";

/**
 * Every field's explicit disposition (full-form mapping, VAL-FIX-007):
 * "mapped" fields take a person answer (spec-mapped, or asked in the
 * flow/review and sent with the fill request); every other disposition is
 * an honest, reviewed reason the pipeline leaves the field blank.
 */
export type FormFieldDisposition =
  | "mapped"
  | "not_collected_by_interview"
  | "optional_unanswered"
  | "agency_use_only"
  | "duplicate_structural";

const DISPOSITIONS: readonly FormFieldDisposition[] = [
  "mapped",
  "not_collected_by_interview",
  "optional_unanswered",
  "agency_use_only",
  "duplicate_structural",
];

/** A yes/no radio pair's discovered export values (the checked/unchecked states). */
export interface RadioExportValues {
  readonly yes: string;
  readonly no: string;
}

/**
 * Mutually exclusive checkbox group membership (full-form proof,
 * VAL-FIX-007): kind "yes_no" marks one printed question's two independent
 * Yes/No boxes; kind "single_choice" marks a check-one group (work status,
 * pay frequency, renewal term). The fill-time consistency check flags a
 * value set that checks two members of one group — it never silently picks
 * a side.
 */
export type ConflictGroupKind = "yes_no" | "single_choice";

export interface ConflictGroup {
  readonly id: string;
  readonly kind: ConflictGroupKind;
}

export interface AnswerBox {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly maxWidth?: number;
}

export interface FormRegistryField {
  readonly name: string;
  readonly type: FormFieldKind;
  /** Nearby label text as printed on the form. */
  readonly label: string;
  /** The reviewed plain-language question this field asks. */
  readonly question: string;
  /** Spec question this field pre-fills from; null when the spec doesn't ask it. */
  readonly specQuestionId: string | null;
  /**
   * Optional printed-date format for a mapped date question (e.g.
   * "mm/dd/yyyy" on the DHB-5200): ISO date answers render in the format
   * the form itself prints, so the person hands the agency a legible date.
   */
  readonly displayFormat?: string;
  /** The field's reviewed disposition (every field carries exactly one). */
  readonly disposition: FormFieldDisposition;
  /**
   * The honest per-field reason a non-mapped disposition leaves the field
   * blank (required whenever disposition is not "mapped").
   */
  readonly dispositionReason?: string;
  /**
   * A mapped checkbox's on-state export value (the "true" side) as
   * discovered in the template.
   */
  readonly exportValue?: string;
  /** A mapped yes/no radio pair's discovered export values. */
  readonly exportValues?: RadioExportValues;
  /** The mapped checkbox's mutually exclusive group, when it has one. */
  readonly conflictGroup?: ConflictGroup;
  /** Identity-like data: value is sensitive-by-default (omitted from client views). */
  readonly piiLikely: boolean;
  readonly required: boolean;
  readonly pages: readonly number[];
  /** Flat-variant drawText coordinates (absent on acroform entries). */
  readonly answerBox?: AnswerBox;
}

export interface FormRegistrySource {
  readonly url: string;
  readonly retrievedAt: string;
  readonly origin: "generated_fixture" | "official_source";
  readonly generator?: string;
}

export interface FormRegistryEntry {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly kind: "acroform" | "flat";
  readonly program: string;
  readonly source: FormRegistrySource;
  readonly pdfPath: string;
  /**
   * The ONLY vault fields a fill of this form may read (VAL-PDF-006): the
   * pii fields it fills from, plus any pii value its conditional fields'
   * skip logic needs (e.g. mailing_situation gates the mail-consent box).
   */
  readonly vaultFieldAllowlist: readonly string[];
  readonly fields: readonly FormRegistryField[];
}

/**
 * The error a malformed entry raises, given what failed. Registry entries
 * are committed, reviewed artifacts, so a malformed one is a build or test
 * failure; the server raises its taxonomy error with generic copy.
 */
export type RegistryEntryFailure = (detail: string) => Error;

const FIELD_KINDS: readonly FormFieldKind[] = [
  "text",
  "checkbox",
  "dropdown",
  "radio",
  "optionlist",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime validation mirroring kb/forms/schema.json (pytest is the other half). */
export function parseRegistryEntry(
  raw: unknown,
  registryError: RegistryEntryFailure,
): FormRegistryEntry {
  if (!isRecord(raw)) {
    throw registryError("entry is not an object");
  }
  const string = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || value === "") {
      throw registryError(`entry.${key} must be a non-empty string`);
    }
    return value;
  };
  const kind = raw.kind;
  if (kind !== "acroform" && kind !== "flat") {
    throw registryError("entry.kind must be acroform or flat");
  }
  const source = raw.source;
  if (!isRecord(source) || typeof source.url !== "string" || typeof source.retrieved_at !== "string") {
    throw registryError("entry.source must carry url + retrieved_at (BN-27)");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(source.retrieved_at)) {
    throw registryError("entry.source.retrieved_at must be YYYY-MM-DD");
  }
  const allowlist = raw.vault_field_allowlist;
  if (!Array.isArray(allowlist) || !allowlist.every((f) => typeof f === "string")) {
    throw registryError("entry.vault_field_allowlist must be a string list");
  }
  if (!Array.isArray(raw.fields) || raw.fields.length === 0) {
    throw registryError("entry.fields must be a non-empty list");
  }
  const fields: FormRegistryField[] = raw.fields.map((item, index) => {
    if (!isRecord(item)) {
      throw registryError(`entry.fields[${index}] is not an object`);
    }
    const type = item.type;
    if (typeof type !== "string" || !FIELD_KINDS.includes(type as FormFieldKind)) {
      throw registryError(`entry.fields[${index}].type is not a field kind`);
    }
    const specQuestionId = item.spec_question_id;
    if (specQuestionId !== null && typeof specQuestionId !== "string") {
      throw registryError(`entry.fields[${index}].spec_question_id must be a string or null`);
    }
    const displayFormat = item.display_format;
    if (
      displayFormat !== undefined &&
      displayFormat !== null &&
      (typeof displayFormat !== "string" || displayFormat.trim() === "")
    ) {
      throw registryError(`entry.fields[${index}].display_format must be a non-empty string`);
    }
    const disposition = item.disposition;
    if (
      typeof disposition !== "string" ||
      !DISPOSITIONS.includes(disposition as FormFieldDisposition)
    ) {
      throw registryError(`entry.fields[${index}].disposition is not a disposition`);
    }
    const dispositionReason = item.disposition_reason;
    if (
      dispositionReason !== undefined &&
      dispositionReason !== null &&
      (typeof dispositionReason !== "string" || dispositionReason.trim() === "")
    ) {
      throw registryError(
        `entry.fields[${index}].disposition_reason must be a non-empty string`,
      );
    }
    if (disposition !== "mapped" && typeof dispositionReason !== "string") {
      // A non-mapped disposition without its reason is not reviewable —
      // the whole point of the disposition is the honest why.
      throw registryError(
        `entry.fields[${index}] carries disposition ${disposition} without a disposition_reason`,
      );
    }
    const exportValue = item.export_value;
    if (
      exportValue !== undefined &&
      exportValue !== null &&
      (typeof exportValue !== "string" || exportValue.trim() === "")
    ) {
      throw registryError(`entry.fields[${index}].export_value must be a non-empty string`);
    }
    const exportValuesRaw = item.export_values;
    let exportValues: RadioExportValues | undefined;
    if (exportValuesRaw !== undefined && exportValuesRaw !== null) {
      if (
        !isRecord(exportValuesRaw) ||
        typeof exportValuesRaw.yes !== "string" ||
        exportValuesRaw.yes.trim() === "" ||
        typeof exportValuesRaw.no !== "string" ||
        exportValuesRaw.no.trim() === ""
      ) {
        throw registryError(
          `entry.fields[${index}].export_values must carry non-empty yes/no export values`,
        );
      }
      exportValues = { yes: exportValuesRaw.yes, no: exportValuesRaw.no };
    }
    const conflictGroupRaw = item.conflict_group;
    let conflictGroup: ConflictGroup | undefined;
    if (conflictGroupRaw !== undefined && conflictGroupRaw !== null) {
      if (
        !isRecord(conflictGroupRaw) ||
        typeof conflictGroupRaw.id !== "string" ||
        conflictGroupRaw.id.trim() === "" ||
        (conflictGroupRaw.kind !== "yes_no" &&
          conflictGroupRaw.kind !== "single_choice")
      ) {
        throw registryError(
          `entry.fields[${index}].conflict_group must carry a non-empty id and kind (yes_no | single_choice)`,
        );
      }
      conflictGroup = {
        id: conflictGroupRaw.id,
        kind: conflictGroupRaw.kind as ConflictGroupKind,
      };
    }
    const pages = item.pages;
    if (
      !Array.isArray(pages) ||
      pages.length === 0 ||
      !pages.every((p) => typeof p === "number" && Number.isInteger(p) && p >= 1)
    ) {
      throw registryError(`entry.fields[${index}].pages must be 1-based page numbers`);
    }
    const boxRaw = item.answer_box;
    let answerBox: AnswerBox | undefined;
    if (boxRaw !== undefined && boxRaw !== null) {
      if (!isRecord(boxRaw) || typeof boxRaw.page !== "number" || typeof boxRaw.x !== "number" || typeof boxRaw.y !== "number") {
        throw registryError(`entry.fields[${index}].answer_box must carry page/x/y`);
      }
      answerBox = {
        page: boxRaw.page,
        x: boxRaw.x,
        y: boxRaw.y,
        ...(typeof boxRaw.max_width === "number" ? { maxWidth: boxRaw.max_width } : {}),
      };
    }
    return {
      name: String(item.name ?? ""),
      type: type as FormFieldKind,
      label: String(item.label ?? ""),
      question: String(item.question ?? ""),
      specQuestionId,
      piiLikely: item.pii_likely === true,
      required: item.required === true,
      pages: pages as readonly number[],
      ...(typeof displayFormat === "string" && displayFormat.trim() !== ""
        ? { displayFormat: displayFormat.trim() }
        : {}),
      ...(answerBox ? { answerBox } : {}),
      disposition: disposition as FormFieldDisposition,
      ...(typeof dispositionReason === "string" && dispositionReason.trim() !== ""
        ? { dispositionReason: dispositionReason.trim() }
        : {}),
      ...(typeof exportValue === "string" && exportValue.trim() !== ""
        ? { exportValue: exportValue.trim() }
        : {}),
      ...(exportValues ? { exportValues } : {}),
      ...(conflictGroup ? { conflictGroup } : {}),
    };
  });
  return {
    id: string("id"),
    title: string("title"),
    version: string("version"),
    kind,
    program: string("program"),
    source: {
      url: source.url,
      retrievedAt: source.retrieved_at,
      origin: source.origin === "official_source" ? "official_source" : "generated_fixture",
      ...(typeof source.generator === "string" ? { generator: source.generator } : {}),
    },
    pdfPath: string("pdf_path"),
    vaultFieldAllowlist: allowlist as readonly string[],
    fields,
  };
}

/** Cross-check an entry against the question spec (the pytest mirror runs on CI too). */
export function assertRegistryEntryConsistent(
  entry: FormRegistryEntry,
  registryError: RegistryEntryFailure,
): FormRegistryEntry {
  const allowlist = new Set(entry.vaultFieldAllowlist);
  for (const field of entry.fields) {
    if (field.specQuestionId === null) {
      continue;
    }
    if (!Object.hasOwn(QUESTION_BY_ID, field.specQuestionId)) {
      throw registryError(`${entry.id}: field ${field.name} maps to unknown question`);
    }
    const isPii = PII_QUESTION_IDS_IN_SPEC.includes(field.specQuestionId);
    if (isPii && !allowlist.has(field.specQuestionId)) {
      throw registryError(
        `${entry.id}: field ${field.name} maps a pii question missing from the allowlist`,
      );
    }
  }
  for (const vaultField of entry.vaultFieldAllowlist) {
    if (!PII_QUESTION_IDS_IN_SPEC.includes(vaultField)) {
      throw registryError(`${entry.id}: allowlist names non-pii field ${vaultField}`);
    }
  }
  return entry;
}

const COMMITTED_ENTRY_DATA: readonly unknown[] = [
  acroformEntryJson,
  flatEntryJson,
  // The real pilot form (HACK-16 Done, mission v2.1 M6): an OFFICIAL source
  // entry — the state's published application as-is, parsed honestly. Its
  // registry subset is re-verified field-by-field against the committed
  // bytes by the dhb5200-registry test suite.
  dhb5200EntryJson,
];

/**
 * Every committed registry entry, validated and cross-checked against the
 * question spec, in load order. A malformed entry raises `registryError`.
 */
export function parseCommittedRegistryEntries(
  registryError: RegistryEntryFailure,
): readonly FormRegistryEntry[] {
  return COMMITTED_ENTRY_DATA.map((raw) =>
    assertRegistryEntryConsistent(parseRegistryEntry(raw, registryError), registryError),
  );
}
