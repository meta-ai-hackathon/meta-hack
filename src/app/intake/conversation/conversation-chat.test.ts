import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TARGET_SAMPLE_RATE } from "../../../lib/audio/capture";
import { findBannedClaims } from "../../../lib/honesty";
import {
  CONSENT_HEADER,
  CONSENT_STORAGE_KEY,
  saveConsentReceipt,
  type ConsentReceipt,
} from "../../../lib/consent";
import { VoiceInterimState, sendVoiceTurn } from "./conversation-chat";

// Voice-fetch wiring tests (Mission v2.1 M5, VAL-CONSENT-006): the browser
// voice client must attach the consent header to the audio POST to
// /api/conversation/turn exactly as the typed and speak paths do — the
// server refuses every voice turn without it (403 consent_required, whose
// client handling then wipes the stored receipt). The unit under test is
// the WIRING (what the voice fetch actually carries), which no server-side
// route test can see: multipart FormData body with the transcoded WAV, no
// manually pinned content-type (the browser must set the multipart
// boundary), the receipt attached exactly as stored when one exists, and
// NO header when none does (fail closed — the server's refusal behavior
// for missing/declined consent is unchanged).

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

// --- Browser-API fakes (the repo's injection idiom, as in consent.test.ts
// and capture.ts's injectable predicates): recordedBlobToWav runs its real
// decode → render → encode pipeline against these stubs. ---

function fakeAudioBuffer(length: number): {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
} {
  return {
    duration: length / TARGET_SAMPLE_RATE,
    sampleRate: TARGET_SAMPLE_RATE,
    numberOfChannels: 1,
    getChannelData: () => new Float32Array(length),
  };
}

class FakeAudioContext {
  async decodeAudioData(): Promise<ReturnType<typeof fakeAudioBuffer>> {
    // 10 ms of decoded "speech" is plenty to drive the real encoder.
    return fakeAudioBuffer(TARGET_SAMPLE_RATE / 100);
  }
  async close(): Promise<void> {}
}

class FakeOfflineAudioContext {
  readonly destination = {};
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {}
  createBufferSource(): {
    buffer: unknown;
    connect(destination: unknown): void;
    start(): void;
  } {
    return { buffer: null, connect: () => undefined, start: () => undefined };
  }
  async startRendering(): Promise<ReturnType<typeof fakeAudioBuffer>> {
    return fakeAudioBuffer(this.length);
  }
}

let store: Map<string, string>;

function stubBrowserGlobals(): void {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("window", {
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeOfflineAudioContext,
  });
}

/** Send one voice turn through the real wiring with a capturing fetch. */
async function captureVoiceSend(): Promise<CapturedRequest> {
  const requests: CapturedRequest[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response("{}", { status: 200 });
  };
  await sendVoiceTurn(new Blob(["recorded-bytes"]), fetchImpl);
  expect(requests).toHaveLength(1);
  return requests[0]!;
}

beforeEach(stubBrowserGlobals);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the voice fetch carries the consent receipt (VAL-CONSENT-006)", () => {
  it("attaches the stored receipt to the audio POST, whatever the decision", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({ ai: fc.boolean(), voice: fc.boolean() }),
        async (decision) => {
          const receipt: ConsentReceipt = {
            v: 2,
            providerId: "meta-model-api",
            ai: decision.ai,
            voice: decision.voice,
            at: new Date("2026-10-30T12:00:00.000Z").toISOString(),
          };
          saveConsentReceipt(receipt);
          const request = await captureVoiceSend();

          expect(request.url).toBe("/api/conversation/turn");
          expect(request.init.method).toBe("POST");
          // The receipt travels EXACTLY as stored (a declined receipt too —
          // the server evaluates the decision and refuses; the wiring must
          // not editorialize it, and must not silently drop it).
          const headers = new Headers(request.init.headers);
          expect(
            JSON.parse(headers.get(CONSENT_HEADER) ?? "null"),
          ).toEqual(receipt);
          // Multipart: the browser must describe the FormData body itself —
          // a manually pinned content-type would break the boundary.
          expect(headers.get("content-type")).toBeNull();
          // The body is the transcoded Meta-accepted WAV, filed as the
          // audio part.
          const body = request.init.body as FormData;
          const audio = body.get("audio") as File;
          expect(audio).toBeInstanceOf(Blob);
          expect(audio.name).toBe("turn.wav");
          const bytes = new Uint8Array(await audio.arrayBuffer());
          expect(String.fromCharCode(...bytes.slice(0, 4))).toBe("RIFF");
        },
      ),
    );
  });

  it("sends NO consent header when this device has no receipt (fail closed)", async () => {
    const request = await captureVoiceSend();
    const headers = new Headers(request.init.headers);
    expect(headers.get(CONSENT_HEADER)).toBeNull();
    expect(headers.get("content-type")).toBeNull();
  });

  it("sends NO consent header when the stored receipt is garbage (fail closed)", async () => {
    store.set(CONSENT_STORAGE_KEY, "not-json-at-all");
    const request = await captureVoiceSend();
    const headers = new Headers(request.init.headers);
    expect(headers.get(CONSENT_HEADER)).toBeNull();
  });
});

// The interim perceived-latency states (VAL-VLAT-001): the component that
// carries the "listening" / "transcribing" statuses renders them with a
// probeable data attribute, honest copy, and nothing at all when no turn
// is in flight. The wiring (stopRecording sets the phase synchronously
// with the stop click) is what puts the render inside the 500 ms budget.
describe("the interim voice states (VAL-VLAT-001)", () => {
  it("renders the listening state with its phase attribute", () => {
    const html = renderToStaticMarkup(
      VoiceInterimState({ phase: "listening" }),
    );
    expect(html).toContain('data-voice-interim-state="listening"');
    expect(html).toContain("Listening");
  });

  it("renders the transcribing state with its phase attribute", () => {
    const html = renderToStaticMarkup(
      VoiceInterimState({ phase: "transcribing" }),
    );
    expect(html).toContain('data-voice-interim-state="transcribing"');
    expect(html).toContain("Transcribing");
  });

  it("renders nothing when no turn is in flight", () => {
    expect(renderToStaticMarkup(VoiceInterimState({ phase: null }))).toBe("");
  });

  it("keeps both interim texts banned-claim clean", () => {
    for (const phase of ["listening", "transcribing"] as const) {
      const html = renderToStaticMarkup(VoiceInterimState({ phase }));
      expect(findBannedClaims(html)).toEqual([]);
    }
  });
});
