import { Buffer } from "node:buffer";
import type { FaxSendReceipt, FaxSendRequest, FaxTransport } from "./fax";

// Sinch Fax API v3 adapter (HACK-89). DEMO/TEST ONLY.
//
// Sinch's Fax API docs say a fax sent TO +19898989898 emulates all aspects of
// a real fax without charging the account. This adapter refuses every other
// destination, so it can never dial the published county number or a real
// applicant's destination.
//
// It is not a live fax path. The same docs say Sinch retains fax logs and
// media for 13 months when storage is enabled, which does not meet HACK-89's
// no-retention filter. `FAX_PATH_UNVERIFIED.termsVerified` therefore stays
// false; this transport is only for the synthetic demo.
//
// Packet bytes never reach a log, an error message, or storage. The only
// retained value is Sinch's fax id (the confirmation id); the free test
// destination costs $0.
export const SINCH_FAX_API_BASE = "https://fax.api.sinch.com";
export const SINCH_FAX_DEMO_NUMBER = "+19898989898";
const SINCH_FAX_TIMEOUT_MS = 30_000;
const E164 = /^\+[1-9]\d{7,14}$/;

export interface SinchFaxConfig {
  readonly projectId: string;
  readonly accessKey: string;
  readonly accessSecret: string;
  /** A Sinch fax number you control, in E.164 format. */
  readonly fromNumber: string;
  /** The adapter is deliberately demo-only until the retention gate is met. */
  readonly demoOnly: true;
}

export type SinchFaxFetch = (url: string, init: RequestInit) => Promise<Response>;

export class SinchFaxError extends Error {
  constructor(
    readonly code: "rejected" | "service_unavailable" | "unknown_outcome",
  ) {
    super("Sinch fax request failed.");
    this.name = "SinchFaxError";
  }
}

/**
 * Read the server-only Sinch demo configuration. Fails closed unless the
 * explicit demo switch is exactly "true" and every credential is present.
 * Error messages never include a credential or a destination.
 */
export function sinchFaxConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SinchFaxConfig {
  if (env.SINCH_FAX_DEMO_ONLY !== "true") {
    throw new Error(
      "Sinch fax is demo-only until its retention terms are verified.",
    );
  }
  const projectId = env.SINCH_PROJECT_ID?.trim();
  const accessKey = env.SINCH_ACCESS_KEY?.trim();
  const accessSecret = env.SINCH_ACCESS_SECRET?.trim();
  const fromNumber = env.SINCH_FAX_FROM?.trim();
  if (
    !projectId ||
    !accessKey ||
    !accessSecret ||
    !fromNumber ||
    !E164.test(fromNumber)
  ) {
    throw new Error("Sinch fax is not configured.");
  }
  return { projectId, accessKey, accessSecret, fromNumber, demoOnly: true };
}

/**
 * One-shot Sinch demo send. Sinch may retry sends by default; `maxRetries=0`
 * keeps the app's single-shot rule intact, so an ambiguous failure is never
 * followed by a silent second transmission.
 */
export class SinchFaxTransport implements FaxTransport {
  constructor(
    private readonly config: SinchFaxConfig,
    private readonly fetchFn: SinchFaxFetch = (url, init) =>
      fetch(url, init),
  ) {}

  async send(request: FaxSendRequest): Promise<FaxSendReceipt> {
    if (request.destinationFax !== SINCH_FAX_DEMO_NUMBER) {
      throw new SinchFaxError("rejected");
    }

    const form = new FormData();
    form.append("to", SINCH_FAX_DEMO_NUMBER);
    form.append("from", this.config.fromNumber);
    form.append("maxRetries", "0");
    form.append(
      "file",
      new Blob([new Uint8Array(request.packetBytes)], {
        type: "application/pdf",
      }),
      "application.pdf",
    );

    const authorization = `Basic ${Buffer.from(
      `${this.config.accessKey}:${this.config.accessSecret}`,
    ).toString("base64")}`;

    let response: Response;
    try {
      response = await this.fetchFn(
        `${SINCH_FAX_API_BASE}/v3/projects/${encodeURIComponent(
          this.config.projectId,
        )}/faxes`,
        {
          method: "POST",
          headers: { authorization, accept: "application/json" },
          body: form,
          signal: AbortSignal.timeout(SINCH_FAX_TIMEOUT_MS),
        },
      );
    } catch {
      // A timeout or dropped connection may have reached Sinch; never report
      // that nothing was sent.
      throw new SinchFaxError("unknown_outcome");
    }

    if (!response.ok) {
      throw new SinchFaxError(
        response.status === 408
          ? "unknown_outcome"
          : response.status === 429 || response.status >= 500
            ? "service_unavailable"
            : "rejected",
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SinchFaxError("unknown_outcome");
    }
    const id =
      body !== null &&
      typeof body === "object" &&
      "id" in body &&
      typeof (body as { id?: unknown }).id === "string"
        ? (body as { id: string }).id
        : "";
    if (id === "") {
      // The request may have been accepted even though the response was not
      // the fax object we expected.
      throw new SinchFaxError("unknown_outcome");
    }

    // Sinch's free demo destination does not charge the account.
    return { confirmationId: id, costUsd: 0 };
  }
}
