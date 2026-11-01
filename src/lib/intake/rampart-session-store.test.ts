// HACK-107: encrypted Rampart-session persistence properties.
// - No plaintext serialized session (raw PII) reaches storage.
// - A reload returns exactly what was saved.
// - Tampering or a wrong key fails closed to "unreadable".
// - A purge racing a save must not be undone by that save.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DeviceKv, KvGuard } from "../device-kv";
import {
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  DEVICE_ANSWERS_ENVELOPE_KEY,
  DEVICE_SESSION_ENVELOPE_KEY,
  purgeDeviceAnswers,
  type DeviceAnswerStoreDeps,
} from "./device-answer-store";
import { sealForStorage } from "./client-store";
import { loadRampartSession, saveRampartSession } from "./rampart-session-store";

function memoryKv(options: { beforeGuardedWrite?: (store: Map<string, unknown>) => void } = {}) {
  const store = new Map<string, unknown>();
  const counts = { writes: 0, deletes: 0 };
  const kv: DeviceKv = {
    getMany: async (keys) => keys.map((key) => store.get(key)),
    setMany: async (entries, guard?: KvGuard) => {
      if (guard !== undefined) {
        options.beforeGuardedWrite?.(store);
        if (guard.keep(store.get(guard.key))) {
          return false;
        }
      }
      for (const [key, value] of entries) store.set(key, value);
      counts.writes += 1;
      return true;
    },
    deleteMany: async (keys, guard?: KvGuard) => {
      if (guard !== undefined && guard.keep(store.get(guard.key))) return false;
      for (const key of keys) store.delete(key);
      counts.deletes += 1;
      return true;
    },
  };
  return { kv, store, counts };
}

function deps(kv: DeviceKv): DeviceAnswerStoreDeps {
  return { kv, subtle: crypto.subtle };
}

const SERIALIZED = JSON.stringify({ version: 1, entries: [{ token: "[SSN_1]", value: "123-45-6789" }] });

