import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatIsoDate, fromEpochDay, parseIsoDate, toEpochDay } from "./calendar-date";
import { AGE_ANSWERS } from "./estimate";
import { MAX_REMINDER_REVISION, RENEWAL_REMINDER_VERSION, type RenewalReminder } from "./reminder";
import {
  REMINDER_CRYPTO_KEY_KEY,
  REMINDER_ENVELOPE_FORMAT,
  REMINDER_ENVELOPE_KEY,
  clearReminder,
  isSealingKey,
  loadReminder,
  saveReminder,
  type DeviceKv,
  type ReminderStoreDeps,
} from "./reminder-store";

// The on-device reminder store (HACK-50): sealed with AES-GCM under a
// non-extractable key generated on the device, validated on every read,
// and safe with the site open in several tabs. The in-memory store
// structured-clones on every write and read, the way IndexedDB does, and
// treats each call as one atomic transaction; the crypto is Node's real
// Web Crypto.

const ENTRY_ID = "nc_medicaid_renewal";
const CALENDAR_ID = "0123456789abcdef0123456789abcdef";

type Pause = { readonly paused: Promise<void>; readonly resume: () => void };

function pause(): Pause {
  let resume!: () => void;
  const paused = new Promise<void>((done) => (resume = done));
  return { paused, resume };
}

/**
 * One tab's view of a shared device database. `beforeDeliver` runs after a
 * getMany has taken its snapshot and before the tab sees it, so a test can
 * let another tab write in between, as a slow transaction would.
 */
function memoryKv(
  entries = new Map<string, unknown>(),
  hooks: { beforeDeliver?: (keys: readonly string[]) => Promise<void> } = {},
): DeviceKv & { readonly entries: Map<string, unknown> } {
  return {
    entries,
    getMany: async (keys) => {
      const snapshot = keys.map((key) => (entries.has(key) ? structuredClone(entries.get(key)) : undefined));
      await hooks.beforeDeliver?.(keys);
      return snapshot;
    },
    setMany: async (pairs, guard) => {
      if (guard !== undefined && guard.keep(structuredClone(entries.get(guard.key)))) {
        return false;
      }
      for (const [key, value] of pairs) {
        entries.set(key, structuredClone(value));
      }
      return true;
    },
    deleteMany: async (keys, guard) => {
      if (guard !== undefined && guard.keep(structuredClone(entries.get(guard.key)))) {
        return false;
      }
      for (const key of keys) {
        entries.delete(key);
      }
      return true;
    },
  };
}

function deviceDeps(kv = memoryKv()): ReminderStoreDeps & { kv: ReturnType<typeof memoryKv> } {
  return {
    kv,
    crypto: {
      subtle: globalThis.crypto.subtle,
      getRandomValues: (array) => globalThis.crypto.getRandomValues(array),
    },
  };
}

const reminder = (overrides: Partial<RenewalReminder> = {}): RenewalReminder => ({
  version: RENEWAL_REMINDER_VERSION,
  entryId: ENTRY_ID,
  kind: "renewal_due",
  reportedDate: "2027-04-30",
  calendarId: CALENDAR_ID,
  revision: 0,
  ...overrides,
});

function storedBytes(kv: ReturnType<typeof memoryKv>): Uint8Array {
  const envelope = kv.entries.get(REMINDER_ENVELOPE_KEY) as { iv: Uint8Array; ciphertext: ArrayBuffer };
  return new Uint8Array([...envelope.iv, ...new Uint8Array(envelope.ciphertext)]);
}

function tamper(kv: ReturnType<typeof memoryKv>) {
  const envelope = kv.entries.get(REMINDER_ENVELOPE_KEY) as { ciphertext: ArrayBuffer };
  new Uint8Array(envelope.ciphertext)[0]! ^= 0x01;
}

