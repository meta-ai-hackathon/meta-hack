import type postgres from "postgres";
import { getDb } from "./db";
import { AppError, logInfo, PII_QUESTION_IDS } from "./telemetry";
import {
  decryptVaultValue,
  encryptVaultValue,
  isVaultEnvelope,
  requireVaultKey,
} from "./vault-crypto";
import type { FormRegistryEntry } from "./forms/registry";

// PII vault (BN-03 / HACK-31): the secure storage layer for everything the
// question spec marks `pii: true`. Identity details never enter prompts,
// logs, client payloads, or error messages.
//
// Module contract (enforced by src/lib/vault-boundary.test.ts):
// - This is the ONLY module under src/ allowed to touch the vault_entry
//   table (migrations/0002_vault_entry.sql creates it).
// - Accessors, all validated against VAULT_FIELDS: writes go through
//   vaultPut; the delete-on-disavow path (BN-13) is vaultDelete; the
//   server-side flow read is vaultFlowValues; the crossing boundary future
//   prompt builders must consume is readVaultFields.
// - readVaultFields serves ONLY fields on CROSSING_ALLOWLIST and throws a
//   taxonomy error for everything else, loudly.
//
// Encryption at rest (VAL-VAULTENC-001, Mission v2.1 M5): every value is
// sealed app-side (AES-256-GCM, key from VAULT_ENC_KEY — see
// vault-crypto.ts for the envelope format and the bytea-vs-text storage
// decision) before it reaches Postgres, and decrypted ONLY here in the
// read paths. A missing or invalid key fails CLOSED with a taxonomy error
// — vaultPut writes nothing and no read path serves plaintext. There is no
// plaintext fallback, ever. Legacy rows written before this feature are
// re-encrypted in place on first read (see decryptedRowValues): a SQL
// migration can never encrypt them because the key must never enter the
// database, so encryption-on-read is the documented legacy choice.
//
// Logging discipline: vault events are logged with no identifying fields —
// pii field ids are themselves identifying content (VAL-TEL-002), and
// values never. The encryption key is never logged, echoed, or committed.

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
 * allowlists permit across and fields they must reject. Exposed separately so
 * the decision logic is testable without a database.
 *
 * Two allowlists, both deliberate product decisions recorded in code:
 * - CROSSING_ALLOWLIST — the global set of fields permitted into model
 *   context (empty today, and test-enforced never to hold a pii:true field).
 * - explicitAllowlist — an optional per-request permit. The ONLY runtime
 *   caller is readVaultFieldsForFill (the forms fill, Mission v2 M4), which
 *   derives it from the committed form-registry entry — the entry is the
 *   permit, so no code path can hand-read an arbitrary field list. A form
 *   may read exactly the vault fields its reviewed registry entry names,
 *   and nothing else. The permit only ever ADMITS vault fields — a
 *   non-vault field is rejected even if a form entry names it.
 *
 * Who can reach the vault: only a module that imports it at all, and the
 * boundary test (src/lib/vault-boundary.test.ts) admits exactly TWO such
 * modules — lib/intake/store.ts (prompt-facing, no permit parameter) and
 * lib/forms/fill.ts (fill-only, permit derived from the committed entry).
 * Any other module (a future prompt builder, a route) importing vault fails
 * CI, which is where a person reviews the new accessor before it can ever
 * run. The per-form lists themselves are committed, git-reviewed JSON —
 * not runtime-editable state — and every registry change is re-validated
 * against the spec on load (registry.ts) and by pytest.
 */
export function vaultCrossingDecision(
  requestedFields: readonly string[],
  explicitAllowlist: readonly string[] = [],
): VaultCrossingDecision {
  const permitted = new Set([
    ...CROSSING_ALLOWLIST,
    ...explicitAllowlist.filter((field) => VAULT_FIELDS.includes(field)),
  ]);
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const field of requestedFields) {
    if (permitted.has(field)) {
      allowed.push(field);
    } else {
      rejected.push(field);
    }
  }
  return { allowed, rejected };
}

/**
 * Map selected vault rows to their decrypted field values — the ONE place
 * stored values are unsealed (decrypt only inside vault.ts read paths).
 *
 * Ciphertext rows decrypt directly. Legacy plaintext rows (written before
 * VAL-VAULTENC-001) are recognized by shape, re-encrypted in place on
 * first read, and then served — the documented legacy choice: a SQL
 * migration cannot encrypt them because the key must never enter the
 * database, so encryption-on-read retires plaintext the moment the app
 * touches a row. The key is required BEFORE anything is served: a missing
 * or invalid key throws here and no value (encrypted or legacy plaintext)
 * ever leaves this function.
 *
 * Logging discipline: field ids and values never reach a log line.
 */
async function decryptedRowValues(
  sessionId: string,
  rows: readonly Record<string, unknown>[],
): Promise<Record<string, string>> {
  requireVaultKey();
  const sql = getDb();
  const entries: Record<string, string> = {};
  for (const row of rows) {
    const field = String(row.field);
    const stored = String(row.value);
    if (isVaultEnvelope(stored)) {
      entries[field] = decryptVaultValue(stored);
    } else {
      // Legacy plaintext row: seal it in place first (fail-closed on a
      // bad key — nothing is served), then serve the original value.
      const sealed = encryptVaultValue(stored);
      await sql`
        UPDATE vault_entry SET value = ${sealed}
        WHERE session_id = ${sessionId} AND field = ${field}
      `;
      logInfo("vault_legacy_reencrypted");
      entries[field] = stored;
    }
  }
  return entries;
}

