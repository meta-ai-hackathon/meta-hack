import { getDb } from "./db";
import { AppError, logInfo, PII_QUESTION_IDS } from "./telemetry";

// PII vault (BN-03 / HACK-31): the secure storage layer for everything the
// question spec marks `pii: true`. Identity details never enter prompts,
// logs, client payloads, or error messages.
//
// Module contract (enforced by src/lib/vault-boundary.test.ts):
// - This is the ONLY module under src/ allowed to touch the vault_entry
//   table (migrations/0002_vault_entry.sql creates it).
// - Writes go through vaultPut; the only read path is readVaultFields.
// - readVaultFields is the boundary future prompt builders must consume:
//   it serves ONLY fields on CROSSING_ALLOWLIST and throws a taxonomy
//   error for everything else, loudly.
//
// Logging discipline: vault events are logged with no identifying fields —
// pii field ids are themselves identifying content (VAL-TEL-002), and
// values never.

/**
 * Fields the vault may store: exactly the question ids marked `pii: true`
 * in specs/question-spec/generic-questions.json. Non-PII answers belong in
 * the ordinary `answer` table, not the vault. Kept in lockstep with the
 * spec by test (same pattern as telemetry's PII_QUESTION_IDS, which this
 * list re-exports under the vault's domain name).
 */
export const VAULT_FIELDS: readonly string[] = PII_QUESTION_IDS;

/**
 * The fields the product explicitly permits ACROSS the vault boundary into
 * model context. Empty today: pii:true fields are vault-only by rule, and
 * no product decision has let anything else cross. Fail-closed by design —
 * adding a field here is a deliberate product decision: it must not be
 * pii:true (vault-only), and the boundary tests enforce that either way.
 */
export const CROSSING_ALLOWLIST: readonly string[] = [];

/** Result of checking a read request against the crossing allowlist. */
export interface VaultCrossingDecision {
  allowed: readonly string[];
  rejected: readonly string[];
}

/**
 * Pure boundary decision: split a requested field list into fields the
 * allowlist permits across and fields it must reject. Exposed separately so
 * the decision logic is testable without a database.
 */
export function vaultCrossingDecision(
  requestedFields: readonly string[],
): VaultCrossingDecision {
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const field of requestedFields) {
    if (CROSSING_ALLOWLIST.includes(field)) {
      allowed.push(field);
    } else {
      rejected.push(field);
    }
  }
  return { allowed, rejected };
}

/**
 * Store a PII value for one field of one session. Accepts ONLY fields the
 * question spec marks `pii: true` — those are vault-only, so anything else
 * is a contract violation and throws a taxonomy error. Re-putting a field
 * updates the stored value (upsert), never a duplicate row.
 */
export async function vaultPut(
  sessionId: string,
  field: string,
  value: string,
): Promise<void> {
  if (!VAULT_FIELDS.includes(field)) {
    throw new AppError(
      "validation_error",
      "That field may not be stored in the PII vault.",
      { cause: { field } },
    );
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(
      "validation_error",
      "A vault value must be non-empty text.",
    );
  }
  const sql = getDb();
  await sql`
    INSERT INTO vault_entry (session_id, field, value)
    VALUES (${sessionId}, ${field}, ${value})
    ON CONFLICT (session_id, field)
    DO UPDATE SET value = EXCLUDED.value
  `;
  logInfo("vault_put");
}

/**
 * The vault read path, consumed by future prompt builders. Accepts ONLY
 * explicitly allowlisted fields (CROSSING_ALLOWLIST) and rejects every
 * other request — including any pii:true field — loudly with a taxonomy
 * error. The surfaced message stays generic; rejected field ids go only
 * into `cause`, which is never serialized to logs or responses.
 */
export async function readVaultFields(
  sessionId: string,
  requestedFields: readonly string[],
): Promise<Record<string, string>> {
  const { allowed, rejected } = vaultCrossingDecision(requestedFields);
  if (rejected.length > 0) {
    throw new AppError(
      "validation_error",
      "A requested field is not allowed to cross the PII vault boundary.",
      { cause: { rejectedFields: rejected } },
    );
  }
  if (allowed.length === 0) {
    return {};
  }
  const sql = getDb();
  const rows = await sql`
    SELECT field, value FROM vault_entry
    WHERE session_id = ${sessionId} AND field IN ${sql([...allowed])}
  `;
  logInfo("vault_read", { fieldCount: rows.length });
  const entries: Record<string, string> = {};
  for (const row of rows) {
    entries[String(row.field)] = String(row.value);
  }
  return entries;
}
