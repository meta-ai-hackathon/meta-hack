#!/usr/bin/env node
// User-journey walkthrough CLI (BN-13 companion, VAL-WALK-001..003).
//
// Drives the HTTP surface of a running Benefits Navigator exactly the way a
// real user's browser would — fetch only, never an app import — so it
// validates whatever that surface serves, local or deployed:
//
//   pnpm walkthrough                          # http://localhost:3100
//   pnpm walkthrough --url https://meta-hack-omega.vercel.app
//
// The journey: create a session, answer the intake questions with a
// realistic tri-state mix (known answers that trigger skips, answers that do
// not, at least one "I'm not sure" and one best-guess "unverified"), observe
// the skip behavior after every answer, save and exit, then resume with the
// session token and verify progress was restored identically. Every step is
// printed as a timestamped transcript line carrying the honest-status labels
// ("You told us" / "You're not sure" / "Answered but not verified").
//
// While it walks, the CLI scans every response for violations:
//   - banned-claim promise language (same patterns as the honesty spine),
//   - client-visible pii:true content (a value shipped under a pii question,
//     or a submitted private value echoed back in any body).
// Any violation stops the journey with exit code 1; journey errors (HTTP
// failures, an unexpected question, usage errors) exit 2; a clean walk
// exits 0.
//
// The journey logic lives in walkthrough-core.mjs (with its tests); this
// entry file only wires the executable.
//
// Node built-ins only — no dependencies. Node >= 22 (built-in fetch,
// Headers.getSetCookie, AbortSignal.timeout).

import { EXIT_JOURNEY_ERROR, main } from "./walkthrough-core.mjs";

process.on("unhandledRejection", (error) => {
  console.error("JOURNEY ERROR unhandled rejection:", error);
  process.exit(EXIT_JOURNEY_ERROR);
});

await main();
