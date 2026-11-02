// HACK-107: RampartShield properties. Rampart itself is heavily tested in
// its own repo; here we pin the *host app* behaviors:
// - typed sends are blocked (never the raw text) until the guard is ready,
//   or when a single protect() pass throws, or when load fails entirely;
// - tokens stay stable across a reload by restoring the sealed session —
//   and a missing/tampered envelope degrades to a fresh session without
//   throwing;
// - the serialized session (raw PII) is only ever written through the
//   sealed store, never in plaintext, and reveal() never fails a display.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ChatGuard, GuardOptions, ScrubResult } from "@nationaldesignstudio/rampart";
import type { DeviceKv, KvGuard } from "../device-kv";
import {
  DEVICE_SESSION_ENVELOPE_KEY,
  purgeDeviceAnswers,
  type DeviceAnswerStoreDeps,
} from "./device-answer-store";
import type { PiiLabel, Span } from "@nationaldesignstudio/rampart";
import { dropAllowListed } from "@nationaldesignstudio/rampart";
import {
  RampartShield,
  BENEFITS_ALLOW_LIST,
  RAMPART_PERSON_NAME_LABELS,
  type RampartShieldDeps,
} from "./rampart-guard";
import { PILOT_CONFIG } from "../pilot";

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

  it("derives the pilot's own program name with the benefits allow-list", () => {
    // The single program-specific surface (PR #116 review finding): the
    // entry IS the PILOT_CONFIG value, not a second copy of it.
    expect(BENEFITS_ALLOW_LIST[0]).toBe(PILOT_CONFIG.programName);
  });

  it("threads the benefits allow-list to Rampart on fresh and restored starts", async () => {
    // Sealed, then reloaded: the restored branch must carry the option too.
    // An envelope exists only once a protect() call has introduced tokens.
    const { kv } = memoryKv();
    const field: Record<string, GuardOptions | undefined> = {};
    const first = new RampartShield(withCapture(field, kv));
    await first.start();
    await first.protectTyped("My name is Carlos.");
    await new RampartShield(withCapture(field, kv)).start();

    const seenStates = Object.values(field);
    expect(seenStates.length).toBe(2);
    for (const options of seenStates) {
      expect(options?.allowList).toEqual(BENEFITS_ALLOW_LIST);
      expect(options?.allowList).not.toBeUndefined();
    }
    // Exactly the restored branch carries the sealed session.
    expect(typeof seenStates[0]?.session).toBe("undefined");
    expect(typeof seenStates[1]?.session).toBe("string");
  });
});

