import { describe, expect, it, vi } from "vitest";
import {
  DEVICE_DB_NAME,
  DEVICE_DB_STORE,
  DeviceStorageTimeoutError,
  openDeviceKv,
  openIndexedDbKv,
  requestPersistentStorage,
} from "./device-kv";
import { QUESTIONS } from "./intake/spec";
import {
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  DEVICE_ANSWERS_ENVELOPE_KEY,
  loadDeviceAnswers,
  purgeDeviceAnswers,
  recordDeviceAnswer,
} from "./intake/device-answer-store";

// The IndexedDB wrapper (HACK-99, the renewal tracker's pattern), driven
// through a small fake that follows the IndexedDB event contract: requests
// settle asynchronously and fire their success handlers, requests issued
// from a success handler join the same transaction, a transaction completes
// only once no request is left, upgrades run before success, and values are
// structured clones (so a stored CryptoKey comes back as a key object).

interface FakeDatabase {
  version: number;
  stores: Map<string, Map<string, unknown>>;
  upgrades: number;
  transactions: number;
  closed: number;
}

type Handler = ((event: unknown) => void) | null;

function fakeIndexedDb(options: { failOpen?: boolean; neverOpen?: boolean; openAfterMs?: number } = {}) {
  const databases = new Map<string, FakeDatabase>();
  const factory = {
    open(name: string, version = 1) {
      const request: Record<string, unknown> & {
        onsuccess: Handler;
        onerror: Handler;
        onupgradeneeded: Handler;
        onblocked: Handler;
      } = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      if (options.neverOpen) {
        return request;
      }
      const run = () => {
        if (options.failOpen) {
          request.error = new Error("open failed");
          request.onerror?.({});
          return;
        }
        const db = databases.get(name) ?? { version: 0, stores: new Map(), upgrades: 0, transactions: 0, closed: 0 };
        databases.set(name, db);
        request.result = handle(db);
        if (version > db.version) {
          db.version = version;
          db.upgrades += 1;
          request.onupgradeneeded?.({});
        }
        request.onsuccess?.({});
      };
      if (options.openAfterMs !== undefined) {
        setTimeout(run, options.openAfterMs);
      } else {
        queueMicrotask(run);
      }
      return request;
    },
  };

  function handle(db: FakeDatabase) {
    return {
      objectStoreNames: { contains: (store: string) => db.stores.has(store) },
      createObjectStore: (store: string) => {
        db.stores.set(store, new Map());
      },
      close: () => {
        db.closed += 1;
      },
      transaction: (storeName: string, mode: string) => {
        db.transactions += 1;
        const transaction: Record<string, unknown> & { oncomplete: Handler; onerror: Handler; onabort: Handler } = {
          error: null,
          oncomplete: null,
          onerror: null,
          onabort: null,
          abort: () => undefined,
        };
        const store = db.stores.get(storeName)!;
        let pending = 0;
        let finished = false;
        const maybeComplete = () =>
          queueMicrotask(() => {
            if (pending === 0 && !finished) {
              finished = true;
              transaction.oncomplete?.({});
            }
          });
        const request = (operation: () => unknown) => {
          const pendingRequest: Record<string, unknown> & { onsuccess: Handler } = {
            result: undefined,
            error: null,
            onsuccess: null,
          };
          pending += 1;
          queueMicrotask(() => {
            pendingRequest.result = operation();
            pendingRequest.onsuccess?.({});
            pending -= 1;
            maybeComplete();
          });
          return pendingRequest;
        };
        const writable = () => {
          if (mode !== "readwrite") {
            throw new Error("read-only transaction");
          }
        };
        transaction.objectStore = () => ({
          get: (key: string) => request(() => structuredClone(store.get(key))),
          put: (value: unknown, key: string) => {
            writable();
            return request(() => {
              store.set(key, structuredClone(value));
              return key;
            });
          },
          delete: (key: string) => {
            writable();
            return request(() => {
              store.delete(key);
              return undefined;
            });
          },
        });
        return transaction;
      },
    };
  }

  return { factory: factory as unknown as IDBFactory, databases };
}

