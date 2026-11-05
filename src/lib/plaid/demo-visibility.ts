// The browser half of the HACK-140 demo gate (review P2, PR #172). The
// server gate lives in ./config; both require the same two public values so
// the card and the routes can never disagree. Off by default: a deployment
// that is not explicitly marked synthetic never offers the demo, even if the
// public switch is on.
//
// The references below must stay direct process.env.NEXT_PUBLIC_* lookups so
// Next.js inlines them into the client bundle at build time.
export function plaidDemoEnabledInBrowser(): boolean {
  return (
    process.env.NEXT_PUBLIC_PLAID_DEMO_ENABLED === "true" &&
    process.env.NEXT_PUBLIC_PLAID_DEMO_DEPLOYMENT === "synthetic"
  );
}
