import { describe, expect, it } from "vitest";
import type { DeviceKv, KvGuard } from "../device-kv";
import {
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  DEVICE_PLAID_ORIGINS_ENVELOPE_KEY,
  purgeDeviceAnswers,
  type DeviceAnswerStoreDeps,
} from "../intake/device-answer-store";
import {
  loadPlaidOrigins,
  parsePlaidOrigins,
  purgePlaidOrigins,
  savePlaidOrigins,
  withPlaidOriginUpdates,
} from "./origin-store";

// The institution name is pii:true, so the properties that matter are the
// ones a bug could silently break: the name reaching the device in
// plaintext, a reload losing it, a correction keeping a stale bank, and a
// purge leaving it behind while claiming success.

function memoryKv() {
  const store = new Map<string, unknown>();
  const kv: DeviceKv = {
    getMany: async (keys) => keys.map((key) => store.get(key)),
    setMany: async (entries, guard?: KvGuard) => {
      if (guard !== undefined && guard.keep(store.get(guard.key))) {
        return false;
      }
      for (const [key, value] of entries) {
        store.set(key, value);
      }
      return true;
    },
    deleteMany: async (keys, guard?: KvGuard) => {
      if (guard !== undefined && guard.keep(store.get(guard.key))) {
        return false;
      }
      for (const key of keys) {
        store.delete(key);
      }
      return true;
    },
  };
  return { kv, store };
}

function deps(kv: DeviceKv): DeviceAnswerStoreDeps {
  return { kv, subtle: crypto.subtle };
}

describe("the sealed Plaid institution-name map (HACK-140)", () => {
  it("reads as empty before anything is saved", async () => {
    const { kv } = memoryKv();
    expect(await loadPlaidOrigins(deps(kv))).toEqual({});
  });

  it("round-trips the name, sealed on disk and keyed by income question", async () => {
    const { kv, store } = memoryKv();
    const saved = await savePlaidOrigins(
      deps(kv),
      { job_income_amount: "First Platypus Bank" },
      { expectStored: false },
    );
    expect(saved).toEqual({
      status: "saved",
      origins: { job_income_amount: "First Platypus Bank" },
    });
    const raw = store.get(DEVICE_PLAID_ORIGINS_ENVELOPE_KEY);
    expect(typeof raw).toBe("string");
    expect(raw as string).not.toContain("First Platypus Bank");
    expect(await loadPlaidOrigins(deps(kv))).toEqual({
      job_income_amount: "First Platypus Bank",
    });
  });

  it("updates one question, keeps the other, and drops a corrected value's origin", async () => {
    const { kv } = memoryKv();
    const store = deps(kv);
    await savePlaidOrigins(
      store,
      {
        job_income_amount: "First Platypus Bank",
        job_income_frequency: "First Platypus Bank",
      },
      { expectStored: false },
    );
    const updated = await savePlaidOrigins(
      store,
      {
        job_income_amount: null,
        benefits_income_amount: "Second Bank",
      },
      { expectStored: true },
    );
    expect(updated).toEqual({
      status: "saved",
      origins: {
        job_income_frequency: "First Platypus Bank",
        benefits_income_amount: "Second Bank",
      },
    });
    expect(await loadPlaidOrigins(store)).toEqual({
      job_income_frequency: "First Platypus Bank",
      benefits_income_amount: "Second Bank",
    });
  });

  it("keeps only bounded names on the questions the Plaid card proposes", () => {
    expect(
      parsePlaidOrigins({
        job_income_amount: "  First Platypus Bank  ",
        job_income_frequency: "   ",
        income_sources: "Not an origin question",
        unknown_question: "Nowhere",
        benefits_income_amount: 42,
      }),
    ).toEqual({ job_income_amount: "First Platypus Bank" });
    expect(
      withPlaidOriginUpdates(
        { job_income_amount: "First Platypus Bank" },
        { job_income_amount: null },
      ),
    ).toEqual({});
  });

  it("purges only the origins envelope, leaving the shared key for the other stores", async () => {
    const { kv, store } = memoryKv();
    const storeDeps = deps(kv);
    await savePlaidOrigins(
      storeDeps,
      { job_income_amount: "First Platypus Bank" },
      { expectStored: false },
    );
    expect(await purgePlaidOrigins(storeDeps)).toBe(true);
    expect(await loadPlaidOrigins(storeDeps)).toEqual({});
    expect(store.has(DEVICE_PLAID_ORIGINS_ENVELOPE_KEY)).toBe(false);
    expect(store.has(DEVICE_ANSWERS_CRYPTO_KEY_KEY)).toBe(true);
  });

  it("deletes the origins with the answers in the full device purge", async () => {
    const { kv, store } = memoryKv();
    const storeDeps = deps(kv);
    await savePlaidOrigins(
      storeDeps,
      { job_income_amount: "First Platypus Bank" },
      { expectStored: false },
    );
    expect(await purgeDeviceAnswers(storeDeps)).toBe(true);
    expect(store.size).toBe(0);
    expect(await loadPlaidOrigins(storeDeps)).toEqual({});
  });

  it("reports purged, rather than recreating a map another tab deleted", async () => {
    const { kv } = memoryKv();
    const storeDeps = deps(kv);
    await savePlaidOrigins(
      storeDeps,
      { job_income_amount: "First Platypus Bank" },
      { expectStored: false },
    );
    await kv.deleteMany([DEVICE_PLAID_ORIGINS_ENVELOPE_KEY]);
    expect(
      await savePlaidOrigins(
        storeDeps,
        { benefits_income_amount: "Second Bank" },
        { expectStored: true },
      ),
    ).toEqual({ status: "purged" });
    expect(await loadPlaidOrigins(storeDeps)).toEqual({});
  });
});