describe("saving and loading", () => {
  it("round-trips a reminder through the sealed store", async () => {
    const deps = deviceDeps();
    await saveReminder(reminder(), deps);
    expect(await loadReminder(deps, [ENTRY_ID])).toEqual({ status: "ok", reminder: reminder() });
  });

  it("round-trips an approval date with its age answer", async () => {
    const deps = deviceDeps();
    const approval = reminder({ kind: "approval", ageAnswer: { min: 19, max: 64, answer: "unsure" }, revision: 4 });
    await saveReminder(approval, deps);
    expect(await loadReminder(deps, [ENTRY_ID])).toEqual({ status: "ok", reminder: approval });
  });

  it("reports nothing saved on a fresh device", async () => {
    expect(await loadReminder(deviceDeps(), [ENTRY_ID])).toEqual({ status: "none" });
  });

  it("never stores the date, or anything else, in readable form", async () => {
    const deps = deviceDeps();
    await saveReminder(reminder({ kind: "approval", ageAnswer: { min: 19, max: 64, answer: "no" } }), deps);
    const envelope = deps.kv.entries.get(REMINDER_ENVELOPE_KEY) as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(["ciphertext", "format", "iv", "version"]);
    expect(envelope.format).toBe(REMINDER_ENVELOPE_FORMAT);
    const bytes = Buffer.from(storedBytes(deps.kv)).toString("latin1");
    // The age answer is looked for as the sealed record writes it. A bare
    // "64" also turned up in random IV and ciphertext bytes, about once in
    // 300 runs, and failed a correct save.
    for (const secret of [
      "2027-04-30",
      "approval",
      ENTRY_ID,
      "reportedDate",
      CALENDAR_ID,
      "ageAnswer",
      '"min":19',
      '"max":64',
      '"answer":"no"',
    ]) {
      expect(bytes.includes(secret), secret).toBe(false);
    }
    expect(JSON.stringify([...deps.kv.entries.keys()])).not.toContain("2027");
  });

  it("keeps a key no script can read", async () => {
    const deps = deviceDeps();
    await saveReminder(reminder(), deps);
    const key = deps.kv.entries.get(REMINDER_CRYPTO_KEY_KEY);
    expect(isSealingKey(key)).toBe(true);
    await expect(globalThis.crypto.subtle.exportKey("raw", key as CryptoKey)).rejects.toThrow();
  });

  it("reuses the device key and draws a fresh IV for every save", async () => {
    const deps = deviceDeps();
    await saveReminder(reminder(), deps);
    const firstKey = deps.kv.entries.get(REMINDER_CRYPTO_KEY_KEY) as CryptoKey;
    const first = storedBytes(deps.kv);
    await saveReminder(reminder(), deps);
    const second = storedBytes(deps.kv);
    // Structured clone gives a new object; the key material is the same
    // when the first ciphertext still opens under the stored key.
    expect(Buffer.from(first.slice(0, 12)).equals(Buffer.from(second.slice(0, 12)))).toBe(false);
    expect(await loadReminder(deps, [ENTRY_ID])).toEqual({ status: "ok", reminder: reminder() });
    const reopened = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: first.slice(0, 12),
        additionalData: new TextEncoder().encode(`${REMINDER_ENVELOPE_FORMAT}@1`),
      },
      deps.kv.entries.get(REMINDER_CRYPTO_KEY_KEY) as CryptoKey,
      first.slice(12),
    );
    expect(reopened.byteLength).toBeGreaterThan(0);
    expect(isSealingKey(firstKey)).toBe(true);
  });

  it("removes both the sealed reminder and the key", async () => {
    const deps = deviceDeps();
    await saveReminder(reminder(), deps);
    await clearReminder(deps);
    expect(deps.kv.entries.size).toBe(0);
    expect(await loadReminder(deps, [ENTRY_ID])).toEqual({ status: "none" });
  });

  it("refuses to save anything but a current-version reminder", async () => {
    await expect(
      saveReminder({ ...reminder(), version: 2 } as unknown as RenewalReminder, deviceDeps()),
    ).rejects.toThrow(RangeError);
  });
});

