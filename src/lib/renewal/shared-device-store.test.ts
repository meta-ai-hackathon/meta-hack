import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  DEVICE_ANSWERS_ENVELOPE_KEY,
  loadDeviceAnswers,
  purgeDeviceAnswers,
  recordDeviceAnswer,
  type DeviceAnswerStoreDeps,
} from "../intake/device-answer-store";
import { serializeClientAnswers } from "../intake/client-store";
import { QUESTIONS } from "../intake/spec";
import { formatIsoDate, fromEpochDay, parseIsoDate, toEpochDay } from "./calendar-date";
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
// adapters. Each side must read and write only its own keys, so removing
// the reminder never takes an answer with it, and deleting the answers
// never takes the reminder. The in-memory store below is that one object
// store: it structured-clones like IndexedDB and records every key a call
// reads or writes.

const ENTRY_ID = "nc_medicaid_renewal";
const CALENDAR_ID = "0123456789abcdef0123456789abcdef";
const REMINDER_KEYS = new Set([REMINDER_ENVELOPE_KEY, REMINDER_CRYPTO_KEY_KEY]);
const ANSWER_KEYS = new Set([DEVICE_ANSWERS_ENVELOPE_KEY, DEVICE_ANSWERS_CRYPTO_KEY_KEY]);

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
  | { readonly kind: "delete answers" };

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("save reminder" as const),
    day: fc.integer({ min: minDay, max: maxDay }),
    revision: fc.nat({ max: 50 }),
  }),
  fc.constant<Step>({ kind: "remove reminder" }),
  fc.record({ kind: fc.constant("answer" as const), question: fc.nat({ max: QUESTIONS.length - 1 }) }),
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
        for (const next of steps) {
          // What the other side holds before this step, to compare after it.
          const reminderBefore = await reminderNow();
          const answersBefore = await answersNow();
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
          } else {
            expect(await reminderNow()).toEqual(reminderBefore);
          }
        }
        // Reading back never strays either.
        expect([...(await device.keysTouchedBy(reminderNow))].filter((key) => !REMINDER_KEYS.has(key))).toEqual([]);
        expect([...(await device.keysTouchedBy(answersNow))].filter((key) => !ANSWER_KEYS.has(key))).toEqual([]);
        // Nothing else was ever stored in the shared store.
        for (const key of device.entries.keys()) {
          expect(REMINDER_KEYS.has(key) || ANSWER_KEYS.has(key)).toBe(true);
        }
      }),
      { numRuns: 40 },
    );
  });
});
