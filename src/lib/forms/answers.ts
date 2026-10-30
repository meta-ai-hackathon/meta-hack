import { getDb } from "../db";
import { AppError, logInfo } from "../telemetry";
import { isAnswerProvenance, type AnswerProvenance } from "../intake/store";
import type { FormRegistryEntry } from "./registry";

// Form-answer store (Mission v2 M4): persistence for answers to
// application-form questions that do NOT map to a question-spec id. Spec-
// mapped fields pre-fill from the ordinary answer table + the vault; these
// form-specific answers live in their own table (migrations/0004), keyed by
// the registry entry they belong to.
//
// Values here are sensitive-by-default: never logged (field ids included —
// the logging discipline is the vault's), and omitted from client views
// whenever the registry marks the field piiLikely. The fill reads them
// server-side and puts them into the returned PDF only.

const MAX_FORM_ANSWER_LENGTH = 2000;

export interface FormAnswerRecord {
  readonly fieldName: string;
  readonly value: string;
  readonly provenance: AnswerProvenance;
}

function validationError(detail?: string): AppError {
  return new AppError(
    "validation_error",
    "That answer can't be saved for this form.",
    { cause: detail ? { detail } : undefined },
  );
}

/**
 * Save (or update) one form-field answer for one registry entry. The field
 * must belong to the entry and the value must be bounded non-empty text.
 * Re-answering updates the row — never a duplicate.
 */
export async function saveFormAnswer(
  sessionId: string,
  entry: FormRegistryEntry,
  fieldName: string,
  value: string,
  provenance: AnswerProvenance = "user_supplied",
): Promise<void> {
  const field = entry.fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw validationError("unknown_field");
  }
  if (!isAnswerProvenance(provenance)) {
    throw validationError("bad_provenance");
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_FORM_ANSWER_LENGTH) {
    throw validationError("bad_value");
  }
  const sql = getDb();
  await sql`
    INSERT INTO form_answer (session_id, form_id, field_name, value, provenance)
    VALUES (${sessionId}, ${entry.id}, ${fieldName}, ${trimmed}, ${provenance})
    ON CONFLICT (session_id, form_id, field_name)
    DO UPDATE SET
      value = EXCLUDED.value,
      provenance = EXCLUDED.provenance,
      updated_at = now()
  `;
  // No field name, form id, or value in the log — identifying content stays
  // out of telemetry (the vault's discipline, VAL-TEL-002).
  logInfo("form_answer_saved");
}

/** Every stored form answer for one session + registry entry, by field name. */
export async function loadFormAnswers(
  sessionId: string,
  formId: string,
): Promise<Readonly<Record<string, FormAnswerRecord>>> {
  const sql = getDb();
  const rows = await sql`
    SELECT field_name, value, provenance
    FROM form_answer
    WHERE session_id = ${sessionId} AND form_id = ${formId}
  `;
  const records: Record<string, FormAnswerRecord> = {};
  for (const row of rows) {
    if (!isAnswerProvenance(row.provenance)) {
      continue;
    }
    records[String(row.field_name)] = {
      fieldName: String(row.field_name),
      value: String(row.value),
      provenance: row.provenance,
    };
  }
  return records;
}
