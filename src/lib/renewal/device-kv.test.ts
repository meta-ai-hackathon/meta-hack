import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  DEVICE_DB_NAME,
  DEVICE_DB_STORE,
  DeviceStorageTimeoutError,
  openDeviceReminderStore,
  openIndexedDbKv,
  requestPersistentStorage,
  withDeadline,
} from "./device-kv";
import { REMINDER_ENVELOPE_KEY, type ReminderStoreDeps } from "./reminder-store";

// The IndexedDB wrapper (HACK-50), driven through a small fake that follows
// the IndexedDB event contract: requests settle asynchronously and fire
// their success handlers, requests issued from a success handler join the
// same transaction, a transaction completes only once no request is left,
// upgrades run before success, values are structured clones, and a closed
// connection throws InvalidStateError on a transaction.

interface FakeDatabase {
  version: number;
  stores: Map<string, Map<string, unknown>>;
  upgrades: number;
  transactions: number;
  closed: number;
}

type Handler = ((event: unknown) => void) | null;

/** One connection, with the handlers the adapter sets on it. */
interface FakeConnection {
  onversionchange?: Handler;
  onclose?: Handler;
  /** The browser drops the connection with no event, as a storage process restart can. */
  dropQuietly: () => void;
}

function fakeIndexedDb(options: { failOpen?: boolean; neverOpen?: boolean; openAfterMs?: number } = {}) {
  const databases = new Map<string, FakeDatabase>();
  const connections: FakeConnection[] = [];
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
    let open = true;
    const connection = {
      dropQuietly: () => {
        open = false;
      },
      objectStoreNames: { contains: (store: string) => db.stores.has(store) },
      createObjectStore: (store: string) => {
        db.stores.set(store, new Map());
      },
      close: () => {
        open = false;
        db.closed += 1;
      },
      transaction: (storeName: string, mode: string) => {
        if (!open) {
          throw new DOMException("the connection is closed", "InvalidStateError");
        }
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
    connections.push(connection);
    return connection;
  }

  return { factory: factory as unknown as IDBFactory, databases, connections };
}

describe("openIndexedDbKv", () => {
  it("creates its store once and round-trips values, keys included, one transaction per call", async () => {
    const { factory, databases } = fakeIndexedDb();
    const kv = await openIndexedDbKv(factory);
    const db = databases.get(DEVICE_DB_NAME)!;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await kv.setMany([
      ["renewal-reminder-key", key],
      ["renewal-reminder", { iv: new Uint8Array([1, 2, 3]) }],
    ]);
    expect(db.transactions).toBe(1);
    const [storedKey, envelope, missing] = await kv.getMany(["renewal-reminder-key", "renewal-reminder", "missing"]);
    expect(db.transactions).toBe(2);
    expect((storedKey as CryptoKey).extractable).toBe(false);
    expect(envelope).toEqual({ iv: new Uint8Array([1, 2, 3]) });
    expect(missing).toBeUndefined();
    expect(await kv.deleteMany(["renewal-reminder", "renewal-reminder-key"])).toBe(true);
    expect(await kv.getMany(["renewal-reminder", "renewal-reminder-key"])).toEqual([undefined, undefined]);

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

  it("writes under a guard only when the guard says the value has not changed, in one transaction (third review)", async () => {
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

  it("gives up when opening never settles, and closes a connection that opens too late (review fix)", async () => {
    await expect(openIndexedDbKv(fakeIndexedDb({ neverOpen: true }).factory, 20)).rejects.toThrow(
      DeviceStorageTimeoutError,
    );
    const late = fakeIndexedDb({ openAfterMs: 40 });
    await expect(openIndexedDbKv(late.factory, 10)).rejects.toThrow(DeviceStorageTimeoutError);
    await new Promise((done) => setTimeout(done, 60));
    expect(late.databases.get(DEVICE_DB_NAME)!.closed).toBe(1);
  });
});

describe("withDeadline", () => {
  it("passes a result or an error through, and times out a promise that never settles", async () => {
    await expect(withDeadline(Promise.resolve(7), 50, "work")).resolves.toBe(7);
    await expect(withDeadline(Promise.reject(new Error("boom")), 50, "work")).rejects.toThrow("boom");
    await expect(withDeadline(new Promise(() => undefined), 10, "reading the reminder")).rejects.toThrow(
      /reading the reminder did not finish in time/,
    );
  });
});

describe("requestPersistentStorage (review fix: ask the browser not to evict the reminder)", () => {
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

describe("openDeviceReminderStore", () => {
  it("reports no store where the runtime has no IndexedDB (the calendar file still works)", async () => {
    expect(globalThis.indexedDB).toBeUndefined();
    expect(await openDeviceReminderStore()).toBeNull();
  });

  it("keeps one connection until the browser closes it, a newer version asks for it, or it is dropped, then opens a fresh one (review of the pin, property)", async () => {
    // What can happen between the page's calls, as the answers' adapter
    // (src/lib/device-kv.ts) handles it too. A newer version is the one
    // case where the adapter itself must close, or that version is
    // blocked for as long as this page stays open.
    const event = fc.constantFrom(
      "open",
      "browser closes it",
      "newer version asks",
      "dropped quietly",
      "an older connection closes late",
    );
    await fc.assert(
      fc.asyncProperty(fc.array(event, { maxLength: 10 }), async (events) => {
        const device = fakeIndexedDb();
        vi.resetModules();
        vi.stubGlobal("indexedDB", device.factory);
        try {
          const { openDeviceReminderStore: open } = await import("./device-kv");
          // The store the last open returned, while its connection lasts.
          let live: ReminderStoreDeps | null = null;
          let fresh = 0;
          for (const next of events) {
            const latest = device.connections.at(-1);
            if (next === "open") {
              const deps = await open();
              expect(deps).not.toBeNull();
              if (live === null) {
                fresh += 1;
              } else {
                expect(deps).toBe(live);
              }
              live = deps;
            } else if (next === "an older connection closes late") {
              // Never drops the live connection: the next open still returns it.
              const older = device.connections.length > 1 ? device.connections[0] : undefined;
              older?.onclose?.({});
            } else if (live !== null && latest !== undefined) {
              const db = device.databases.get(DEVICE_DB_NAME)!;
              const closedBefore = db.closed;
              if (next === "browser closes it") {
                latest.dropQuietly();
                latest.onclose?.({});
              } else if (next === "newer version asks") {
                latest.onversionchange?.({});
                expect(db.closed, "the adapter closes its connection for the newer version").toBe(closedBefore + 1);
              } else {
                latest.dropQuietly();
                // The next call on the old store fails, which is how the adapter learns.
                await expect(live.kv.getMany([REMINDER_ENVELOPE_KEY])).rejects.toThrow();
              }
              live = null;
            }
          }
          // One connection per stretch between losses.
          expect(device.connections).toHaveLength(fresh);
        } finally {
          vi.unstubAllGlobals();
          vi.resetModules();
        }
      }),
      { numRuns: 40 },
    );
  });
});
