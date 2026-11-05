import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { CONSENT_PATHS, type ConsentReceipt } from "../consent";
import { transmitPacket } from "./fax";
import type { PacketOutcome } from "./packet";
import {
  SINCH_FAX_API_BASE,
  SINCH_FAX_DEMO_NUMBER,
  SinchFaxError,
  SinchFaxTransport,
  sinchFaxConfigFromEnv,
  type SinchFaxFetch,
} from "./sinch-fax";

const CONFIG = {
  projectId: "project-1",
  accessKey: "key-sentinel",
  accessSecret: "secret-sentinel",
  fromNumber: "+15551234567",
  demoOnly: true,
} as const;

const ENV = {
  SINCH_PROJECT_ID: "project-1",
  SINCH_ACCESS_KEY: "key-sentinel",
  SINCH_ACCESS_SECRET: "secret-sentinel",
  SINCH_FAX_FROM: "+15551234567",
  SINCH_FAX_DEMO_ONLY: "true",
} as const;

const PACKET: PacketOutcome = {
  bytes: new Uint8Array([1, 2, 3]),
  pageCount: 1,
  coverPages: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("sinchFaxConfigFromEnv", () => {
  it("accepts the fully configured demo-only environment", () => {
    expect(sinchFaxConfigFromEnv(ENV)).toEqual(CONFIG);
  });

  it("fails closed unless SINCH_FAX_DEMO_ONLY is exactly true", () => {
    for (const value of [undefined, "", "false", "TRUE", "1", "true "]) {
      expect(() =>
        sinchFaxConfigFromEnv({ ...ENV, SINCH_FAX_DEMO_ONLY: value }),
      ).toThrow("demo-only");
    }
  });

  it("fails closed when a credential or the sender number is missing or malformed", () => {
    for (const key of [
      "SINCH_PROJECT_ID",
      "SINCH_ACCESS_KEY",
      "SINCH_ACCESS_SECRET",
      "SINCH_FAX_FROM",
    ] as const) {
      const env: Record<string, string | undefined> = { ...ENV };
      env[key] = undefined;
      expect(() => sinchFaxConfigFromEnv(env)).toThrow(
        "Sinch fax is not configured.",
      );
    }
    expect(() =>
      sinchFaxConfigFromEnv({ ...ENV, SINCH_FAX_FROM: "555-1234" }),
    ).toThrow("Sinch fax is not configured.");
  });
});

describe("SinchFaxTransport", () => {
  it("sends only to the free demo number, with one-shot Basic auth and a PDF part", async () => {
    const fetchFn = vi.fn<SinchFaxFetch>(async () =>
        jsonResponse({ id: "fax-1" }),
    );
    const transport = new SinchFaxTransport(CONFIG, fetchFn);

    const receipt = await transport.send({
      destinationFax: SINCH_FAX_DEMO_NUMBER,
      packetBytes: PACKET.bytes,
      pageCount: PACKET.pageCount,
    });

    expect(receipt).toEqual({ confirmationId: "fax-1", costUsd: 0 });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(`${SINCH_FAX_API_BASE}/v3/projects/project-1/faxes`);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("key-sentinel:secret-sentinel").toString("base64")}`,
    );
    expect(headers["content-type"]).toBeUndefined();

    const form = init.body as FormData;
    expect(form.get("to")).toBe(SINCH_FAX_DEMO_NUMBER);
    expect(form.get("from")).toBe("+15551234567");
    expect(form.get("maxRetries")).toBe("0");
    const file = form.get("file") as Blob;
    expect(file.type).toBe("application/pdf");
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([
      1, 2, 3,
    ]);
  });

  it("refuses every other destination before touching the network", async () => {
    const fetchFn = vi.fn<SinchFaxFetch>(async () =>
        jsonResponse({ id: "never" }),
    );
    const transport = new SinchFaxTransport(CONFIG, fetchFn);

    await expect(
      transport.send({
        destinationFax: "+15550100",
        packetBytes: PACKET.bytes,
        pageCount: PACKET.pageCount,
      }),
    ).rejects.toMatchObject({ code: "rejected" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps a refused, unavailable, or ambiguous send honestly", async () => {
    const cases = [
      [400, "rejected"],
      [401, "rejected"],
      [408, "unknown_outcome"],
      [429, "service_unavailable"],
      [500, "service_unavailable"],
    ] as const;
    for (const [status, code] of cases) {
      const fetchFn = vi.fn<SinchFaxFetch>(async () => jsonResponse({}, status),
      );
      await expect(
        new SinchFaxTransport(CONFIG, fetchFn).send({
          destinationFax: SINCH_FAX_DEMO_NUMBER,
          packetBytes: PACKET.bytes,
          pageCount: PACKET.pageCount,
        }),
      ).rejects.toMatchObject({ code });
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }

    const malformed = vi.fn<SinchFaxFetch>(async () => jsonResponse({}),
    );
    await expect(
      new SinchFaxTransport(CONFIG, malformed).send({
        destinationFax: SINCH_FAX_DEMO_NUMBER,
        packetBytes: PACKET.bytes,
        pageCount: PACKET.pageCount,
      }),
    ).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(malformed).toHaveBeenCalledTimes(1);

    const dropped = vi.fn<SinchFaxFetch>(async (): Promise<Response> => {
        throw new Error("connection reset");
      },
    );
    await expect(
      new SinchFaxTransport(CONFIG, dropped).send({
        destinationFax: SINCH_FAX_DEMO_NUMBER,
        packetBytes: PACKET.bytes,
        pageCount: PACKET.pageCount,
      }),
    ).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it("never puts the secret or packet bytes in an error", async () => {
    const fetchFn = vi.fn<SinchFaxFetch>(async () => jsonResponse({}, 500),
    );
    const error = await new SinchFaxTransport(CONFIG, fetchFn)
      .send({
        destinationFax: SINCH_FAX_DEMO_NUMBER,
        packetBytes: PACKET.bytes,
        pageCount: PACKET.pageCount,
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(SinchFaxError);
    expect(String(error)).not.toContain("secret-sentinel");
    expect(String(error)).not.toContain("key-sentinel");
    expect(String(error)).not.toContain("1,2,3");
  });
});

describe("transmitPacket with the Sinch demo transport", () => {
  it("reaches the free test number only after consent and the test-mode gate", async () => {
    const verifiedPaths = CONSENT_PATHS.map((path) =>
      path.id === "fax" ? { ...path, termsVerified: true } : path,
    );
    const receipt: ConsentReceipt = {
      v: 2,
      providerId: "meta-model-api",
      ai: false,
      voice: false,
      fax: true,
      at: "2026-11-05T00:00:00.000Z",
    };
    const fetchFn = vi.fn<SinchFaxFetch>(async () =>
        jsonResponse({ id: "fax-2" }),
    );

    const result = await transmitPacket(
      PACKET,
      SINCH_FAX_DEMO_NUMBER,
      receipt,
      new SinchFaxTransport(CONFIG, fetchFn),
      {
        mode: "test",
        testDestinationFax: SINCH_FAX_DEMO_NUMBER,
        now: () => new Date("2026-11-05T00:00:00Z"),
      },
      verifiedPaths,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.confirmation).toEqual({
        confirmationId: "fax-2",
        destinationFax: SINCH_FAX_DEMO_NUMBER,
        pageCount: 1,
        costUsd: 0,
        confirmedAt: "2026-11-05T00:00:00.000Z",
      });
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
