import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as answersDevice from "../device-kv";
import {
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  DEVICE_ANSWERS_ENVELOPE_KEY,
  DEVICE_SESSION_ENVELOPE_KEY,
  loadDeviceAnswers,
  purgeDeviceAnswers,
  recordDeviceAnswer,
  type DeviceAnswerStoreDeps,
} from "../intake/device-answer-store";
import { serializeClientAnswers } from "../intake/client-store";
import { loadRampartSession, saveRampartSession } from "../intake/rampart-session-store";
import { QUESTIONS } from "../intake/spec";
import { formatIsoDate, fromEpochDay, parseIsoDate, toEpochDay } from "./calendar-date";
import * as reminderDevice from "./device-kv";
import { REPORTED_DATE_MAX, REPORTED_DATE_MIN, RENEWAL_REMINDER_VERSION, type RenewalReminder } from "./reminder";
import {
  REMINDER_CRYPTO_KEY_KEY,
  REMINDER_ENVELOPE_KEY,
  clearReminder,
  loadReminder,
  saveReminder,
  type DeviceKv,
  type ReminderStoreDeps,
} from "./reminder-store";

// The step-by-step page's answers (HACK-99) and the renewal reminder
// (HACK-50) live in the same IndexedDB object store on the device, the
// "kv" store of the benefits-navigator-device database, written through two
// adapters. The answers' side also holds the sealed Rampart session table
// (HACK-107), sealed under the answers' key and deleted with them. Each
// side must read and write only its own keys, so removing the reminder
// never takes an answer or the session with it, and deleting the answers
// never takes the reminder. The in-memory store below is that one object
// store: it structured-clones like IndexedDB and records every key a call
// reads or writes.

const ENTRY_ID = "nc_medicaid_renewal";
const CALENDAR_ID = "0123456789abcdef0123456789abcdef";
const REMINDER_KEYS = new Set([REMINDER_ENVELOPE_KEY, REMINDER_CRYPTO_KEY_KEY]);
const ANSWER_KEYS = new Set([
  DEVICE_ANSWERS_ENVELOPE_KEY,
  DEVICE_SESSION_ENVELOPE_KEY,
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
]);

function sharedObjectStore() {
  const entries = new Map<string, unknown>();
  let touched = new Set<string>();
  const kv: DeviceKv = {
    getMany: async (keys) => {
      keys.forEach((key) => touched.add(key));
      return keys.map((key) => (entries.has(key) ? structuredClone(entries.get(key)) : undefined));
    },
    setMany: async (pairs, guard) => {
      if (guard !== undefined) {
        touched.add(guard.key);
        if (guard.keep(structuredClone(entries.get(guard.key)))) {
          return false;
        }
      }
      for (const [key, value] of pairs) {
        touched.add(key);
        entries.set(key, structuredClone(value));
      }
      return true;
    },
    deleteMany: async (keys, guard) => {
      if (guard !== undefined) {
        touched.add(guard.key);
        if (guard.keep(structuredClone(entries.get(guard.key)))) {
          return false;
        }
      }
      for (const key of keys) {
        touched.add(key);
        entries.delete(key);
      }
      return true;
    },
  };
  /** Run one call and return the keys it read or wrote. */
  async function keysTouchedBy(call: () => Promise<unknown>): Promise<ReadonlySet<string>> {
    touched = new Set();
    await call();
    return touched;
  }
  return { kv, entries, keysTouchedBy };
}

const minDay = toEpochDay(parseIsoDate(REPORTED_DATE_MIN)!);
const maxDay = toEpochDay(parseIsoDate(REPORTED_DATE_MAX)!);

/** What a person can do on either page, in any order. */
type Step =
  | { readonly kind: "save reminder"; readonly day: number; readonly revision: number }
  | { readonly kind: "remove reminder" }
  | { readonly kind: "answer"; readonly question: number }
  | { readonly kind: "save session"; readonly table: number }
  | { readonly kind: "delete answers" };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("save reminder" as const),
    day: fc.integer({ min: minDay, max: maxDay }),
    revision: fc.nat({ max: 50 }),
  }),
  fc.constant<Step>({ kind: "remove reminder" }),
  fc.record({ kind: fc.constant("answer" as const), question: fc.nat({ max: QUESTIONS.length - 1 }) }),
  fc.record({ kind: fc.constant("save session" as const), table: fc.nat({ max: 50 }) }),
  fc.constant<Step>({ kind: "delete answers" }),
);

