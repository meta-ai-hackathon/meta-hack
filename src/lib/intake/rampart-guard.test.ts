// HACK-107: RampartShield properties. Rampart itself is heavily tested in
// its own repo; here we pin the *host app* behaviors:
// - typed sends are blocked (never the raw text) until the guard is ready,
//   or when a single protect() pass throws, or when load fails entirely;
// - tokens stay stable across a reload by restoring the sealed session —
//   and a missing/tampered envelope degrades to a fresh session without
//   throwing;
// - the serialized session (raw PII) is only ever written through the
//   sealed store, never in plaintext, and reveal() never fails a display.
import { describe, expect, it } from "vitest";
import type { ChatGuard, GuardOptions, ScrubResult } from "@nationaldesignstudio/rampart";
import type { DeviceKv, KvGuard } from "../device-kv";
import {
  DEVICE_SESSION_ENVELOPE_KEY,
  purgeDeviceAnswers,
  type DeviceAnswerStoreDeps,
} from "./device-answer-store";
import { RampartShield, type RampartShieldDeps } from "./rampart-guard";

function memoryKv() {
  const store = new Map<string, unknown>();
  const kv: DeviceKv = {
    getMany: async (keys) => keys.map((k) => store.get(k)),
    setMany: async (entries, guard?: KvGuard) => {
      if (guard !== undefined && guard.keep(store.get(guard.key))) return false;
      for (const [key, value] of entries) store.set(key, value);
      return true;
    },
    deleteMany: async (keys, guard?: KvGuard) => {
      if (guard !== undefined && guard.keep(store.get(guard.key))) return false;
      for (const key of keys) store.delete(key);
      return true;
    },
  };
  return { kv, store };
}

const deps = (kv: DeviceKv): DeviceAnswerStoreDeps => ({ kv, subtle: crypto.subtle });

/**
 * A scripted guard standing in for Rampart's ChatGuard. protect() swaps
 * "Carlos" for [GIVEN_NAME_1]; reveal() restores it. The serialized form is
 * a JSON object whose entries mirror the map — deterministic, no model, no
 * network. Where the fixture supports it, the fake also honors a restored
 * `session` so cross-restart behavior can be exercised end to end.
 */
function scriptedGuard(options: GuardOptions = {}, throwOnProtect = false): ChatGuard {
  // Like the real ChatGuard with a restored session, the map is populated
  // from `session` at construction time, before any protect() call.
  const parse = (serialized: string): Map<string, string> => {
    const data = JSON.parse(serialized) as { entries?: { token: string; value: string }[] };
    const out = new Map<string, string>();
    for (const entry of data.entries ?? []) out.set(entry.token, entry.value);
    return out;
  };
  const restored: string | null =
    typeof options.session === "string" ? options.session : null;
  const map: Map<string, string> =
    restored === null ? new Map() : parse(restored);

  return {
    protect: async (text: string): Promise<ScrubResult> => {
      if (throwOnProtect) throw new Error("protect failed");
      if (!text.includes("Carlos")) {
        return { text, placeholders: [] };
      }
      map.set("[GIVEN_NAME_1]", "Carlos");
      return { text: text.replaceAll("Carlos", "[GIVEN_NAME_1]"), placeholders: ["[GIVEN_NAME_1]"] };
    },
    reveal: (text: string): string => text.replaceAll("[GIVEN_NAME_1]", map.get("[GIVEN_NAME_1]") ?? "?"),
    serialize: (): string =>
      JSON.stringify({
        version: 1,
        entries: [...map].map(([token, value]) => ({ token, value })),
      }),
  } as unknown as ChatGuard;
}

function shieldDeps(build: {
  kv: DeviceKv | null;
  failCreate?: boolean;
  throwOnProtect?: boolean;
}): RampartShieldDeps {
  const kv = build.kv;
  return {
    createGuard: async (options) => {
      if (build.failCreate === true) throw new Error("model load failed");
      return scriptedGuard(options ?? {}, build.throwOnProtect === true);
    },
    openStore: async () => (kv === null ? null : deps(kv)),
  };
}

