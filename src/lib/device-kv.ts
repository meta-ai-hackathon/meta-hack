/**
 * IndexedDB key-value storage on the person's device (HACK-99).
 *
 * IndexedDB rather than localStorage because a sealing key is a
 * non-extractable CryptoKey: IndexedDB can hold the key object itself
 * (structured clone keeps it unreadable), while localStorage holds only
 * strings, which would force the key bytes into script-readable form.
 * Every DeviceKv call is one IndexedDB transaction, so a key and the data it
 * sealed are always read and written as a pair, even with the site open in
 * several tabs. Browser-only; callers test their logic through an in-memory
 * DeviceKv, and this adapter through a fake IDBFactory.
 *
 * The renewal tracker (HACK-50, PR #55) keeps its reminder through the same
 * pattern in the same database and store, so the two can share this module
 * once both land.
 */

export const DEVICE_DB_NAME = "benefits-navigator-device";
export const DEVICE_DB_VERSION = 1;
export const DEVICE_DB_STORE = "kv";

/**
 * How long opening device storage may take before the page gives up and
 * says the answers cannot be kept (a browser that never settles the
 * request would otherwise leave the page on its loading line forever).
 */
export const DEVICE_STORAGE_TIMEOUT_MS = 5000;

/**
 * Tells deleteMany or setMany to leave the store as it is: decided inside
 * the call's own transaction.
 */
export interface KvGuard {
  /** The key whose current value decides. */
  readonly key: string;
  /** True when that value means the store must stay as it is (it changed since it was read). */
  readonly keep: (current: unknown) => boolean;
}

/** Minimal async key-value storage (IndexedDB in the browser). Every call is one transaction. */
export interface DeviceKv {
  /** Read several keys from one consistent snapshot. Missing keys read as undefined. */
  getMany(keys: readonly string[]): Promise<readonly unknown[]>;
  /**
   * Write several entries together: all of them land, or none do. With a
   * guard, the guard key is read in the same transaction and nothing is
   * written when `keep` returns true. Resolves to whether they were written.
   */
  setMany(entries: readonly (readonly [string, unknown])[], guard?: KvGuard): Promise<boolean>;
  /**
   * Delete several keys together. With a guard, the guard key is read in
   * the same transaction and nothing is deleted when `keep` returns true.
   * Resolves to whether the keys were deleted.
   */
  deleteMany(keys: readonly string[], guard?: KvGuard): Promise<boolean>;
}

export class DeviceStorageTimeoutError extends Error {
  constructor(what: string) {
    super(`${what} did not finish in time`);
    this.name = "DeviceStorageTimeoutError";
  }
}

/** Settle with `work`, or reject with DeviceStorageTimeoutError after `ms`. */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeviceStorageTimeoutError(what)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Whether this browser could keep anything on the device at all: IndexedDB
 * and Web Crypto (which needs a secure https or localhost page). False means
 * nothing was ever stored by this page in this browser; true with a failed
 * open means something may be stored that this visit cannot reach.
 */
export function deviceStorageSupported(): boolean {
  try {
    return (
      globalThis.indexedDB !== undefined &&
      globalThis.indexedDB !== null &&
      globalThis.crypto?.subtle !== undefined
    );
  } catch {
    // Some browsers throw on these reads when site storage is blocked.
    return false;
  }
}