describe("the reminder and the step-by-step answers share one device store", () => {
  it("each side touches only its own keys, so removing one never takes the other", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 12 }), async (steps) => {
        const device = sharedObjectStore();
        const subtle = globalThis.crypto.subtle;
        const reminderDeps: ReminderStoreDeps = {
          kv: device.kv,
          crypto: { subtle, getRandomValues: (array) => globalThis.crypto.getRandomValues(array) },
        };
        const answerDeps: DeviceAnswerStoreDeps = { kv: device.kv, subtle };
        const reminderNow = () => loadReminder(reminderDeps, [ENTRY_ID]);
        const answersNow = async () => {
          const loaded = await loadDeviceAnswers(answerDeps);
          return { status: loaded.status, answers: serializeClientAnswers(loaded.state) };
        };
        const sessionNow = () => loadRampartSession(answerDeps);
        for (const next of steps) {
          // What the other side holds before this step, to compare after it.
          const reminderBefore = await reminderNow();
          const answersBefore = await answersNow();
          const sessionBefore = await sessionNow();
          let touched: ReadonlySet<string>;
          switch (next.kind) {
            case "save reminder": {
              const reminder: RenewalReminder = {
                version: RENEWAL_REMINDER_VERSION,
                entryId: ENTRY_ID,
                kind: "renewal_due",
                reportedDate: formatIsoDate(fromEpochDay(next.day)),
                calendarId: CALENDAR_ID,
                revision: next.revision,
              };
              touched = await device.keysTouchedBy(() => saveReminder(reminder, reminderDeps));
              expect(await reminderNow()).toEqual({ status: "ok", reminder });
              break;
            }
            case "remove reminder":
              touched = await device.keysTouchedBy(() => clearReminder(reminderDeps));
              expect(await reminderNow()).toEqual({ status: "none" });
              break;
            case "answer": {
              const questionId = QUESTIONS[next.question].id;
              touched = await device.keysTouchedBy(() =>
                recordDeviceAnswer(
                  answerDeps,
                  { questionId, status: "unknown", provenance: "user_supplied", value: null },
                  { expectStored: false },
                ),
              );
              break;
            }
            case "save session": {
              // The store keeps the serialized table as an opaque string, so
              // a synthetic stand-in is enough here.
              const serialized = `synthetic-session-table-${next.table}`;
              touched = await device.keysTouchedBy(() => saveRampartSession(answerDeps, serialized));
              expect(await sessionNow()).toEqual({ status: "ok", serialized });
              break;
            }
            case "delete answers":
              touched = await device.keysTouchedBy(() => purgeDeviceAnswers(answerDeps));
              expect((await answersNow()).status).toBe("none");
              break;
          }
          const reminderStep = next.kind === "save reminder" || next.kind === "remove reminder";
          const own = reminderStep ? REMINDER_KEYS : ANSWER_KEYS;
          expect([...touched].filter((key) => !own.has(key))).toEqual([]);
          // The other side is exactly as it was.
          if (reminderStep) {
            expect(await answersNow()).toEqual(answersBefore);
            expect(await sessionNow()).toEqual(sessionBefore);
          } else {
            expect(await reminderNow()).toEqual(reminderBefore);
          }
        }
        // Reading back never strays either.
        expect([...(await device.keysTouchedBy(reminderNow))].filter((key) => !REMINDER_KEYS.has(key))).toEqual([]);
        expect([...(await device.keysTouchedBy(answersNow))].filter((key) => !ANSWER_KEYS.has(key))).toEqual([]);
        expect([...(await device.keysTouchedBy(sessionNow))].filter((key) => !ANSWER_KEYS.has(key))).toEqual([]);
        // Nothing else was ever stored in the shared store.
        for (const key of device.entries.keys()) {
          expect(REMINDER_KEYS.has(key) || ANSWER_KEYS.has(key)).toBe(true);
        }
      }),
      { numRuns: 40 },
    );
  });
});

type Handler = ((event: unknown) => void) | null;

interface FakeConnection {
  onversionchange: Handler;
  readonly isOpen: () => boolean;
  readonly close: () => void;
}

interface VersionedDatabase {
  version: number;
  readonly stores: Map<string, Map<string, unknown>>;
  /** Connections not closed yet. */
  readonly connections: Set<FakeConnection>;
  /** Newer opens waiting for every older connection to close. */
  readonly waiting: (() => void)[];
}

/**
 * An IndexedDB stand-in that keeps the rules two openers of one database
 * can trip over: opening below the stored version fails with a
 * VersionError, opening above it runs that opener's upgrade first, and a
 * transaction on a store no upgrade made throws NotFoundError. Opening
 * above the stored version first fires versionchange at every open
 * connection; while any of them stays open, the newer open is blocked
 * and waits until the last one closes (review of the pin: a connection
 * that never closes holds back every later version). A closed connection
 * throws InvalidStateError on a transaction. It records each open as
 * name@version, and each blocked one too.
 */
