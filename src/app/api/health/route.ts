import {
  logInfo,
  requestIdFromHeaders,
  runWithRequestId,
} from "../../../lib/telemetry";

/**
 * Liveness check, and the worked example for request-id propagation (BN-06):
 * the handler accepts a valid incoming `x-request-id` or creates a fresh one,
 * echoes it back as a response header, and every log line emitted inside the
 * handler carries that same id.
 */
export function GET(request: Request) {
  const requestId = requestIdFromHeaders(request.headers);
  return runWithRequestId(requestId, () => {
    logInfo("health.checked");
    return Response.json({ ok: true }, {
      headers: { "x-request-id": requestId },
    });
  });
}
