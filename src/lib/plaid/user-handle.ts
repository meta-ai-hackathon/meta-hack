import { createHmac, timingSafeEqual } from "node:crypto";

// The Plaid broker is stateless (HACK-140), so it cannot look up "which
// Plaid user_id belongs to this session?" in a table. Instead the
// link-token route returns a handle that binds the user_id to the caller's
// intake session and expires after a short window; the pull route redeems
// only a handle whose signature verifies under the SERVER-ONLY secret and
// whose session matches the caller.
//
// The secret is the point: a handle signed with the session id alone can be
// minted by the browser (it holds that cookie), which would let a client
// redeem any Plaid user_id it can name. The user_id itself is not a secret
// (Plaid's `usr_` identifiers are opaque), so integrity, expiry, and session
// binding are the whole contract.
const DOMAIN = "plaid-pull-handle-v2:";
const MIN_SECRET_LENGTH = 32;
/** Link closes seconds before the pull; 15 minutes is ample. */
export const PLAID_HANDLE_TTL_SECONDS = 15 * 60;

function handleSecret(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const secret = env.PLAID_HANDLE_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    // Fail closed: without the server secret the broker mints nothing.
    throw new Error("Plaid is not available right now.");
  }
  return secret;
}

interface HandlePayload {
  readonly sessionId: string;
  readonly userId: string;
  /** Unix seconds after which the handle is refused. */
  readonly exp: number;
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", DOMAIN + secret).update(payload).digest();
}

/** Seal a Plaid user_id to one intake session, expiring in 15 minutes. */
export function sealPlaidUserId(
  sessionId: string,
  userId: string,
  now = Date.now(),
): string {
  const exp = Math.floor(now / 1000) + PLAID_HANDLE_TTL_SECONDS;
  const payload = Buffer.from(
    JSON.stringify({ sessionId, userId, exp } satisfies HandlePayload),
  ).toString("base64url");
  return `${payload}.${signature(payload, handleSecret()).toString("base64url")}`;
}

/**
 * The sealed user_id for this session, or null when the handle is malformed,
 * forged, expired, or belongs to another session.
 */
export function openPlaidUserId(
  sessionId: string,
  handle: string,
  now = Date.now(),
): string | null {
  let secret: string;
  try {
    secret = handleSecret();
  } catch {
    return null;
  }
  const separator = handle.lastIndexOf(".");
  if (separator <= 0 || separator === handle.length - 1) {
    return null;
  }
  const payload = handle.slice(0, separator);
  const given = Buffer.from(handle.slice(separator + 1), "base64url");
  const expected = signature(payload, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const {
    sessionId: sealedSession,
    userId,
    exp,
  } = parsed as Partial<HandlePayload>;
  if (
    sealedSession !== sessionId ||
    typeof userId !== "string" ||
    typeof exp !== "number" ||
    !Number.isFinite(exp)
  ) {
    return null;
  }
  return exp * 1000 > now ? userId : null;
}