function versionedIndexedDb() {
  const databases = new Map<string, VersionedDatabase>();
  const opens: string[] = [];
  const blocked: string[] = [];
  function connection(db: VersionedDatabase): FakeConnection & Record<string, unknown> {
    let open = true;
    const handle: FakeConnection & Record<string, unknown> = {
      onversionchange: null,
      isOpen: () => open,
      objectStoreNames: { contains: (name: string) => db.stores.has(name) },
      createObjectStore: (name: string) => {
        db.stores.set(name, new Map());
      },
      close: () => {
        if (!open) {
          return;
        }
        open = false;
        db.connections.delete(handle);
        if (db.connections.size === 0) {
          for (const proceed of db.waiting.splice(0)) {
            proceed();
          }
        }
      },
      transaction: (name: string) => {
        if (!open) {
          throw new DOMException("the connection is closed", "InvalidStateError");
        }
        const store = db.stores.get(name);
        if (store === undefined) {
          throw new DOMException(`no object store named ${name}`, "NotFoundError");
        }
        const transaction: Record<string, unknown> & { oncomplete: Handler } = {
          oncomplete: null,
          onerror: null,
          onabort: null,
          error: null,
          abort: () => undefined,
        };
        let pending = 0;
        let finished = false;
        // Completes once no request is left, a transaction with none included.
        const maybeComplete = () =>
          queueMicrotask(() => {
            if (pending === 0 && !finished) {
              finished = true;
              transaction.oncomplete?.({});
            }
          });
        const request = (operation: () => unknown) => {
          const pendingRequest: Record<string, unknown> & { onsuccess: Handler } = { result: undefined, onsuccess: null };
          pending += 1;
          queueMicrotask(() => {
            pendingRequest.result = operation();
            pendingRequest.onsuccess?.({});
            pending -= 1;
            maybeComplete();
          });
          return pendingRequest;
        };
        transaction.objectStore = () => ({
          get: (key: string) => request(() => structuredClone(store.get(key))),
          put: (value: unknown, key: string) => request(() => store.set(key, structuredClone(value))),
          delete: (key: string) => request(() => store.delete(key)),
        });
        maybeComplete();
        return transaction;
      },
    };
    db.connections.add(handle);
    return handle;
  }
  const factory = {
    open(name: string, version?: number) {
      opens.push(`${name}@${version}`);
      const request: Record<string, unknown> & {
        onsuccess: Handler;
        onerror: Handler;
        onupgradeneeded: Handler;
        onblocked: Handler;
      } = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      queueMicrotask(() => {
        const db: VersionedDatabase = databases.get(name) ?? {
          version: 0,
          stores: new Map(),
          connections: new Set(),
          waiting: [],
        };
        const wanted = version ?? Math.max(db.version, 1);
        if (wanted < db.version) {
          request.error = new DOMException(`${name} is at version ${db.version}, above ${wanted}`, "VersionError");
          request.onerror?.({});
          return;
        }
        databases.set(name, db);
        const proceed = () => {
          request.result = connection(db);
          if (wanted > db.version) {
            db.version = wanted;
            request.onupgradeneeded?.({});
          }
          request.onsuccess?.({});
        };
        if (wanted > db.version && db.connections.size > 0) {
          // A newer version asks every open connection to close first.
          for (const older of [...db.connections]) {
            older.onversionchange?.({ oldVersion: db.version, newVersion: wanted });
          }
          if (db.connections.size > 0) {
            blocked.push(`${name}@${wanted}`);
            request.onblocked?.({});
            db.waiting.push(proceed);
            return;
          }
        }
        proceed();
      });
      return request;
    },
  };
  /**
   * Open the way a newer build's opener would, with no adapter: resolves
   * with the connection once it opens, and whether it was blocked first.
   */
  function openDirectly(name: string, version: number): Promise<{ connection: FakeConnection; wasBlocked: boolean }> {
    return new Promise((resolve, reject) => {
      const request = factory.open(name, version);
      let wasBlocked = false;
      request.onblocked = () => {
        wasBlocked = true;
      };
      request.onsuccess = () => resolve({ connection: request.result as FakeConnection, wasBlocked });
      request.onerror = () => reject(request.error);
    });
  }
  const openConnections = () => databases.get(answersDevice.DEVICE_DB_NAME)?.connections.size ?? 0;
  const storeNames = () => [...(databases.get(answersDevice.DEVICE_DB_NAME)?.stores.keys() ?? [])].sort();
  return { factory: factory as unknown as IDBFactory, opens, blocked, openDirectly, openConnections, storeNames };
}

/** Let every queued microtask, and so every pending fake request, run. */
const settled = () => new Promise<void>((done) => setTimeout(done, 0));

