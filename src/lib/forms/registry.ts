import { readFileSync } from "node:fs";
import path from "node:path";
import { AppError } from "../telemetry";
import { parseCommittedRegistryEntries, type FormRegistryEntry } from "./registry-core";

// Form registry (Mission v2 M4 / HACK-74, BN-27 discipline): the reviewed,
// committed description of every application form the pipeline can fill.
// Entries are data files under kb/forms/ (schema-validated in pytest, and
// cross-checked against the question spec), loaded here for the app to
// consume read-only. A parse run proposes an entry; a person reviews and
// commits it — the LLM-assisted mapping never drives the fill directly.
//
// The entry shapes, their validation, and the committed data live in
// registry-core.ts, which the step-by-step page also uses on the device
// (HACK-115); the types are re-exported here unchanged. This module keeps
// the server-only half: the taxonomy errors and the template read.
export type {
  AnswerBox,
  FormFieldKind,
  FormRegistryEntry,
  FormRegistryField,
  FormRegistrySource,
} from "./registry-core";

function registryError(detail: string): AppError {
  // Registry entries are committed, reviewed artifacts: a malformed one is a
  // build/test failure, and the surfaced message stays generic.
  return new AppError("internal", "The form registry entry failed validation.", {
    cause: { detail },
  });
}

const COMMITTED_ENTRIES: readonly FormRegistryEntry[] =
  parseCommittedRegistryEntries(registryError);

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
