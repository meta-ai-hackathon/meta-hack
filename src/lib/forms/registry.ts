import { readFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "../telemetry";
import { PII_QUESTION_IDS_IN_SPEC, QUESTION_BY_ID } from "../intake/spec";
import acroformEntryJson from "../../../kb/forms/sample-form-acroform.json";
import flatEntryJson from "../../../kb/forms/sample-form-flat.json";
import dhb5200EntryJson from "../../../kb/forms/dhb-5200.json";

// Form registry (Mission v2 M4 / HACK-74, BN-27 discipline): the reviewed,
// committed description of every application form the pipeline can fill.
// Entries are data files under kb/forms/ (schema-validated in pytest, and
// cross-checked against the question spec), loaded here for the app to
// consume read-only. A parse run proposes an entry; a person reviews and
// commits it — the LLM-assisted mapping never drives the fill directly.
//
// The vault fill allowlist lives ON the entry: it is the explicit per-form
// permit the fill passes to readVaultFields (VAL-PDF-006), committed so the
// exact set of vault fields a form may read is reviewable in git.

export type FormFieldKind = "text" | "checkbox" | "dropdown" | "radio" | "optionlist";

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

const FIELD_KINDS: readonly FormFieldKind[] = [
  "text",
  "checkbox",
  "dropdown",
  "radio",
  "optionlist",
];

function registryError(detail: string): AppError {
  // Registry entries are committed, reviewed artifacts: a malformed one is a
  // build/test failure, and the surfaced message stays generic.
  return new AppError("internal", "The form registry entry failed validation.", {
    cause: { detail },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Runtime validation mirroring kb/forms/schema.json (pytest is the other half). */
function parseEntry(raw: unknown): FormRegistryEntry {
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
      ...(answerBox ? { answerBox } : {}),
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
function assertEntryConsistent(entry: FormRegistryEntry): FormRegistryEntry {
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

const COMMITTED_ENTRIES: readonly FormRegistryEntry[] = [
  assertEntryConsistent(parseEntry(acroformEntryJson)),
  assertEntryConsistent(parseEntry(flatEntryJson)),
  // The real pilot form (HACK-16 Done, mission v2.1 M6): an OFFICIAL source
  // entry — the state's published application as-is, parsed honestly. Its
  // registry subset is re-verified field-by-field against the committed
  // bytes by the dhb5200-registry test suite.
  assertEntryConsistent(parseEntry(dhb5200EntryJson)),
];

/** Every committed registry entry, in load order. */
export function formRegistryEntries(): readonly FormRegistryEntry[] {
  return COMMITTED_ENTRIES;
}

/** Look up one committed registry entry, or not_found for an unknown id. */
export function getFormRegistryEntry(formId: string): FormRegistryEntry {
  const entry = COMMITTED_ENTRIES.find((candidate) => candidate.id === formId);
  if (!entry) {
    throw new AppError(
      "not_found",
      "We don't have a form registered under that name.",
      { cause: { formId } },
    );
  }
  return entry;
}

/**
 * The committed template bytes for a registry entry — the fixture the
 * pipeline fills when the caller does not upload a template of their own
 * (the UI download path). Reading a COMMITTED template is not persistence:
 * the file is repo fixture data, carries no person data, and is never
 * written. Filled OUTPUT bytes never touch disk anywhere (VAL-PDF-005).
 */
export function loadTemplatePdf(entry: FormRegistryEntry): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path.join(process.cwd(), entry.pdfPath)));
  } catch {
    throw new AppError(
      "not_found",
      "We couldn't find a copy of that form. Try again in a moment.",
    );
  }
}