describe("reading back trusts nothing", () => {
  async function savedThen(mutate: (deps: ReturnType<typeof deviceDeps>) => void) {
    const deps = deviceDeps();
    await saveReminder(reminder(), deps);
    mutate(deps);
    return { deps, result: await loadReminder(deps, [ENTRY_ID]) };
  }

  it("discards a tampered ciphertext and wipes the store", async () => {
    const { deps, result } = await savedThen((deps) => tamper(deps.kv));
    expect(result).toEqual({ status: "discarded" });
    expect(deps.kv.entries.size).toBe(0);
  });

  it("discards a reminder whose key is gone", async () => {
    const { deps, result } = await savedThen((deps) => deps.kv.entries.delete(REMINDER_CRYPTO_KEY_KEY));
    expect(result).toEqual({ status: "discarded" });
    expect(deps.kv.entries.has(REMINDER_ENVELOPE_KEY)).toBe(false);
  });

  it("discards a reminder sealed under another key", async () => {
    const other = deviceDeps();
    await saveReminder(reminder({ reportedDate: "2028-01-01" }), other);
    const { result } = await savedThen((deps) =>
      deps.kv.entries.set(REMINDER_ENVELOPE_KEY, other.kv.entries.get(REMINDER_ENVELOPE_KEY)),
    );
    expect(result).toEqual({ status: "discarded" });
  });

  it("discards a reminder for an entry this app no longer knows", async () => {
    const deps = deviceDeps();
    await saveReminder(reminder({ entryId: "retired_entry" }), deps);
    expect(await loadReminder(deps, [ENTRY_ID])).toEqual({ status: "discarded" });
    expect(deps.kv.entries.size).toBe(0);
  });

  it("leaves a reminder from a newer version alone", async () => {
    const { deps, result } = await savedThen((deps) => {
      const envelope = deps.kv.entries.get(REMINDER_ENVELOPE_KEY) as Record<string, unknown>;
      deps.kv.entries.set(REMINDER_ENVELOPE_KEY, { ...envelope, version: 2 });
    });
    expect(result).toEqual({ status: "unsupported" });
    expect(deps.kv.entries.has(REMINDER_ENVELOPE_KEY)).toBe(true);
  });

  it("discards any malformed envelope without throwing", async () => {
    const malformed = fc.oneof(
      fc.anything(),
      fc.record({
        format: fc.constantFrom(REMINDER_ENVELOPE_FORMAT, "something-else"),
        version: fc.constantFrom(1, 0, -1, "1", null),
        iv: fc.oneof(fc.uint8Array({ minLength: 0, maxLength: 16 }), fc.string()),
        ciphertext: fc.oneof(fc.uint8Array({ maxLength: 64 }).map((bytes) => bytes.buffer), fc.string()),
      }),
    );
    await fc.assert(
      fc.asyncProperty(malformed, async (envelope) => {
        const deps = deviceDeps();
        await saveReminder(reminder(), deps);
        deps.kv.entries.set(REMINDER_ENVELOPE_KEY, envelope);
        const result = await loadReminder(deps, [ENTRY_ID]);
        if (envelope === undefined || envelope === null) {
          expect(result).toEqual({ status: "none" });
        } else {
          expect(result.status).toBe("discarded");
        }
      }),
      { numRuns: 120 },
    );
  });

  it("round-trips every valid reminder (property)", async () => {
    const record = fc
      .record({
        version: fc.constant(RENEWAL_REMINDER_VERSION),
        entryId: fc.constant(ENTRY_ID),
        kind: fc.constantFrom("renewal_due" as const, "approval" as const),
        reportedDate: fc
          .integer({ min: toEpochDay(parseIsoDate("2000-01-01")!), max: toEpochDay(parseIsoDate("2100-12-31")!) })
          .map((day) => formatIsoDate(fromEpochDay(day))),
        calendarId: fc.uint8Array({ minLength: 16, maxLength: 16 }).map((bytes) => Buffer.from(bytes).toString("hex")),
        revision: fc.integer({ min: 0, max: MAX_REMINDER_REVISION }),
        answer: fc.option(fc.constantFrom(...AGE_ANSWERS), { nil: undefined }),
      })
      .map(({ answer, ...rest }): RenewalReminder =>
        rest.kind === "approval" && answer !== undefined
          ? { ...rest, ageAnswer: { min: 19, max: 64, answer } }
          : rest,
      );
    await fc.assert(
      fc.asyncProperty(record, async (value) => {
        const deps = deviceDeps();
        await saveReminder(value, deps);
        expect(await loadReminder(deps, [ENTRY_ID])).toEqual({ status: "ok", reminder: value });
      }),
      { numRuns: 60 },
    );
  });
});

