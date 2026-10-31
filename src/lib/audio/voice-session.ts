import {
  DEFAULT_ENDPOINTING,
  createEndpointingGate,
  type EndpointingConfig,
} from "./endpointing";

// The continuous voice session (HACK-106 natural conversation,
// VAL-NCF-001): the mic opens ONCE per session and one recorder cycle
// captures each utterance — the person just talks, and the utterance ENDS
// from speech shape (silence after speech via the endpointing gate, or a
// hard cap), never from a per-question record/stop ritual. The component
// owns consent + UI state; this module owns the wiring (stream, analyser,
// recorder cycles, poll) so the loop is unit-provable with injected
// browser fakes and the component's effects can hold the session through
// a stable ref (no per-render identity churn).

export interface VoiceSessionRecorderCycle {
  start(): void;
  /** Deliver=true hands the recorded blob to onUtterance; false discards. */
  stop(deliver: boolean): void;
}

export interface VoiceSessionAnalyser {
  rms(): number;
  close(): void;
}

export interface VoiceSessionDeps {
  getUserMedia(constraints: { audio: boolean }): Promise<MediaStream>;
  createRecorderCycle(
    stream: MediaStream,
    onBlob: (blob: Blob) => void,
    onError: () => void,
  ): VoiceSessionRecorderCycle;
  createAnalyser(stream: MediaStream): VoiceSessionAnalyser;
  /** Repeating scheduler; returns its own cancel. */
  schedule(tick: () => void, ms: number): () => void;
  now(): number;
}

/** The phase the component renders for session activity (VAL-VLAT-001:
 * "transcribing" must land SYNCHRONOUSLY with the endpoint, before the
 * recorder's async onstop can fire). */
export type VoiceSessionPhase = "listening" | "transcribing" | null;

export interface VoiceSessionCallbacks {
  /** A complete utterance (endpointed by silence, the cap, or endpointNow). */
  onUtterance(blob: Blob): void;
  onPhase(phase: VoiceSessionPhase): void;
  /** A recorder cycle failed mid-session; the session stops itself. */
  onRecorderError(): void;
}

export interface VoiceSession {
  /** Open the mic + analyser and start the first listening cycle. Throws
   * when the microphone is unavailable (permission denied / no device). */
  begin(): Promise<void>;
  /** Start one listening cycle (after a turn, after a resume). No-ops
   * when the session is off or paused. */
  listen(): void;
  /** End the current utterance gracefully and deliver it. */
  endpointNow(): void;
  /** Pause: stop listening and DISCARD any in-flight utterance. */
  hold(): void;
  /** Un-pause and start a fresh listening cycle. */
  resume(): void;
  /** Full teardown: mic off, analyser closed, nothing further delivered. */
  stop(): void;
  readonly isActive: boolean;
  readonly isPaused: boolean;
}

/** The browser implementation of the deps (all real Web Audio APIs). */
function browserDeps(): VoiceSessionDeps {
  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createRecorderCycle: (stream, onBlob, onError) => {
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      const chunks: Blob[] = [];
      let shouldDeliver = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };
      recorder.onerror = () => onError();
      recorder.onstop = () => {
        // The STREAM stays open across cycles; only this recorder stops.
        const blob = new Blob(chunks, {
          type: recorder.mimeType || "audio/webm",
        });
        chunks.length = 0;
        if (shouldDeliver && blob.size > 0) {
          onBlob(blob);
        }
      };
      return {
        start(): void {
          shouldDeliver = true;
          recorder.start();
        },
        stop(deliver: boolean): void {
          if (recorder.state === "inactive") {
            return;
          }
          // Flag FIRST: the async onstop reads it to decide delivery.
          shouldDeliver = deliver;
          recorder.stop();
        },
      };
    },
    createAnalyser: (stream) => {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buffer = new Uint8Array(analyser.fftSize);
      return {
        rms(): number {
          analyser.getByteTimeDomainData(buffer);
          let sum = 0;
          for (let index = 0; index < buffer.length; index += 1) {
            const value = (buffer[index] - 128) / 128;
            sum += value * value;
          }
          return Math.sqrt(sum / buffer.length);
        },
        close(): void {
          void ctx.close().catch(() => undefined);
        },
      };
    },
    schedule: (tick, ms) => {
      const id = window.setInterval(tick, ms);
      return () => window.clearInterval(id);
    },
    now: () => Date.now(),
  };
}