/**
 * Store a PII value for one field of one session. Accepts ONLY fields the
 * question spec marks `pii: true` — those are vault-only, so anything else
 * is a contract violation and throws a taxonomy error. Re-putting a field
 * updates the stored value (upsert), never a duplicate row. The value is
 * encrypted (AES-256-GCM) before it reaches the database; a missing or
 * invalid key fails closed with a taxonomy error and nothing is written.
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
  // Fail closed BEFORE any write: without a usable key nothing is stored —
  // and certainly not the plaintext as a fallback.
  const sealed = encryptVaultValue(value);
  const sql = getDb();
  await sql`
    INSERT INTO vault_entry (session_id, field, value)
    VALUES (${sessionId}, ${field}, ${sealed})
    ON CONFLICT (session_id, field)
    DO UPDATE SET value = EXCLUDED.value
  `;
  logInfo("vault_put");
}

/**
 * Remove one field's stored value for one session — the delete-on-disavow
 * path (BN-13): when a person answers "I'm not sure" over an earlier
 * answer, the disavowed value must not linger in the vault. Accepts ONLY
 * fields the question spec marks pii:true, like every other vault accessor.
 * Idempotent: deleting an absent row deletes nothing.
 */
export async function vaultDelete(
  sessionId: string,
  field: string,
): Promise<void> {
  if (!VAULT_FIELDS.includes(field)) {
    throw new AppError(
      "validation_error",
      "That field may not be deleted from the PII vault.",
      { cause: { field } },
    );
  }
  const sql = getDb();
  await sql`
    DELETE FROM vault_entry
    WHERE session_id = ${sessionId} AND field = ${field}
  `;
  logInfo("vault_delete");
}

/**
 * Remove EVERY stored value for one session — the session purge's vault
 * half (HACK-80 / VAL-DEMOEXP-006): the person's delete-my-answers control
 * (and the confirmed post-submission purge) must leave nothing in the
 * vault. Session-scoped by design: every field for THIS session goes, so
 * the per-field allowlist the other accessors enforce does not apply.
 * Idempotent — an empty session deletes nothing. Runs on the caller's
 * executor when one is passed (the purge runs inside one transaction, so a
 * half-finished purge can never happen); defaults to the shared pool.
 * Returns the number of rows removed. Logs a count only — field ids are
 * themselves identifying content (VAL-TEL-002), values never logged.
 */
export async function purgeSessionVault(
  sessionId: string,
  executor: postgres.Sql | postgres.TransactionSql = getDb(),
): Promise<number> {
  const sql = executor;
  const deleted = await sql`
    DELETE FROM vault_entry
    WHERE session_id = ${sessionId}
    RETURNING 1
  `;
  logInfo("vault_purged", { fieldCount: deleted.length });
  return deleted.length;
}

/**
 * Server-side read path for the intake FLOW ENGINE (BN-09): the traversal
 * contract needs pii answer values to evaluate skip conditions (e.g. the
 * housing_status chain), and those values live only here. Returns the
 * requested vault fields' stored values for one session.
 *
 * This is NOT a crossing path: results go to the server-side flow engine
 * only, and the serialization boundary (lib/intake/serialize.ts) strips
 * every pii value before anything reaches a client, log, or prompt. Only
 * fields the spec marks pii:true may be requested; anything else throws a
 * taxonomy error.
 */
export async function vaultFlowValues(
  sessionId: string,
  fields: readonly string[],
): Promise<Record<string, string>> {
  for (const field of fields) {
    if (!VAULT_FIELDS.includes(field)) {
      throw new AppError(
        "validation_error",
        "That field may not be read from the PII vault.",
        { cause: { field } },
      );
    }
  }
  if (fields.length === 0) {
    return {};
  }
  const sql = getDb();
  const rows = await sql`
    SELECT field, value FROM vault_entry
    WHERE session_id = ${sessionId} AND field IN ${sql([...fields])}
  `;
  logInfo("vault_flow_read", { fieldCount: rows.length });
  return decryptedRowValues(sessionId, [...rows]);
}

/**
 * The vault read path for the intake prompt builder (via lib/intake/store,
 * the first sanctioned accessor). Accepts ONLY fields the global
 * CROSSING_ALLOWLIST permits and rejects every other request — including
 * any pii:true field — loudly with a taxonomy error. The surfaced message
 * stays generic; rejected field ids go only into `cause`, which is never
 * serialized to logs or responses. With the allowlist empty this returns
 * {} or throws: nothing crosses into model context today.
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
  return decryptedRowValues(sessionId, [...rows]);
}

/**
 * The vault read path for the FORMS FILL (via lib/forms/fill.ts, the second
 * sanctioned accessor, Mission v2 M4). Separate from readVaultFields on
 * purpose: the prompt-facing read path takes no caller-supplied permit at
 * all, while the fill's permit is derived HERE from the committed,
 * git-reviewed form-registry entry — a caller cannot pass an arbitrary
 * field list and dress it up as a permit. A fill reads exactly the vault
 * fields its reviewed entry names and nothing else; the permit only ever
 * ADMITS vault fields (see vaultCrossingDecision), so an entry naming a
 * non-vault field rejects it even if that name looks like pii.
 */
export async function readVaultFieldsForFill(
  sessionId: string,
  entry: FormRegistryEntry,
): Promise<Record<string, string>> {
  const { allowed, rejected } = vaultCrossingDecision(
    entry.vaultFieldAllowlist,
    entry.vaultFieldAllowlist,
  );
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
  return decryptedRowValues(sessionId, [...rows]);
}
