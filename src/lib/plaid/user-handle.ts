import { createHmac, timingSafeEqual } from "node:crypto";

// The Plaid broker is stateless (HACK-140), so it cannot look up "which
// Plaid user_id belongs to this session?" in a table. Instead the
// link-token route returns the user_id sealed with an HMAC keyed by the
// intake session, and the pull route only redeems a handle that verifies
// for the caller's own session. Without this, any session could post
// another session's user_id and pull that person's Bank Income report.
// The user_id itself is not a secret (Plaid's `usr_` identifiers are
// opaque), so only integrity and session binding matter here.
const DOMAIN = "plaid-pull-handle:";

function signature(sessionId: string, userId: string): Buffer {
  return createHmac("sha256", DOMAIN + sessionId).update(userId).digest();
}

/** Seal a Plaid user_id so only the same intake session can redeem it. */
export function sealPlaidUserId(sessionId: string, userId: string): string {
  return `${userId}.${signature(sessionId, userId).toString("base64url")}`;
}

/** The sealed user_id, or null when the handle is malformed or belongs to another session. */
export function openPlaidUserId(
  sessionId: string,
  handle: string,
): string | null {
  const separator = handle.lastIndexOf(".");
  if (separator <= 0 || separator === handle.length - 1) {
    return null;
  }
  const userId = handle.slice(0, separator);
  const given = Buffer.from(handle.slice(separator + 1), "base64url");
  const expected = signature(sessionId, userId);
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? userId
    : null;
}