describe("RampartShield", () => {
  it("starts ready and tokenizes a typed send", async () => {
    const { kv } = memoryKv();
    const shield = new RampartShield(shieldDeps({ kv }));
    await shield.start();
    expect(shield.status).toBe("ready");
    const out = await shield.protectTyped("My name is Carlos.");
    expect(out).toEqual({ kind: "tokenized", text: "My name is [GIVEN_NAME_1]." });
  });

  it("blocks every typed send until the shield is ready", async () => {
    const { kv } = memoryKv();
    const shield = new RampartShield(shieldDeps({ kv }));
    // Not started yet — never send the raw text.
    expect(await shield.protectTyped("Carlos")).toEqual({ kind: "blocked" });
    await shield.start();
    expect(await shield.protectTyped("Carlos")).toEqual({ kind: "tokenized", text: "[GIVEN_NAME_1]" });
  });

  it("blocked typed sends when createGuard fails, and stays failed", async () => {
    const { kv } = memoryKv();
    const shield = new RampartShield(shieldDeps({ kv, failCreate: true }));
    expect(shield.status).toBe("loading");
    await shield.start();
    expect(shield.status).toBe("failed");
    expect(await shield.protectTyped("Carlos")).toEqual({ kind: "blocked" });
  });

  it("blocks a typed send when a single protect() pass throws", async () => {
    const { kv } = memoryKv();
    const shield = new RampartShield(shieldDeps({ kv, throwOnProtect: true }));
    await shield.start();
    expect(await shield.protectTyped("Carlos")).toEqual({ kind: "blocked" });
  });

  it("keeps tokens stable across a reload by restoring the sealed session", async () => {
    const first = memoryKv();
    const a = new RampartShield(shieldDeps({ kv: first.kv }));
    await a.start();
    await a.protectTyped("My name is Carlos and my case is about Medicaid.");

    // Reload: a new shield with the same device storage.
    const bDeps = shieldDeps({ kv: first.kv });
    const b = new RampartShield(bDeps);
    await b.start();
    // reveal() of an old token-bearing display restores the same person.
    expect(b.reveal("Hello [GIVEN_NAME_1], welcome back")).toBe(
      "Hello Carlos, welcome back",
    );
  });

  it("degrades to a fresh session on a tampered envelope without throwing", async () => {
    const { kv, store } = memoryKv();
    store.set(DEVICE_SESSION_ENVELOPE_KEY, "sealed3.notreallybase64");
    const shield = new RampartShield(shieldDeps({ kv }));
    await expect(shield.start()).resolves.toBeUndefined();
    expect(shield.status).toBe("ready");
    // Fresh map: nothing to restore, so tokens stay literal until re-seen.
    expect(shield.reveal("Hello [GIVEN_NAME_1]")).toBe("Hello ?");
  });

  it("never writes the raw serialized session in plaintext", async () => {
    const { kv, store } = memoryKv();
    const shield = new RampartShield(shieldDeps({ kv }));
    await shield.start();
    await shield.protectTyped("Carlos");
    const envelope = store.get(DEVICE_SESSION_ENVELOPE_KEY);
    expect(typeof envelope).toBe("string");
    // The sealed envelope is opaque storage text; neither the raw value nor
    // the plaintext serialized map may appear in it.
    const raw = JSON.stringify([...store.values()]);
    expect(raw).not.toContain("Carlos");
    expect(raw).not.toContain("GIVEN_NAME_1\"], \"value\": \"Carlos");
  });

  it("keeps typed sends working without device storage (in-memory only)", async () => {
    const shield = new RampartShield(shieldDeps({ kv: null }));
    await shield.start();
    expect(shield.status).toBe("ready");
    expect(await shield.protectTyped("Carlos here")).toEqual({
      kind: "tokenized",
      text: "[GIVEN_NAME_1] here",
    });
  });

  it("a save after a user-confirmed purge does not recreate the sealed session", async () => {
    const { kv, store } = memoryKv();
    const shield = new RampartShield(shieldDeps({ kv }));
    await shield.start();
    await shield.protectTyped("My name is Carlos.");
    expect(store.size).toBeGreaterThan(0);
    // The answers-notice purge (HACK-80) deletes every envelope and the key.
    expect(await purgeDeviceAnswers(deps(kv))).toBe(true);
    // The next typed send must not resurrect the pre-purge PII map: nothing
    // is written again once the confirmed purge is observed.
    await shield.protectTyped("My name is Carlos, again.");
    expect(store.size).toBe(0);
    expect(shield.status).toBe("ready");
    expect(await shield.protectTyped("Still Carlos here.")).toEqual({
      kind: "tokenized",
      text: "Still [GIVEN_NAME_1] here.",
    });
  });

  it("reveal() is safe before start and on unknown tokens", async () => {
    const { kv } = memoryKv();
    const shield = new RampartShield(shieldDeps({ kv }));
    expect(shield.reveal("[UNKNOWN_7]")).toBe("[UNKNOWN_7]");
    await shield.start();
    expect(shield.reveal("no tokens here")).toBe("no tokens here");
  });
});