// Property-based round (repo rule): the invariants the suite pin with
// examples above are asserted over arbitrary inputs against a simple
// scripted mapping guard — the shape the hosted Rampart guard gives us.
describe("RampartShield properties", () => {
  /** Arbitrary guest-name values (letters only after the first char guard). */
  const valueArb = fc
    .tuple(fc.constantFrom(..."ABCDEFGHJKLMNOPQRSTUVWXYZ"), fc.string({ unit: fc.constantFrom(..."abcdefghjkmnoprstuvwxyz"), minLength: 2, maxLength: 8 }))
    .map(([first, rest]) => `${first}${rest}`);
  const fillerArb = fc.string({
    unit: fc.constantFrom(..."abcdefghijkmnopqrstuvwxyz ."),
    minLength: 0,
    maxLength: 40,
  });

  /** A scripted guard mapping each value to a stable [GIVEN_NAME_N] token. */
  function mappingGuard(values: readonly string[]): ChatGuard {
    const ordinals = new Map<string, string>();
    for (const value of values) {
      if (!ordinals.has(value)) {
        ordinals.set(value, `[GIVEN_NAME_${ordinals.size + 1}]`);
      }
    }
    return {
      protect: async (text: string): Promise<ScrubResult> => {
        let out = text;
        for (const [value, token] of ordinals) {
          out = out.split(value).join(token);
        }
        return { text: out, placeholders: [...ordinals.values()] };
      },
      reveal: (text: string): string => {
        let out = text;
        for (const [value, token] of ordinals) {
          out = out.split(token).join(value);
        }
        return out;
      },
      serialize: () =>
        JSON.stringify({
          version: 1,
          entries: [...ordinals].map(([token, value]) => ({ token, value })),
        }),
    } as unknown as ChatGuard;
  }

  it("the same value always becomes the same token, across turns and reloads", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(valueArb, { minLength: 2, maxLength: 4 }),
        fc.array(fillerArb, { minLength: 1, maxLength: 3 }),
        async (values, fillers) => {
          const { kv } = memoryKv();
          const depsFor = (kv: DeviceKv | null): RampartShieldDeps => ({
            createGuard: async () => mappingGuard(values),
            openStore: async () => (kv === null ? null : deps(kv)),
          });
          const seen = new Map<string, string>();
          for (let turn = 0; turn < fillers.length + 1; turn += 1) {
            const turnValue = values[turn % values.length];
            const shield = new RampartShield(depsFor(kv));
            await shield.start();
            const out = await shield.protectTyped(
              `${fillers[turn % fillers.length]} ${turnValue} ${fillers[turn % fillers.length]}`,
            );
            if (out.kind !== "tokenized") return;
            const token = out.text.match(/\[[A-Z][A-Z_]*_\d+\]/)?.[0];
            if (!token) return;
            const prior = seen.get(turnValue);
            if (prior !== undefined) {
              expect(token).toBe(prior);
            } else {
              seen.set(turnValue, token);
            }
            // Never any raw mapped value in the tokenized send.
            expect(out.text).not.toContain(turnValue);
          }
          // Reload: the sealed session rehydrates the same token parity.
          const b = new RampartShield(depsFor(kv));
          await b.start();
          for (const [value, token] of seen) {
            expect(b.reveal(token)).toBe(value);
          }
        },
      ),
    );
  });

  it("the sealed store never holds a mapped raw value (persistent + plaintext-free)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(valueArb, { minLength: 1, maxLength: 4 }), async (values) => {
        const { kv, store } = memoryKv();
        const shield = new RampartShield({
          createGuard: async () => mappingGuard(values),
          openStore: async () => deps(kv),
        });
        await shield.start();
        for (const value of values) {
          const out = await shield.protectTyped(value);
          expect(out.kind).toBe("tokenized");
        }
        const dump = JSON.stringify([...store.entries()]);
        for (const value of values) {
          expect(dump).not.toContain(value);
        }
      }),
    );
  });
});

/**
 * A deps bundle whose factory records the options each startup passed to
 * Rampart, keyed in the order starts happen against the given device kv.
 */
function withCapture(seen: Record<string, GuardOptions | undefined>, kv: DeviceKv | null): RampartShieldDeps {
  const key = `start${Object.keys(seen).length}`;
  return {
    createGuard: async (options) => {
      seen[key] = options ?? undefined;
      return scriptedGuard(options ?? {});
    },
    openStore: async () => (kv === null ? null : deps(kv)),
  };
}

// Property-based round (repo rule): whatever sealed-store state a start
// encounters — absent device storage, a fresh store, a tampered envelope,
// or one sealed by a prior shield — the allow-list must reach Rampart
// unchanged and the session must be present exactly when the load
// recovered a readable envelope.
describe("RampartShield properties (allow-list threading)", () => {
  const stateArb = fc.constantFrom("none", "fresh", "tampered", "sealed");

  it("the benefits allow-list reaches Rampart from every storage state", async () => {
    await fc.assert(
      fc.asyncProperty(stateArb, async (state) => {
        const seen: GuardOptions[] = [];
        const { kv, store } = memoryKv();
        if (state !== "none") {
          // The prior-shield state leaves a valid sealed envelope behind.
          if (state === "sealed") {
            const prior = new RampartShield(withCapture({}, kv));
            await prior.start();
            await prior.protectTyped("Carlos");
          } else if (state === "tampered") {
            store.set(DEVICE_SESSION_ENVELOPE_KEY, "sealed3.notreallybase64");
          }
        }
        const snapshot = [...BENEFITS_ALLOW_LIST];
        const shield = new RampartShield({
          createGuard: async (options) => {
            seen.push(options ?? {});
            return scriptedGuard(options ?? {});
          },
          openStore: async () => (state === "none" ? null : deps(kv)),
        });
        await shield.start();

        expect(seen).toHaveLength(1);
        expect([...(seen[0].allowList ?? [])]).toEqual(BENEFITS_ALLOW_LIST);
        // The person-name skip set threads on every startup path as well
        // (PR #116 review P1): an entry that equals a person's name must
        // never exempt a span the detector tags GIVEN_NAME or SURNAME.
        expect([...(seen[0].allowListSkipLabels ?? [])]).toEqual(RAMPART_PERSON_NAME_LABELS);
        expect(typeof seen[0].session).toBe(state === "sealed" ? "string" : "undefined");
        // No startup path may mutate the shared vocabulary constant.
        expect([...BENEFITS_ALLOW_LIST]).toEqual(snapshot);
        expect(shield.status).toBe("ready");
      }),
    );
  });
});