describe("the banner reads without deleting (review fix: a dropped reminder is always announced)", () => {
  it("reports an unreadable reminder and leaves it for the tracker, which deletes and says so", async () => {
    const deps = deviceDeps();
    await saveReminder(reminder(), deps);
    tamper(deps.kv);
    expect(await loadReminder(deps, [ENTRY_ID], { readOnly: true })).toEqual({ status: "unreadable" });
    expect(deps.kv.entries.size).toBe(2);
    // An entry the app no longer knows reads the same way, read-only.
    expect(await loadReminder(deps, ["renamed_entry"], { readOnly: true })).toEqual({ status: "unreadable" });
    expect(await loadReminder(deps, [ENTRY_ID])).toEqual({ status: "discarded" });
    expect(deps.kv.entries.size).toBe(0);
  });

  it("reads a good reminder the same either way", async () => {
    const deps = deviceDeps();
    await saveReminder(reminder(), deps);
    expect(await loadReminder(deps, [ENTRY_ID], { readOnly: true })).toEqual({ status: "ok", reminder: reminder() });
  });
});

describe("several tabs at once (review fix: a slow read in one tab never wipes another tab's save)", () => {
  it("a tab mid-load while another removes and saves again reads a matching pair, and the new save survives", async () => {
    // The review's probe: tab B has read the old envelope when tab A
    // removes the reminder and saves a new one under a new key.
    const db = new Map<string, unknown>();
    const tabA = deviceDeps(memoryKv(db));
    await saveReminder(reminder({ reportedDate: "2027-04-30" }), tabA);
    const gate = pause();
    const tabB = deviceDeps(memoryKv(db, { beforeDeliver: () => gate.paused }));
    const bLoad = loadReminder(tabB, [ENTRY_ID]);
    await new Promise((done) => setTimeout(done, 0));
    await clearReminder(tabA);
    await saveReminder(reminder({ reportedDate: "2027-05-30", calendarId: "f".repeat(32) }), tabA);
    gate.resume();
    // B's snapshot is old but consistent, so it opens; nothing is deleted.
    expect(await bLoad).toEqual({ status: "ok", reminder: reminder({ reportedDate: "2027-04-30" }) });
    expect(await loadReminder(deviceDeps(memoryKv(db)), [ENTRY_ID])).toEqual({
      status: "ok",
      reminder: reminder({ reportedDate: "2027-05-30", calendarId: "f".repeat(32) }),
    });
  });

  it("a tab that read a broken reminder keeps the fresh one another tab saved before its delete", async () => {
    const db = new Map<string, unknown>();
    const tabA = deviceDeps(memoryKv(db));
    await saveReminder(reminder(), tabA);
    tamper(tabA.kv);
    const gate = pause();
    let delivered = false;
    const tabB = deviceDeps(
      memoryKv(db, {
        beforeDeliver: async () => {
          if (!delivered) {
            delivered = true;
            await gate.paused;
          }
        },
      }),
    );
    const bLoad = loadReminder(tabB, [ENTRY_ID]);
    await new Promise((done) => setTimeout(done, 0));
    const fresh = reminder({ reportedDate: "2027-06-30", revision: 1 });
    await saveReminder(fresh, tabA);
    gate.resume();
    // B's guarded delete sees a different envelope, keeps it, and reads it.
    expect(await bLoad).toEqual({ status: "ok", reminder: fresh });
    expect(await loadReminder(deviceDeps(memoryKv(db)), [ENTRY_ID])).toEqual({ status: "ok", reminder: fresh });
  });

  it("a tab that read a broken reminder keeps one a newer version wrote before its delete", async () => {
    const db = new Map<string, unknown>();
    const tabA = deviceDeps(memoryKv(db));
    await saveReminder(reminder(), tabA);
    tamper(tabA.kv);
    const gate = pause();
    let delivered = false;
    const tabB = deviceDeps(
      memoryKv(db, {
        beforeDeliver: async () => {
          if (!delivered) {
            delivered = true;
            await gate.paused;
          }
        },
      }),
    );
    const bLoad = loadReminder(tabB, [ENTRY_ID]);
    await new Promise((done) => setTimeout(done, 0));
    const envelope = db.get(REMINDER_ENVELOPE_KEY) as Record<string, unknown>;
    db.set(REMINDER_ENVELOPE_KEY, { ...envelope, version: 2 });
    gate.resume();
    expect(await bLoad).toEqual({ status: "unsupported" });
    expect((db.get(REMINDER_ENVELOPE_KEY) as { version: number }).version).toBe(2);
  });

  it("a save that another tab's remove overtakes does not bring the reminder back (third review)", async () => {
    // The review's sequence: tab A's save has read the store, tab B's Remove
    // commits and deletes both keys, then tab A's write lands.
    const db = new Map<string, unknown>();
    const tabB = deviceDeps(memoryKv(db));
    await saveReminder(reminder({ reportedDate: "2027-04-30" }), tabB);
    const gate = pause();
    let first = true;
    const tabA = deviceDeps(
      memoryKv(db, {
        beforeDeliver: async () => {
          if (first) {
            first = false;
            await gate.paused;
          }
        },
      }),
    );
    const mine = reminder({ reportedDate: "2027-06-30", revision: 1 });
    const aSave = saveReminder(mine, tabA);
    await new Promise((done) => setTimeout(done, 0));
    await clearReminder(tabB);
    gate.resume();
    // Tab B told the person the reminder is removed; it stays removed, and
    // tab A hears that its save did not land.
    expect(await aSave).toEqual({ status: "changed" });
    expect(db.size).toBe(0);
    // Saving again keeps tab A's date, as its notice says.
    expect(await saveReminder(mine, tabA)).toEqual({ status: "saved" });
    expect(await loadReminder(deviceDeps(memoryKv(db)), [ENTRY_ID])).toEqual({ status: "ok", reminder: mine });
  });

  it("a save that another tab's save overtakes leaves that save in place (third review)", async () => {
    const db = new Map<string, unknown>();
    const tabB = deviceDeps(memoryKv(db));
    await saveReminder(reminder({ reportedDate: "2027-04-30" }), tabB);
    const gate = pause();
    let first = true;
    const tabA = deviceDeps(
      memoryKv(db, {
        beforeDeliver: async () => {
          if (first) {
            first = false;
            await gate.paused;
          }
        },
      }),
    );
    const aSave = saveReminder(reminder({ reportedDate: "2027-06-30", revision: 1 }), tabA);
    await new Promise((done) => setTimeout(done, 0));
    const theirs = reminder({ reportedDate: "2027-05-15", revision: 1 });
    expect(await saveReminder(theirs, tabB)).toEqual({ status: "saved" });
    gate.resume();
    expect(await aSave).toEqual({ status: "changed" });
    expect(await loadReminder(deviceDeps(memoryKv(db)), [ENTRY_ID])).toEqual({ status: "ok", reminder: theirs });
  });

  it("a save lands or says it did not, whatever another tab does between its read and its write (property)", async () => {
    const day = fc
      .integer({ min: toEpochDay(parseIsoDate("2026-01-01")!), max: toEpochDay(parseIsoDate("2030-12-31")!) })
      .map((epochDay) => formatIsoDate(fromEpochDay(epochDay)));
    const meanwhile = fc.constantFrom("nothing" as const, "remove" as const, "save" as const, "remove then save" as const);
    await fc.assert(
      fc.asyncProperty(fc.boolean(), meanwhile, day, day, async (savedBefore, other, mineDay, theirDay) => {
        const db = new Map<string, unknown>();
        const tabB = deviceDeps(memoryKv(db));
        if (savedBefore) {
          await saveReminder(reminder({ reportedDate: "2027-04-30" }), tabB);
        }
        const gate = pause();
        let first = true;
        const tabA = deviceDeps(
          memoryKv(db, {
            beforeDeliver: async () => {
              if (first) {
                first = false;
                await gate.paused;
              }
            },
          }),
        );
        const mine = reminder({ reportedDate: mineDay, revision: 2 });
        const theirs = reminder({ reportedDate: theirDay, revision: 3, calendarId: "f".repeat(32) });
        const aSave = saveReminder(mine, tabA);
        await new Promise((done) => setTimeout(done, 0));
        if (other === "remove" || other === "remove then save") {
          await clearReminder(tabB);
        }
        if (other === "save" || other === "remove then save") {
          await saveReminder(theirs, tabB);
        }
        gate.resume();
        const outcome = await aSave;
        const stored = await loadReminder(deviceDeps(memoryKv(db)), [ENTRY_ID]);
        // The other tab changed the store exactly when it did something
        // that left a different envelope (or none) than tab A read.
        const changed = other === "save" || other === "remove then save" || (other === "remove" && savedBefore);
        if (changed) {
          expect(outcome).toEqual({ status: "changed" });
          expect(stored).toEqual(other === "remove" ? { status: "none" } : { status: "ok", reminder: theirs });
        } else {
          expect(outcome).toEqual({ status: "saved" });
          expect(stored).toEqual({ status: "ok", reminder: mine });
        }
      }),
      { numRuns: 80 },
    );
  });

  it("two tabs making the first save at once leave a matching key and envelope", async () => {
    const db = new Map<string, unknown>();
    let reads = 0;
    const bothRead = pause();
    const hooks = {
      beforeDeliver: async (keys: readonly string[]) => {
        // A save's read starts with the key (third review: it reads the
        // envelope too, to compare before it writes); a load starts with
        // the envelope.
        if (keys[0] === REMINDER_CRYPTO_KEY_KEY) {
          reads += 1;
          if (reads === 2) {
            bothRead.resume();
          }
          await bothRead.paused;
        }
      },
    };
    const first = reminder({ reportedDate: "2027-04-30" });
    const second = reminder({ reportedDate: "2027-06-30" });
    const outcomes = await Promise.all([
      saveReminder(first, deviceDeps(memoryKv(db, hooks))),
      saveReminder(second, deviceDeps(memoryKv(db, hooks))),
    ]);
    // Both saves read before either wrote, so the race really ran.
    expect(reads).toBe(2);
    // Before the review fix this ended with one tab's envelope and the
    // other tab's key, so the next read discarded both.
    const result = await loadReminder(deviceDeps(memoryKv(db)), [ENTRY_ID]);
    expect(result.status).toBe("ok");
    expect([first, second]).toContainEqual(result.status === "ok" ? result.reminder : null);
    // Third review: the save that lost is told so, and the one that won is the one stored.
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["changed", "saved"]);
    expect(result.status === "ok" ? result.reminder : null).toEqual(outcomes[0]!.status === "saved" ? first : second);
  });
});