describe("both adapters open the one device database the same way (review of 7fbeb3c)", () => {
  // The answers' adapter (src/lib/device-kv.ts) and the reminder's
  // (./device-kv.ts) each open benefits-navigator-device with an upgrade
  // of their own. If one bumped the version or made another store without
  // the other, whichever opened second would get a VersionError or miss a
  // store. These pin the two openers together.
  const adapters = {
    answers: answersDevice.openIndexedDbKv,
    reminder: reminderDevice.openIndexedDbKv,
  };
  const SHARED_OPEN = `${answersDevice.DEVICE_DB_NAME}@${answersDevice.DEVICE_DB_VERSION}`;

  /** What one adapter asks for and makes on a device that has nothing yet. */
  async function freshOpen(open: (typeof adapters)[keyof typeof adapters]) {
    const device = versionedIndexedDb();
    await open(device.factory);
    return { opens: device.opens, stores: device.storeNames() };
  }

  it("name the same database, version, and store", () => {
    expect(reminderDevice.DEVICE_DB_NAME).toBe(answersDevice.DEVICE_DB_NAME);
    expect(reminderDevice.DEVICE_DB_VERSION).toBe(answersDevice.DEVICE_DB_VERSION);
    expect(reminderDevice.DEVICE_DB_STORE).toBe(answersDevice.DEVICE_DB_STORE);
  });

  it("open it at that version and make the same stores on a fresh device", async () => {
    const answers = await freshOpen(adapters.answers);
    expect(await freshOpen(adapters.reminder)).toEqual(answers);
    expect(answers.opens).toEqual([SHARED_OPEN]);
    expect(answers.stores).toContain(answersDevice.DEVICE_DB_STORE);
  });

  it("opened in any order on one device, each opens and reads what the other wrote (property)", async () => {
    const { stores: freshStores } = await freshOpen(adapters.answers);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("answers" as const, "reminder" as const), { minLength: 2, maxLength: 6 }),
        async (order) => {
          const device = versionedIndexedDb();
          const written: (readonly [string, number])[] = [];
          for (const [index, side] of order.entries()) {
            const kv = await adapters[side](device.factory);
            // Everything either side wrote before is there for this one.
            expect(await kv.getMany(written.map(([key]) => key))).toEqual(written.map(([, value]) => value));
            const entry = [`${side}-${index}`, index] as const;
            expect(await kv.setMany([entry])).toBe(true);
            written.push(entry);
          }
          expect(new Set(device.opens)).toEqual(new Set([SHARED_OPEN]));
          expect(device.storeNames()).toEqual(freshStores);
        },
      ),
    );
  });

  // A version bump only lands if every tab still on the old build lets go
  // of its connection when the newer build asks (review of the pin). The
  // first check shows the fake holds a newer version back while a
  // connection ignores the request, so the property after it can fail.
  const NEWER_VERSION = answersDevice.DEVICE_DB_VERSION + 1;

  it("hold a newer version back in the fake while a connection that ignores it stays open", async () => {
    const device = versionedIndexedDb();
    const ignoring = await device.openDirectly(answersDevice.DEVICE_DB_NAME, answersDevice.DEVICE_DB_VERSION);
    let opened = false;
    const newer = device.openDirectly(answersDevice.DEVICE_DB_NAME, NEWER_VERSION).then((result) => {
      opened = true;
      return result;
    });
    await settled();
    expect(device.blocked).toEqual([`${answersDevice.DEVICE_DB_NAME}@${NEWER_VERSION}`]);
    expect(opened).toBe(false);
    ignoring.connection.close();
    expect((await newer).wasBlocked).toBe(true);
    expect(device.openConnections()).toBe(1);
  });

  it("opened in any order on one device, each closes its connection when a newer version asks, so the newer open is never blocked (property)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("answers" as const, "reminder" as const), { minLength: 1, maxLength: 6 }),
        async (order) => {
          const device = versionedIndexedDb();
          const kvs: DeviceKv[] = [];
          for (const side of order) {
            kvs.push(await adapters[side](device.factory));
          }
          expect(device.openConnections()).toBe(order.length);
          // A newer build, in another tab, opens the next version.
          const newer = device.openDirectly(answersDevice.DEVICE_DB_NAME, NEWER_VERSION);
          await settled();
          expect(device.blocked).toEqual([]);
          expect((await newer).wasBlocked).toBe(false);
          // Only the newer build's connection is left, and the old ones
          // neither read nor write any more.
          expect(device.openConnections()).toBe(1);
          for (const kv of kvs) {
            await expect(kv.getMany([REMINDER_ENVELOPE_KEY])).rejects.toThrow();
          }
        },
      ),
    );
  });
});