describe("openIndexedDbKv", () => {
  it("creates its store once and round-trips values, keys included, one transaction per call", async () => {
    const { factory, databases } = fakeIndexedDb();
    const kv = await openIndexedDbKv(factory);
    const db = databases.get(DEVICE_DB_NAME)!;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await kv.setMany([
      ["some-key", key],
      ["some-envelope", "sealed1.aaaa.bbbb"],
    ]);
    expect(db.transactions).toBe(1);
    const [storedKey, envelope, missing] = await kv.getMany(["some-key", "some-envelope", "missing"]);
    expect(db.transactions).toBe(2);
    expect((storedKey as CryptoKey).extractable).toBe(false);
    expect(envelope).toBe("sealed1.aaaa.bbbb");
    expect(missing).toBeUndefined();
    expect(await kv.deleteMany(["some-envelope", "some-key"])).toBe(true);
    expect(await kv.getMany(["some-envelope", "some-key"])).toEqual([undefined, undefined]);

    await openIndexedDbKv(factory);
    expect(db.upgrades).toBe(1);
    expect([...db.stores.keys()]).toEqual([DEVICE_DB_STORE]);
  });

  it("deletes under a guard only when the guard says the value has not changed, in one transaction", async () => {
    const { factory, databases } = fakeIndexedDb();
    const kv = await openIndexedDbKv(factory);
    await kv.setMany([
      ["a", 1],
      ["b", 2],
    ]);
    const before = databases.get(DEVICE_DB_NAME)!.transactions;
    const seen: unknown[] = [];
    expect(
      await kv.deleteMany(["a", "b"], {
        key: "a",
        keep: (current) => {
          seen.push(current);
          return current !== 1;
        },
      }),
    ).toBe(true);
    expect(databases.get(DEVICE_DB_NAME)!.transactions - before).toBe(1);
    expect(seen).toEqual([1]);
    expect(await kv.getMany(["a", "b"])).toEqual([undefined, undefined]);

    await kv.setMany([
      ["a", "replaced"],
      ["b", 2],
    ]);
    expect(await kv.deleteMany(["a", "b"], { key: "a", keep: (current) => current === "replaced" })).toBe(false);
    expect(await kv.getMany(["a", "b"])).toEqual(["replaced", 2]);
  });

  it("writes under a guard only when the guard says the value has not changed, in one transaction", async () => {
    const { factory, databases } = fakeIndexedDb();
    const kv = await openIndexedDbKv(factory);
    expect(await kv.setMany([["a", 1]])).toBe(true);
    const before = databases.get(DEVICE_DB_NAME)!.transactions;
    const seen: unknown[] = [];
    expect(
      await kv.setMany(
        [
          ["a", 2],
          ["b", 3],
        ],
        {
          key: "a",
          keep: (current) => {
            seen.push(current);
            return current !== 1;
          },
        },
      ),
    ).toBe(true);
    expect(databases.get(DEVICE_DB_NAME)!.transactions - before).toBe(1);
    expect(seen).toEqual([1]);
    expect(await kv.getMany(["a", "b"])).toEqual([2, 3]);

    // The value changed since it was read (another tab removed it, say): nothing is written.
    await kv.deleteMany(["a", "b"]);
    expect(
      await kv.setMany(
        [
          ["a", 4],
          ["b", 5],
        ],
        { key: "a", keep: (current) => current !== 2 },
      ),
    ).toBe(false);
    expect(await kv.getMany(["a", "b"])).toEqual([undefined, undefined]);
  });

  it("rejects when the browser refuses to open storage", async () => {
    const { factory } = fakeIndexedDb({ failOpen: true });
    await expect(openIndexedDbKv(factory)).rejects.toThrow("open failed");
  });

  it("gives up when opening never settles, and closes a connection that opens too late", async () => {
    await expect(openIndexedDbKv(fakeIndexedDb({ neverOpen: true }).factory, 20)).rejects.toThrow(
      DeviceStorageTimeoutError,
    );
    const late = fakeIndexedDb({ openAfterMs: 40 });
    await expect(openIndexedDbKv(late.factory, 10)).rejects.toThrow(DeviceStorageTimeoutError);
    await new Promise((done) => setTimeout(done, 60));
    expect(late.databases.get(DEVICE_DB_NAME)!.closed).toBe(1);
  });
});

