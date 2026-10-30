import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONSENT_PATHS, type ConsentReceipt } from "../consent";
import {
  classifyFaxError,
  transmitPacket,
  type FaxTransport,
} from "./fax";
import type { PacketOutcome } from "./packet";

// Fax transmission invariants (HACK-88). The properties that matter are
// the ones a bug could silently break: a send without consent, a send
// through an unverified provider, a rehearsal reaching a live number, a
// silent retry double-sending a signed document, or packet data leaking
// into the retained confirmation.

const PACKET: PacketOutcome = {
  bytes: new Uint8Array([1, 2, 3]),
  pageCount: 4,
  coverPages: 1,
};

function receipt(fax: boolean | undefined): ConsentReceipt {
  return {
    v: 1,
    ai: false,
    voice: false,
    ...(fax !== undefined ? { fax } : {}),
    at: "2026-10-30T12:00:00.000Z",
  };
}

function countingTransport(behavior: "ok" | Error): {
  transport: FaxTransport;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    transport: {
      send: async () => {
        calls += 1;
        if (behavior instanceof Error) {
          throw behavior;
        }
        return { confirmationId: "conf-1", costUsd: 1.25 };
      },
    },
  };
}

/** The registry as HACK-89 will leave it: fax terms verified. */
const VERIFIED_PATHS = CONSENT_PATHS.map((path) =>
  path.id === "fax" ? { ...path, termsVerified: true } : path,
);

describe("transmitPacket gates", () => {
  it("refuses before transport while the provider is unverified — consent cannot fix that", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async (faxConsent) => {
        const { transport, calls } = countingTransport("ok");
        const result = await transmitPacket(
          PACKET,
          "+1-555-0100",
          receipt(faxConsent),
          transport,
          { mode: "live" },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.kind).toBe("provider_unverified");
        }
        expect(calls()).toBe(0);
      }),
    );
  });

  it("with verified terms: no fax consent, no send; consent sends exactly once", async () => {
    const denied = countingTransport("ok");
    const refused = await transmitPacket(
      PACKET,
      "+1-555-0100",
      receipt(false),
      denied.transport,
      { mode: "live" },
      VERIFIED_PATHS,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.kind).toBe("not_consented");
    }
    expect(denied.calls()).toBe(0);

    const allowed = countingTransport("ok");
    const sent = await transmitPacket(
      PACKET,
      "+1-555-0100",
      receipt(true),
      allowed.transport,
      { mode: "live", now: () => new Date("2026-10-30T15:00:00Z") },
      VERIFIED_PATHS,
    );
    expect(allowed.calls()).toBe(1);
    expect(sent.ok).toBe(true);
    if (sent.ok) {
      expect(sent.confirmation).toEqual({
        confirmationId: "conf-1",
        destinationFax: "+1-555-0100",
        pageCount: 4,
        costUsd: 1.25,
        confirmedAt: "2026-10-30T15:00:00.000Z",
      });
      // The retained confirmation carries no packet content.
      expect(JSON.stringify(sent.confirmation)).not.toContain("1,2,3");
    }
  });

  it("rehearsal can only ever reach the configured test destination", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 3, maxLength: 16 }),
        async (destination) => {
          const { transport, calls } = countingTransport("ok");
          const result = await transmitPacket(
            PACKET,
            destination,
            receipt(true),
            transport,
            { mode: "test", testDestinationFax: "+1-555-0199" },
            VERIFIED_PATHS,
          );
          if (destination === "+1-555-0199") {
            expect(result.ok).toBe(true);
            expect(calls()).toBe(1);
          } else {
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.kind).toBe("test_destination_mismatch");
            }
            expect(calls()).toBe(0);
          }
        },
      ),
    );
  });
});

describe("failure honesty", () => {
  it("classifies transport failures and never retries silently", async () => {
    const cases: Array<[string, string]> = [
      ["number_unreachable", "number_unreachable"],
      ["no_answer", "number_unreachable"],
      ["partial", "partial_transmission"],
      ["boom", "provider_down"],
    ];
    for (const [code, kind] of cases) {
      const error = Object.assign(new Error("vendor said no"), { code });
      const { transport, calls } = countingTransport(error);
      const result = await transmitPacket(
        PACKET,
        "+1-555-0100",
        receipt(true),
        transport,
        { mode: "live" },
        VERIFIED_PATHS,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.kind).toBe(kind);
        expect(result.nextAction.length).toBeGreaterThan(0);
      }
      // One call per invocation — recovery is the user's decision.
      expect(calls()).toBe(1);
    }
    expect(classifyFaxError(new Error("plain"))).toBe("provider_down");
    expect(classifyFaxError(null)).toBe("provider_down");
  });
});