function kvFromDatabase(db: IDBDatabase, onLost: () => void = () => undefined): DeviceKv {
  // The browser can close a connection under the page (site data cleared,
  // a newer version opened in another tab, the storage process restarting
  // on iOS). Drop the handle then, so the next call opens a fresh one
  // instead of failing for the rest of the visit.
  db.onversionchange = () => {
    db.close();
    onLost();
  };
  (db as IDBDatabase & { onclose: (() => void) | null }).onclose = () => onLost();

  /**
   * Run `work` in one transaction. `work` issues its requests and returns a
   * function that reads the outcome once the transaction has committed.
   */
  function transact<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => () => T,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let transaction: IDBTransaction;
      try {
        transaction = db.transaction(DEVICE_DB_STORE, mode);
      } catch (error) {
        // A closed connection throws here; the next call reopens.
        onLost();
        reject(error);
        return;
      }
      let outcome: (() => T) | undefined;
      transaction.oncomplete = () => {
        if (outcome) {
          resolve(outcome());
        } else {
          reject(new Error("device storage finished without a result"));
        }
      };
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("device storage failed"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("device storage was interrupted"));
      try {
        outcome = work(transaction.objectStore(DEVICE_DB_STORE));
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // Already finished; the rejection below is what matters.
        }
        reject(error);
      }
    });
  }

  return {
    getMany: (keys) =>
      transact("readonly", (store) => {
        const requests = keys.map((key) => store.get(key));
        return () => requests.map((request) => request.result as unknown);
      }),
    setMany: (entries, guard?: KvGuard) =>
      transact("readwrite", (store) => {
        let written = false;
        const write = () => {
          for (const [key, value] of entries) {
            store.put(value, key);
          }
          written = true;
        };
        if (guard === undefined) {
          write();
        } else {
          // Read and decide inside this transaction, as deleteMany does, so
          // no other tab's delete or write can land between the two.
          const request = store.get(guard.key);
          request.onsuccess = () => {
            if (!guard.keep(request.result)) {
              write();
            }
          };
        }
        return () => written;
      }),
    deleteMany: (keys, guard?: KvGuard) =>
      transact("readwrite", (store) => {
        let deleted = false;
        const remove = () => {
          for (const key of keys) {
            store.delete(key);
          }
          deleted = true;
        };
        if (guard === undefined) {
          remove();
        } else {
          // Read and decide inside this transaction, so no other tab's
          // write can land between the check and the delete.
          const request = store.get(guard.key);
          request.onsuccess = () => {
            if (!guard.keep(request.result)) {
              remove();
            }
          };
        }
        return () => deleted;
      }),
  };
}

/** Open (creating on first use) the device database through `factory`. */
export function openIndexedDbKv(
  factory: IDBFactory,
  timeoutMs: number = DEVICE_STORAGE_TIMEOUT_MS,
  onLost: () => void = () => undefined,
): Promise<DeviceKv> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        finish();
      }
    };
    const timer = setTimeout(
      () => settle(() => reject(new DeviceStorageTimeoutError("opening device storage"))),
      timeoutMs,
    );
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DEVICE_DB_NAME, DEVICE_DB_VERSION);
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEVICE_DB_STORE)) {
        db.createObjectStore(DEVICE_DB_STORE);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        // Opened after the deadline: release the connection nobody will use.
        request.result.close();
        return;
      }
      settle(() => resolve(kvFromDatabase(request.result, onLost)));
    };
    request.onerror = () =>
      settle(() => reject(request.error ?? new Error("device storage unavailable")));
    request.onblocked = () =>
      settle(() => reject(new Error("device storage is busy in another tab")));
  });
}

let sharedKv: Promise<DeviceKv | null> | undefined;

/**
 * This browser's device storage, or null when it has none that opens in
 * time (no IndexedDB, storage blocked, or a stalled open). One connection
 * is shared while it lasts; a failed open, or a connection the browser
 * closes, is replaced on the next call.
 */
export function openDeviceKv(): Promise<DeviceKv | null> {
  if (sharedKv === undefined) {
    let factory: IDBFactory | undefined;
    try {
      // Some browsers throw on this read when site storage is blocked.
      factory = globalThis.indexedDB ?? undefined;
    } catch {
      factory = undefined;
    }
    // `forget` runs only later (a failed open, or a connection the browser
    // closes), by which time `current` is set.
    const forget = () => {
      if (sharedKv === current) {
        sharedKv = undefined;
      }
    };
    const opening: Promise<DeviceKv | null> =
      factory === undefined
        ? Promise.resolve(null)
        : openIndexedDbKv(factory, DEVICE_STORAGE_TIMEOUT_MS, forget).catch(() => null);
    const current: Promise<DeviceKv | null> = opening.then((kv) => {
      if (kv === null) {
        forget();
      }
      return kv;
    });
    sharedKv = current;
  }
  return sharedKv;
}

/** The part of navigator.storage this needs. */
export interface PersistableStorage {
  persist?: () => Promise<boolean>;
}

/**
 * Ask the browser to keep this site's storage instead of evicting it under
 * storage pressure. Chromium and Firefox honor this; Safari's rule of
 * clearing a site's script storage after about a week without a visit does
 * not change. Resolves to whether the browser agreed; never rejects.
 */
export async function requestPersistentStorage(
  storage: PersistableStorage | undefined = globalThis.navigator?.storage,
): Promise<boolean> {
  try {
    return typeof storage?.persist === "function" ? (await storage.persist()) === true : false;
  } catch {
    return false;
  }
}