const RECORD_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

function pickMimeType(): string | null {
  for (const candidate of RECORD_MIME_CANDIDATES) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

const POLL_INTERVAL_MS = 100;

export function createVoiceSession(
  callbacks: VoiceSessionCallbacks,
  config: EndpointingConfig = DEFAULT_ENDPOINTING,
  deps: VoiceSessionDeps = browserDeps(),
): VoiceSession {
  let stream: MediaStream | null = null;
  let analyser: VoiceSessionAnalyser | null = null;
  let gate: ReturnType<typeof createEndpointingGate> | null = null;
  let cancelPoll: (() => void) | null = null;
  let cycle: VoiceSessionRecorderCycle | null = null;
  let active = false;
  let paused = false;
  // Set by stop(): after teardown, a recorder cycle whose async onstop was
  // already in flight must not deliver audio the person believed was
  // stopped (claude-review P2: late delivery after revoke).
  let stopped = false;

  function stopPoll(): void {
    cancelPoll?.();
    cancelPoll = null;
  }

  function stopCycle(deliver: boolean): void {
    cycle?.stop(deliver);
    cycle = null;
  }

  function deliver(blob: Blob): void {
    if (!stopped) {
      callbacks.onUtterance(blob);
    }
  }

  function teardownStream(): void {
    analyser?.close();
    analyser = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  const session: VoiceSession = {
    async begin(): Promise<void> {
      const mic = await deps.getUserMedia({ audio: true });
      stream = mic;
      analyser = deps.createAnalyser(mic);
      gate = createEndpointingGate(config);
      active = true;
      paused = false;
      stopped = false;
      session.listen();
    },
    listen(): void {
      if (!active || paused || !stream) {
        return;
      }
      // Never orphan a running cycle (claude-review P2): a second listen
      // while one recorder cycle is still open would leave the first
      // recording and delivering after teardown. The turn flow calls
      // listen() again after every turn, so the next cycle always starts.
      if (cycle !== null) {
        return;
      }
      gate?.reset();
      cycle = deps.createRecorderCycle(stream, deliver, () => {
        // A mid-cycle recorder failure stops the session and RELEASES the
        // microphone (claude-review P2: the stream and analyser must not
        // outlive the session); the component lands the person in the
        // typed conversation.
        stopPoll();
        cycle = null;
        active = false;
        teardownStream();
        callbacks.onPhase(null);
        callbacks.onRecorderError();
      });
      cycle.start();
      if (!active) {
        // The cycle failed synchronously inside start(): the error callback
        // already tore the session down — do not announce listening.
        return;
      }
      callbacks.onPhase("listening");
      stopPoll();
      cancelPoll = deps.schedule(() => {
        const fired = gate?.feed(analyser?.rms() ?? 0, deps.now());
        if (fired) {
          session.endpointNow();
        }
      }, POLL_INTERVAL_MS);
    },
    endpointNow(): void {
      stopPoll();
      stopCycle(true);
      // Synchronously past the 500 ms budget: the transcribing state lands
      // with the endpoint, before the recorder's async onstop fires.
      callbacks.onPhase("transcribing");
    },
    hold(): void {
      stopPoll();
      stopCycle(false);
      paused = true;
      callbacks.onPhase(null);
    },
    resume(): void {
      paused = false;
      session.listen();
    },
    stop(): void {
      stopped = true;
      stopPoll();
      stopCycle(false);
      active = false;
      paused = false;
      callbacks.onPhase(null);
      teardownStream();
    },
    get isActive(): boolean {
      return active;
    },
    get isPaused(): boolean {
      return paused;
    },
  };
  return session;
}
