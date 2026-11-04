// Content-Security-Policy for the intake pages (HACK-140 review P2).
//
// The Plaid Link Web SDK is loaded from Plaid's CDN into the intake page.
// Plaid publishes no versioned build or SRI hash, and the owner accepted that
// limitation for the Sandbox demo (HACK-140, 2026-11-04). This policy limits
// where scripts may load from, which frames may open, and where the page may
// connect, so an injected script cannot pull code or ship data to an
// arbitrary host. It does not (and cannot) stop an allowed same-origin
// script from reading same-origin storage; origin isolation remains the
// stronger fix before any real-applicant deployment (recorded on HACK-140).
//
// 'unsafe-inline' is required because Next.js emits inline bootstrap/hydration
// scripts and the root layout has one inline display-settings script.
// 'unsafe-eval' and websockets are development-only (HMR/React Refresh).
const PLAID_HOSTS = "https://plaid.com https://*.plaid.com";

export function intakeContentSecurityPolicy(isDev: boolean): string {
  const scriptEval = isDev ? " 'unsafe-eval'" : "";
  const devSockets = isDev ? " ws: wss:" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${scriptEval} https://cdn.plaid.com ${PLAID_HOSTS}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${PLAID_HOSTS}`,
    "font-src 'self' data:",
    `connect-src 'self'${devSockets} https://sandbox.plaid.com ${PLAID_HOSTS}`,
    `frame-src 'self' ${PLAID_HOSTS}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