describe("rampart-session-store", () => {
  it("reuses a stored sealing key instead of rewriting it (HACK-107 review P1)", async () => {
    // An answers envelope saved first (a wizard answer landing before the
    // conversation send) owns the shared device key. The session save must
    // seal under that same key and never touch the key slot, so neither
    // envelope's key can be orphaned by the other writer.
    const { kv, store } = memoryKv();
    const d = deps(kv);
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const answersSealed = await sealForStorage(
      JSON.stringify({ records: {} }),
      key,
      crypto.subtle,
    );
    store.set(DEVICE_ANSWERS_ENVELOPE_KEY, answersSealed);
    store.set(DEVICE_ANSWERS_CRYPTO_KEY_KEY, key);

    expect(await saveRampartSession(d, SERIALIZED)).toBe("saved");
    expect(store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY)).toBe(key);
    // Both envelopes still open under the one stored key: an overlapping
    // first save can no longer orphan either writer's envelope.
    const sessionEnvelope = store.get(DEVICE_SESSION_ENVELOPE_KEY) as string;
    const { openSealed } = await import("./client-store");
    expect(await openSealed(sessionEnvelope, key, crypto.subtle)).toBe(SERIALIZED);
    expect(await openSealed(answersSealed, key, crypto.subtle)).toBe(
      JSON.stringify({ records: {} }),
    );
  });

  it("round-trips a saved session exactly", async () => {
    const { kv } = memoryKv();
    const d = deps(kv);
    expect(await saveRampartSession(d, SERIALIZED)).toBe("saved");
    expect(await loadRampartSession(d)).toEqual({ status: "ok", serialized: SERIALIZED });
  });

  it("never writes plaintext PII to storage", async () => {
    const { kv, store } = memoryKv();
    await saveRampartSession(deps(kv), SERIALIZED);
    for (const value of store.values()) {
      if (typeof value === "string") {
        expect(value).not.toContain("123-45-6789");
        expect(value).not.toContain(SERIALIZED);
      }
    }
    expect(typeof store.get(DEVICE_SESSION_ENVELOPE_KEY)).toBe("string");
  });

  it("returns none on an empty store", async () => {
    const { kv } = memoryKv();
    expect(await loadRampartSession(deps(kv))).toEqual({ status: "none" });
  });

  it("fails closed to unreadable on a tampered envelope", async () => {
    const { kv, store } = memoryKv();
    const d = deps(kv);
    await saveRampartSession(d, SERIALIZED);
    const sealed = store.get(DEVICE_SESSION_ENVELOPE_KEY) as string;
    const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
    store.set(DEVICE_SESSION_ENVELOPE_KEY, tampered);
    expect(await loadRampartSession(d)).toEqual({ status: "unreadable" });
  });

  it("fails closed to unreadable under a different sealing key", async () => {
    const a = memoryKv();
    await saveRampartSession(deps(a.kv), SERIALIZED);
    const sealed = a.store.get(DEVICE_SESSION_ENVELOPE_KEY);
    const b = memoryKv();
    // Seed B with a different key by saving there first, then swap in A's envelope.
    await saveRampartSession(deps(b.kv), JSON.stringify({ version: 1, entries: [] }));
    b.store.set(DEVICE_SESSION_ENVELOPE_KEY, sealed);
    expect(await loadRampartSession(deps(b.kv))).toEqual({ status: "unreadable" });
  });

  it("purge removes the saved session", async () => {
    const { kv } = memoryKv();
    const d = deps(kv);
    await saveRampartSession(d, SERIALIZED);
    await purgeDeviceAnswers(d);
    expect(await loadRampartSession(d)).toEqual({ status: "none" });
  });

  it("retries and saves when a concurrent write races it", async () => {
    let raced = false;
    const { kv } = memoryKv({
      beforeGuardedWrite: (store) => {
        if (!raced) { raced = true; store.set(DEVICE_SESSION_ENVELOPE_KEY, "sealed1.concurrent"); }
      },
    });
    const d = deps(kv);
    expect(await saveRampartSession(d, SERIALIZED)).toBe("saved");
    expect(await loadRampartSession(d)).toEqual({ status: "ok", serialized: SERIALIZED });
  });

  it("does not resurrect a purged session", async () => {
    let raced = false;
    let armed = false;
    const { kv } = memoryKv({
      beforeGuardedWrite: (s) => {
        if (armed && !raced) {
          raced = true;
          s.delete(DEVICE_SESSION_ENVELOPE_KEY);
        }
      },
    });
    const d = deps(kv);
    await saveRampartSession(d, SERIALIZED);
    armed = true;
    const result = await saveRampartSession(d, SERIALIZED, { expectStored: true });
    expect(result).toBe("purged");
    await expect(loadRampartSession(d)).resolves.toEqual({ status: "none" });
  });

  it("rejects empty sessions without writing", async () => {
    const { kv, counts } = memoryKv();
    await expect(saveRampartSession(deps(kv), "   ")).rejects.toThrow();
    expect(counts.writes).toBe(0);
  });
});

// Property-based round (repo rule): arbitrary opaque serialized sessions
// round-trip exactly and never land in storage as plaintext.
describe("rampart-session-store properties", () => {
  const SERIALIZATION_CHARS = [
    ..."abcdehilmnoprstuvwxyz0123456789",
    " ",
    String.fromCharCode(34),
    "[",
    "]",
    "{",
    "}",
    ",",
    ":",
    "_",
    "-",
  ] as const;
  const serializedArb = fc
    .string({ unit: fc.constantFrom(...SERIALIZATION_CHARS), minLength: 1, maxLength: 80 })
    .filter((text) => text.trim() !== "");

  it("save then load returns exactly the saved serialization, for arbitrary opaque sessions", async () => {
    await fc.assert(
      fc.asyncProperty(serializedArb, async (serialized) => {
        const { kv } = memoryKv();
        const d = deps(kv);
        expect(await saveRampartSession(d, serialized)).toBe("saved");
        expect(await loadRampartSession(d)).toEqual({ status: "ok", serialized });
      }),
    );
  });

  it("the stored envelope never contains any chunk of the plaintext session", async () => {
    await fc.assert(
      fc.asyncProperty(serializedArb, async (serialized) => {
        const { kv, store } = memoryKv();
        await saveRampartSession(deps(kv), serialized);
        const envelope = store.get(DEVICE_SESSION_ENVELOPE_KEY);
        expect(typeof envelope).toBe("string");
        const envelopeText = envelope as string;
        // Since each save seals under a fresh AES-GCM IV, the envelope is
        // random-looking: neither the session text nor a 16-char window of
        // it may appear verbatim.
        for (let at = 0; at + 8 <= serialized.length; at += 1) {
          const window = serialized.slice(at, Math.min(at + 16, serialized.length));
          if (window.length >= 8) {
            expect(envelopeText.includes(window)).toBe(false);
          }
        }
      }),
    );
  });
});