describe("the sealed answer store over IndexedDB", () => {
  it("keeps a non-extractable key and only ciphertext, survives a new connection, and purges both", async () => {
    const { factory, databases } = fakeIndexedDb();
    const first = { kv: await openIndexedDbKv(factory), subtle: crypto.subtle };
    const pii = QUESTIONS.find((question) => question.pii && question.type === "text");
    expect(pii, "the spec has a pii text question").toBeDefined();
    const saved = await recordDeviceAnswer(
      first,
      { questionId: pii!.id, status: "known", provenance: "user_supplied", value: "Private Value 1234" },
      { expectStored: false },
    );
    expect(saved.status).toBe("saved");

    const raw = databases.get(DEVICE_DB_NAME)!.stores.get(DEVICE_DB_STORE)!;
    expect((raw.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY) as CryptoKey).extractable).toBe(false);
    const envelope = raw.get(DEVICE_ANSWERS_ENVELOPE_KEY);
    expect(typeof envelope).toBe("string");
    expect(envelope as string).not.toContain("Private Value 1234");
    expect(envelope as string).not.toContain(pii!.id);
    await expect(
      crypto.subtle.exportKey("raw", raw.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY) as CryptoKey),
    ).rejects.toThrow();

    // A reload: a new connection to the same device storage reads it back.
    const second = { kv: await openIndexedDbKv(factory), subtle: crypto.subtle };
    const loaded = await loadDeviceAnswers(second);
    expect(loaded.status).toBe("ok");
    expect(loaded.state[pii!.id]?.value).toBe("Private Value 1234");

    expect(await purgeDeviceAnswers(second)).toBe(true);
    expect(raw.has(DEVICE_ANSWERS_ENVELOPE_KEY)).toBe(false);
    expect(raw.has(DEVICE_ANSWERS_CRYPTO_KEY_KEY)).toBe(false);
    expect((await loadDeviceAnswers(first)).status).toBe("none");
  });
});

describe("requestPersistentStorage", () => {
  it("asks when the browser can, and never throws", async () => {
    let asked = 0;
    expect(await requestPersistentStorage({ persist: async () => (asked += 1) > 0 })).toBe(true);
    expect(asked).toBe(1);
    expect(await requestPersistentStorage({ persist: async () => false })).toBe(false);
    expect(
      await requestPersistentStorage({
        persist: () => Promise.reject(new Error("not allowed")),
      }),
    ).toBe(false);
    expect(await requestPersistentStorage({})).toBe(false);
    expect(await requestPersistentStorage(undefined)).toBe(false);
  });
});

describe("openDeviceKv", () => {
  it("reports no device storage where the runtime has no IndexedDB", async () => {
    expect(globalThis.indexedDB).toBeUndefined();
    expect(await openDeviceKv()).toBeNull();
  });

  it("opens a fresh connection after the browser closes or upgrades the shared one", async () => {
    const { factory } = fakeIndexedDb();
    const handles: { onclose?: () => void; onversionchange?: () => void; close: () => void }[] = [];
    const tracking = {
      open(name: string, version?: number) {
        const request = (factory as unknown as { open: (n: string, v?: number) => Record<string, unknown> }).open(name, version);
        const onsuccess = () => {
          handles.push(request.result as (typeof handles)[number]);
        };
        return new Proxy(request, {
          set(target, key, value) {
            if (key === "onsuccess") {
              target.onsuccess = (event: unknown) => {
                onsuccess();
                (value as (event: unknown) => void)(event);
              };
              return true;
            }
            target[key as string] = value;
            return true;
          },
        });
      },
    };
    vi.resetModules();
    vi.stubGlobal("indexedDB", tracking);
    try {
      const fresh = await import("./device-kv");
      const first = await fresh.openDeviceKv();
      expect(first).not.toBeNull();
      expect(await fresh.openDeviceKv()).toBe(first);
      expect(handles).toHaveLength(1);

      handles[0].onclose?.();
      const second = await fresh.openDeviceKv();
      expect(second).not.toBe(first);
      expect(handles).toHaveLength(2);

      handles[1].onversionchange?.();
      const third = await fresh.openDeviceKv();
      expect(third).not.toBe(second);
      expect(handles).toHaveLength(3);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe("withDeadline", () => {
  it("passes a result or an error through, and times out work that never settles", async () => {
    const { withDeadline } = await import("./device-kv");
    await expect(withDeadline(Promise.resolve(7), 50, "work")).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error("boom")), 50, "work")).rejects.toThrow("boom");
    await expect(withDeadline(new Promise(() => undefined), 10, "reading device storage")).rejects.toThrow(
      /reading device storage did not finish in time/,
    );
  });
});
