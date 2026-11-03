// Plaid server configuration (HACK-140). Reads the Sandbox credentials
// from the server environment ONLY. The secret is never exposed to the
// browser: no NEXT_PUBLIC_ variable is read here, and no value is logged.
// The demo is Sandbox-only by decision (HACK-65/HACK-140), so this module
// FAILS CLOSED unless PLAID_ENV is exactly "sandbox" -- a production or
// development credential dropped into the environment by mistake cannot
// turn this demo into a live bank pull.
export interface PlaidConfig {
  readonly clientId: string;
  readonly secret: string;
  readonly env: "sandbox";
  readonly baseUrl: "https://sandbox.plaid.com";
}
export function plaidConfig(env: Readonly<Record<string, string | undefined>> = process.env): PlaidConfig {
  if (env.PLAID_ENV !== "sandbox") {
    throw new Error("Plaid is not available right now.");
  }
  const clientId = env.PLAID_CLIENT_ID?.trim();
  const secret = env.PLAID_SECRET?.trim();
  if (!clientId || !secret) {
    throw new Error("Plaid is not available right now.");
  }
  return { clientId, secret, env: "sandbox", baseUrl: "https://sandbox.plaid.com" };
}

