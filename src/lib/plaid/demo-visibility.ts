// The browser half of the HACK-140 demo switch (review P2, PR #172). The
// server gate lives in ./config; both read the same public flag so the card
// and the routes can never disagree. Off by default: a deployment that does
// not opt in never offers the demo.
//
// The reference below must stay a direct process.env.NEXT_PUBLIC_* lookup so
// Next.js inlines it into the client bundle at build time.
export function plaidDemoEnabledInBrowser(): boolean {
  return process.env.NEXT_PUBLIC_PLAID_DEMO_ENABLED === "true";
}
