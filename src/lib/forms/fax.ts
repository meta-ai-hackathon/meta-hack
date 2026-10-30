import {
  CONSENT_PATHS,
  consentPathById,
  consentPathEnabled,
  type ConsentPathSpec,
  type ConsentReceipt,
} from "../consent";
import { logInfo } from "../telemetry";
import type { PacketOutcome } from "./packet";

// Fax transmission (HACK-88, under HACK-75): sends the assembled packet
// through the ephemeral fax provider — but only down a path that is
// consent-gated, rehearsal-safe, and single-shot.
//
// The contract this module enforces, whatever vendor HACK-89 lands:
// - CONSENT FIRST, CLIENT-SIDE DECISION: `transmitPacket` refuses unless
//   `consentPathEnabled("fax", receipt)` — named-provider copy shown,
//   consent recorded, AND the provider's no-retention terms verified in
//   the registry. While the registry entry is unverified (today), every
//   call refuses with `provider_unverified`: consent alone can never
//   enable a retaining or unchecked vendor.
// - THE APP'S OWN ROUTES NEVER CARRY THE PACKET: the transport is
//   injected and called directly with the packet bytes; no route handler
//   receives them (real-data rule: the server never becomes a relay).
// - SINGLE-SHOT: one transport call per invocation, no silent retries —
//   a retry after an ambiguous failure could double-send a signed legal
//   document. Recovery is the user's explicit decision, surfaced as a
//   distinct next action per failure kind.
// - CONFIRMATION IS THE ONLY RETAINED ARTIFACT: the result carries the
//   provider's confirmation id, destination, page count, and timestamp —
//   plus the per-fax cost the vendor reports. Packet bytes are never
//   copied into the result, a log, or storage here; `logInfo` below
//   records counts and outcomes only.
// - REHEARSAL SAFETY: a test-mode request may only target the configured
//   test destination. A live destination in test mode (or any unverified
//   destination mismatch) refuses before the transport is touched, so
//   the published agency number can never be dialed by rehearsal code.

/** Delivery channel for one fax. Implemented per vendor (HACK-89). */
export interface FaxTransport {
  send(request: FaxSendRequest): Promise<FaxSendReceipt>;
}

export interface FaxSendRequest {
  readonly destinationFax: string;
  /** The assembled packet bytes (HACK-90). Carried once, never stored. */
  readonly packetBytes: Uint8Array;
  readonly pageCount: number;
}

export interface FaxSendReceipt {
  /** Provider-side confirmation id — the sole retained artifact's key. */
  readonly confirmationId: string;
  /** Per-fax cost in USD as reported by the vendor, when it reports one. */
  readonly costUsd?: number;
}

/** The confirmation the app may keep (+ cost). Contains no packet data. */
export interface FaxConfirmation {
  readonly confirmationId: string;
  readonly destinationFax: string;
  readonly pageCount: number;
  readonly costUsd?: number;
  /** ISO timestamp of the confirmed transmission. */
  readonly confirmedAt: string;
}

export type FaxFailureKind =
  | "provider_unverified" // terms not verified in the registry (HACK-89 pending)
  | "not_consented" // no fax consent on the user's receipt
  | "test_destination_mismatch" // rehearsal aimed somewhere other than the test number
  | "provider_down" // transport unreachable / 5xx — try again later, explicitly
  | "number_unreachable" // the destination did not answer — check the number
  | "partial_transmission"; // some pages sent — do NOT resend the whole packet blindly

export type FaxResult =
  | { readonly ok: true; readonly confirmation: FaxConfirmation }
  | {
      readonly ok: false;
      readonly kind: FaxFailureKind;
      /** The honest, visible next action for this failure. */
      readonly nextAction: string;
    };

export interface FaxOptions {
  /** Live sending vs rehearsal. Rehearsal pins the destination (guardrail). */
  readonly mode: "live" | "test";
  /** The one permitted rehearsal destination when mode is "test". */
  readonly testDestinationFax?: string;
  /** Clock injection for the confirmation timestamp (tests). */
  readonly now?: () => Date;
}

const NEXT_ACTIONS: Readonly<Record<FaxFailureKind, string>> = {
  provider_unverified:
    "Fax sending is not available yet: the fax service's data-handling terms have not been verified. Your packet stays with you — download it and fax it through a service you choose.",
  not_consented:
    "Nothing was sent. Sending by fax needs your consent to the named provider first — you can give it on the consent screen, or fax the packet yourself.",
  test_destination_mismatch:
    "Nothing was sent. Rehearsal faxes can only go to the test fax number.",
  provider_down:
    "The fax service could not be reached, so nothing was sent. Your answers are unchanged — try again when you are ready, or fax the packet yourself.",
  number_unreachable:
    "The fax number did not answer, so nothing was confirmed as sent. Check the number, then try once more, or fax the packet yourself.",
  partial_transmission:
    "Only part of the packet went through, so it was not confirmed. Do not resend the whole packet — contact the office to ask what arrived, or fax the packet yourself.",
};

function failure(kind: FaxFailureKind): FaxResult {
  logInfo("fax_transmit_failed", { kind });
  return { ok: false, kind, nextAction: NEXT_ACTIONS[kind] };
}

/** Classify a transport throw into the honest failure vocabulary. */
export function classifyFaxError(error: unknown): FaxFailureKind {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "number_unreachable" || code === "no_answer" || code === "busy") {
    return "number_unreachable";
  }
  if (code === "partial" || code === "partial_transmission") {
    return "partial_transmission";
  }
  return "provider_down";
}

/**
 * Transmit one assembled packet. Refusals happen before the transport is
 * touched (unverified provider, missing consent, rehearsal mismatch);
 * transport failures are classified, never retried silently. On success
 * the caller receives the confirmation — the only artifact this flow
 * retains — and triggers the shown purge (HACK-80).
 */
export async function transmitPacket(
  packet: PacketOutcome,
  destinationFax: string,
  receipt: ConsentReceipt | null,
  transport: FaxTransport,
  options: FaxOptions,
  paths: readonly ConsentPathSpec[] = CONSENT_PATHS,
): Promise<FaxResult> {
  // Gate order matters: the structural refusal (unverified terms) is
  // reported before consent, because consent cannot fix it.
  const faxPath = consentPathById("fax", paths);
  if (!faxPath || !faxPath.termsVerified) {
    return failure("provider_unverified");
  }
  if (!consentPathEnabled("fax", receipt, paths)) {
    return failure("not_consented");
  }
  if (
    options.mode === "test" &&
    (typeof options.testDestinationFax !== "string" ||
      destinationFax !== options.testDestinationFax)
  ) {
    return failure("test_destination_mismatch");
  }

  let sent: FaxSendReceipt;
  try {
    sent = await transport.send({
      destinationFax,
      packetBytes: packet.bytes,
      pageCount: packet.pageCount,
    });
  } catch (error) {
    return failure(classifyFaxError(error));
  }

  const confirmation: FaxConfirmation = {
    confirmationId: sent.confirmationId,
    destinationFax,
    pageCount: packet.pageCount,
    ...(sent.costUsd !== undefined ? { costUsd: sent.costUsd } : {}),
    confirmedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  logInfo("fax_transmit_confirmed", {
    pageCount: confirmation.pageCount,
    hasCost: confirmation.costUsd !== undefined,
  });
  return { ok: true, confirmation };
}
