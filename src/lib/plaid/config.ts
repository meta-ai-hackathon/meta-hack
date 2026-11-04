// Plaid server configuration (HACK-140). Reads the Sandbox credentials
// from the server environment ONLY. The secret is never exposed to the
// browser: no NEXT_PUBLIC_ variable is read here for credentials, and no
// value is logged.
//
// Two gates, both off by default:
// - The explicit demo switch (NEXT_PUBLIC_PLAID_DEMO_ENABLED === "true"):
//   the Sandbox bank card is a demo, so every /api/intake/plaid/* route
//   answers 404 and the card stays hidden until an operator turns it on
//   (review P2, PR #172). The flag is public by design -- the browser reads
//   it to hide the card -- and carries no credential.
// - The demo is Sandbox-only by decision (HACK-65/HACK-140), so this module
//   FAILS CLOSED unless PLAID_ENV is exactly "sandbox" -- a production or
//   development credential dropped into the environment by mistake cannot
//   turn this demo into a live bank pull. Any non-Sandbox path needs an owner
//   decision under HACK-92 and a matching person-authored rules.md change;
//   the relay design is not approved for real bank data (HACK-140 production
//   note 7471d535).
export interface PlaidConfig {
  readonly clientId: string;
  readonly secret: string;
  readonly env: "sandbox";
  readonly baseUrl: "https://sandbox.plaid.com";
}

/** The explicit demo switch: on only for the exact string "true". */
export function plaidDemoEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NEXT_PUBLIC_PLAID_DEMO_ENABLED === "true";
}

/**
 * The one answer every Plaid route gives while the demo switch is off:
 * a plain 404 that reveals nothing -- not whether a session exists, not
 * whether credentials are configured, and not which gate closed.
 */
export function plaidDemoDisabledResponse(): Response {
  return Response.json(
    { error: { code: "not_found", message: "Not found." } },
    { status: 404, headers: { "cache-control": "no-store" } },
  );
}

export function plaidConfig(env: Readonly<Record<string, string | undefined>> = process.env): PlaidConfig {
  if (!plaidDemoEnabled(env) || env.PLAID_ENV !== "sandbox") {
    throw new Error("Plaid is not available right now.");
  }
  const clientId = env.PLAID_CLIENT_ID?.trim();
  const secret = env.PLAID_SECRET?.trim();
  if (!clientId || !secret) {
    throw new Error("Plaid is not available right now.");
  }
  return { clientId, secret, env: "sandbox", baseUrl: "https://sandbox.plaid.com" };
}
