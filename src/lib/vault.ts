import { getDb } from "./db";
import { AppError, logInfo, PII_QUESTION_IDS } from "./telemetry";

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
 * allowlists permit across and fields they must reject. Exposed separately so
 * the decision logic is testable without a database.
 *
 * Two allowlists, both deliberate product decisions recorded in code:
 * - CROSSING_ALLOWLIST — the global set of fields permitted into model
 *   context (empty today, and test-enforced never to hold a pii:true field).
 * - explicitAllowlist — an optional per-request list a SANCTIONED accessor
 *   passes with its request. The forms pipeline (the second sanctioned
 *   accessor, Mission v2 M4) passes the fill allowlist from the committed
 *   form-registry entry: a form may read exactly the vault fields its
 *   reviewed registry entry names, and nothing else. The allowlist only ever
 *   ADMITS vault fields — a non-vault field is rejected even if a form
 *   allowlist names it.
 *
 * Who can reach this: only a module that imports the vault at all, and the
 * boundary test (src/lib/vault-boundary.test.ts) admits exactly TWO such
 * modules — the intake prompt builder and lib/forms/fill.ts. Any other
 * module (a future prompt builder, a route) importing vault fails CI, which
 * is where a person reviews the new accessor and its allowlist before it
 * can ever run. The per-form lists themselves are committed, git-reviewed
 * JSON — not runtime-editable state — and every registry change is
 * re-validated against the spec on load (registry.ts) and by pytest.
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
  const entries: Record<string, string> = {};
  for (const row of rows) {
    entries[String(row.field)] = String(row.value);
  }
  return entries;
}

/**
 * The vault read path. Accepts ONLY explicitly allowlisted fields and rejects
 * every other request — including any pii:true field off the allowlist —
 * loudly with a taxonomy error. The surfaced message stays generic; rejected
 * field ids go only into `cause`, which is never serialized to logs or
 * responses.
 *
 * The optional `explicitAllowlist` is how a sanctioned accessor presents its
 * per-form permit (Mission v2 M4): the forms pipeline passes the fill
 * allowlist committed in the form-registry entry, so a fill reads exactly the
 * vault fields its reviewed entry names and nothing else. Without an explicit
 * allowlist the decision is the historical fail-closed one (CROSSING_ALLOWLIST
 * only). The explicit list only ever ADMITS vault fields — it cannot smuggle
 * a non-vault field across.
 */
export async function readVaultFields(
  sessionId: string,
  requestedFields: readonly string[],
  explicitAllowlist?: readonly string[],
): Promise<Record<string, string>> {
  const { allowed, rejected } = vaultCrossingDecision(
    requestedFields,
    explicitAllowlist,
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
  const entries: Record<string, string> = {};
  for (const row of rows) {
    entries[String(row.field)] = String(row.value);
  }
  return entries;
}
