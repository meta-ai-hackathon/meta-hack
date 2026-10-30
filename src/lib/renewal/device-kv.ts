import type { DeviceKv, KvGuard, ReminderStoreDeps } from "./reminder-store";

/**
 * IndexedDB key-value storage for the on-device reminder (BN-22 / HACK-50).
 *
 * IndexedDB rather than localStorage because the sealing key is a
 * non-extractable CryptoKey: IndexedDB can hold the key object itself
 * (structured clone keeps it unreadable), while localStorage holds only
 * strings, which would force the key bytes into script-readable form.
 * Every DeviceKv call is one IndexedDB transaction, so the key and the
 * sealed reminder are always read and written as a pair, even with the
 * site open in several tabs. Browser-only; the store's logic is tested
 * through an in-memory DeviceKv.
 */

export const DEVICE_DB_NAME = "benefits-navigator-device";
export const DEVICE_DB_VERSION = 1;
export const DEVICE_DB_STORE = "kv";

/**
 * How long opening or reading device storage may take before the page
 * gives up and offers the calendar file only (review fix: a browser that
 * never settles the request left the tracker on its loading line forever).
 */
export const DEVICE_STORAGE_TIMEOUT_MS = 5000;

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

function kvFromDatabase(db: IDBDatabase): DeviceKv {
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
    setMany: (entries) =>
      transact("readwrite", (store) => {
        for (const [key, value] of entries) {
          store.put(value, key);
        }
        return () => undefined;
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
      settle(() => resolve(kvFromDatabase(request.result)));
    };
    request.onerror = () =>
      settle(() => reject(request.error ?? new Error("device storage unavailable")));
    request.onblocked = () =>
      settle(() => reject(new Error("device storage is busy in another tab")));
  });
}

async function openStore(): Promise<ReminderStoreDeps | null> {
  const factory = globalThis.indexedDB;
  const crypto = globalThis.crypto;
  if (factory === undefined || crypto === undefined || crypto.subtle === undefined) {
    return null;
  }
  try {
    const kv = await openIndexedDbKv(factory);
    return {
      kv,
      crypto: {
        subtle: crypto.subtle,
        getRandomValues: (array) => crypto.getRandomValues(array),
      },
    };
  } catch {
    return null;
  }
}

let sharedStore: Promise<ReminderStoreDeps | null> | undefined;

/**
 * The reminder store's dependencies in this browser, or null when the
 * browser cannot keep a sealed reminder (no IndexedDB, no Web Crypto, which
 * needs a secure https or localhost page, or storage that does not open in
 * time). Callers then offer the calendar file only. One connection is
 * shared by the banner and the tracker for the page's life; a failed open
 * is retried on the next call.
 */
export function openDeviceReminderStore(): Promise<ReminderStoreDeps | null> {
  if (sharedStore === undefined) {
    sharedStore = openStore().then((deps) => {
      if (deps === null) {
        sharedStore = undefined;
      }
      return deps;
    });
  }
  return sharedStore;
}

/** The part of navigator.storage this needs. */
export interface PersistableStorage {
  persist?: () => Promise<boolean>;
}

/**
 * Ask the browser to keep this site's storage instead of evicting it under
 * storage pressure (review fix). Chromium and Firefox honor this; Safari's
 * rule of clearing a site's script storage after about a week without a
 * visit does not change, which is why the tracker's copy points to the
 * calendar file as the reminder that lasts. Resolves to whether the
 * browser agreed; never rejects.
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