/**
 * "my son Chip" under the app's allow-list (PR #116 review P1): the entry
 * "CHIP" must keep program mentions exempt without ever letting a
 * person-name span through, including against the real pinned policy code
 * (not the scripted stand-in above).
 */
describe("person-name skip labels (pinned policy seam)", () => {
  it("redacts a GIVEN_NAME span whose text equals the CHIP entry", () => {
    const spans: Span[] = [
      { label: "GIVEN_NAME", score: 0.9, source: "ner", start: 7, end: 11, text: "Chip" },
    ];
    const kept = dropAllowListed(spans, BENEFITS_ALLOW_LIST, new Set<PiiLabel>(RAMPART_PERSON_NAME_LABELS));
    // The name is NOT exempted; the policy keeps it for redaction.
    expect(kept).toEqual(spans);
  });

  it("still exempts a program-name span the detector does not tag as a person", () => {
    const spans: Span[] = [
      { label: "TAX_ID", score: 0.95, source: "ner", start: 18, end: 22, text: "CHIP" },
    ];
    const kept = dropAllowListed(spans, BENEFITS_ALLOW_LIST, new Set<PiiLabel>(RAMPART_PERSON_NAME_LABELS));
    expect(kept).toEqual([]);
  });
});
/**
 * The pinned fork's whole label surface, classified in one place (PR #116
 * review P2 - the "explicit set of non-person labels" route): the skip set
 * holds the person-name labels the exemption never touches, and the
 * exhaustive record below must name every remaining `PiiLabel` member as
 * eligible for a program-vocabulary exemption. The pinned tarball makes
 * the shipped union exact, so if a future pin introduces a label it will
 * survive `Exclude` into `EligibilityElsewhere` and the record will fail
 * `pnpm typecheck` naming it - a new upstream label reaches the exemption
 * only after the maintainer classifies it here, and a label that can
 * carry a person's name must go into RAMPART_PERSON_NAME_LABELS instead.
 */
type EligibilityElsewhere = Exclude<PiiLabel, (typeof RAMPART_PERSON_NAME_LABELS)[number]>;
const ELIGIBILITY_ELSEWHERE: Record<EligibilityElsewhere, true> = {
  SSN: true,
  CREDIT_CARD: true,
  IP_ADDRESS: true,
  EMAIL: true,
  PHONE: true,
  URL: true,
  TAX_ID: true,
  BANK_ACCOUNT: true,
  ROUTING_NUMBER: true,
  GOVERNMENT_ID: true,
  PASSPORT: true,
  DRIVERS_LICENSE: true,
  BUILDING_NUMBER: true,
  STREET_NAME: true,
  SECONDARY_ADDRESS: true,
  CITY: true,
  STATE: true,
  ZIP_CODE: true,
};

// The pinned surface's label count, asserted by the fork's own suite
// and re-stated here so the partition below fails loudly if the two
// classes ever stop summing to it.
const PII_LABEL_COUNT = 20;


describe("person-name skip labels (pinned label surface)", () => {
  it("classifies the pinned fork's whole label union as skipped or eligible", () => {
    // Runtime guards on top of the compile-time exhaustive record: the
    // skip set is non-empty and none of its labels also claim eligibility
    // - the two classes partition the union with no overlap.
    expect(RAMPART_PERSON_NAME_LABELS.length).toBeGreaterThan(0);
    expect(Object.keys(ELIGIBILITY_ELSEWHERE)).toHaveLength(PII_LABEL_COUNT - RAMPART_PERSON_NAME_LABELS.length);
    for (const label of RAMPART_PERSON_NAME_LABELS) {
      expect(Object.hasOwn(ELIGIBILITY_ELSEWHERE, label)).toBe(false);
    }
  });
});
