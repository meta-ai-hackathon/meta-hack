import { getDb } from "./db";
import { logInfo } from "./telemetry";
import { purgeSessionVault } from "./vault";

// Session data purge (HACK-80 / VAL-DEMOEXP-006): the real erasure behind
// the visible purge screen. On the person's explicit action — the manual
// delete-my-answers control, or a session already carrying
// user_reported_submitted (a state only the person's own report creates) —
// every data row for that session is deleted:
// - `answer` — every answer, with its tri-state status and provenance;
// - `vault_entry` — every private detail (via the vault module's own
//   accessor; the vault table stays behind its boundary);
// - `conversation_turn` — the whole (already-redacted) transcript;
// - `session_audit_note` — free-form caseworker notes, which are session
//   data and not receipt data.
//
// The `person` and `session` rows REMAIN: that bare receipt (a session
// happened, and where it ended) is all the app keeps, so resuming after a
// purge shows an empty journey rather than a broken link.
//
// All four deletes run in ONE transaction: a purge that half-finishes must
// never happen, because the confirmation screen may only ever report a
// complete erasure. If the transaction fails, the route surfaces a taxonomy
// error and the screen says nothing was removed — true, because the
// transaction rolled back. Deletes are idempotent either way.
//
// Logging discipline: counts only. Question ids, field ids, values, and
// transcripts never enter the log (VAL-TEL-002).

/** What one purge removed, for the confirmation response and the log. */
export interface PurgeCounts {
  readonly answers: number;
  readonly vaultEntries: number;
  readonly turns: number;
  readonly auditNotes: number;
}

export async function purgeSessionData(
  sessionId: string,
): Promise<PurgeCounts> {
  const sql = getDb();
  const counts = await sql.begin(async (tx) => {
    const answers =
      await tx`DELETE FROM answer WHERE session_id = ${sessionId} RETURNING 1`;
    const vaultEntries = await purgeSessionVault(sessionId, tx);
    const turns =
      await tx`DELETE FROM conversation_turn WHERE session_id = ${sessionId} RETURNING 1`;
    const auditNotes =
      await tx`DELETE FROM session_audit_note WHERE session_id = ${sessionId} RETURNING 1`;
    return {
      answers: answers.length,
      vaultEntries,
      turns: turns.length,
      auditNotes: auditNotes.length,
    };
  });
  logInfo("session_purged", { ...counts });
  return counts;
}
