import { describe, expect, it } from "vitest";
import {
  DEVICE_DB_NAME,
  DEVICE_DB_STORE,
  DeviceStorageTimeoutError,
  openDeviceKv,
  openIndexedDbKv,
  requestPersistentStorage,
} from "./device-kv";

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
});
