// Content-Security-Policy for the intake pages (HACK-140 review P2).
//
// The Plaid Link Web SDK is loaded from Plaid's CDN into the intake page.
// Plaid publishes no versioned build or SRI hash, and the owner accepted that
// limitation for the Sandbox demo (HACK-140, 2026-11-04). This policy limits
// where scripts may load from, which frames may open, and where the page may
// connect, so injected code cannot fetch modules from or send data to an
// origin outside this audited list. It does NOT stop an injected inline
// script from running ('unsafe-inline' is required by Next's inline
// bootstrap), and it does not stop any allowed script from reading
// same-origin storage; origin isolation and a nonce/hash-based policy remain
// the stronger fixes before any real-applicant deployment (recorded on
// HACK-140).
//
// Audited 2026-11-04: the intake pages call only same-origin /api routes,
// play blob: audio returned by /api/conversation/speak, and load next/font's
// self-hosted faces and the PII guard fetches its tokenizer/model from
// Hugging Face and imports its ONNX runtime module from jsDelivr. When the
// Plaid demo is enabled, the audited external origins also include Plaid's
// SDK/frames/Sandbox API. Plaid hosts are omitted entirely when the demo is
// off, so an ordinary applicant deployment exposes no extra exfiltration
// origin (review P3, PR #172). csp.test.ts pins both variants, so a new
// third-party origin has to be added deliberately.
//
// 'unsafe-inline' is required because Next.js emits inline bootstrap/hydration
// scripts and the root layout has one inline display-settings script.
// 'wasm-unsafe-eval' lets the on-device PII guard compile its ONNX runtime; it
// permits WebAssembly compilation only, not JavaScript eval. 'unsafe-eval' and
// websockets are development-only (HMR/React Refresh).
const PLAID_HOSTS = ["https://plaid.com", "https://*.plaid.com"] as const;
const PLAID_SCRIPT_HOST = "https://cdn.plaid.com";
const PLAID_SANDBOX_API = "https://sandbox.plaid.com";
// The browser-side PII guard downloads its tokenizer/model files here.
const HUGGINGFACE_HOSTS = [
  "https://huggingface.co",
  "https://*.huggingface.co",
  "https://*.hf.co",
] as const;
// The ONNX runtime module the browser-side guard imports. Pinned to the exact
// @huggingface/transformers version in package.json; bump both together.
const TRANSFORMERS_CDN =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6/dist/";

export function intakeContentSecurityPolicy(
  isDev: boolean,
  plaidDemoEnabled: boolean,
): string {
  const scriptEval = isDev ? ["'unsafe-eval'"] : [];
  const devSockets = isDev ? ["ws:", "wss:"] : [];
  const plaidScripts = plaidDemoEnabled
    ? [PLAID_SCRIPT_HOST, ...PLAID_HOSTS]
    : [];
  const plaidConnect = plaidDemoEnabled
    ? [PLAID_SANDBOX_API, ...PLAID_HOSTS]
    : [];
  return [
    "default-src 'self'",
    `script-src ${[
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      ...scriptEval,
      ...plaidScripts,
      TRANSFORMERS_CDN,
    ].join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${["'self'", "data:", "blob:", ...(plaidDemoEnabled ? PLAID_HOSTS : [])].join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${[
      "'self'",
      ...devSockets,
      ...plaidConnect,
      ...HUGGINGFACE_HOSTS,
      TRANSFORMERS_CDN,
    ].join(" ")}`,
    `frame-src ${["'self'", ...(plaidDemoEnabled ? PLAID_HOSTS : [])].join(" ")}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}
