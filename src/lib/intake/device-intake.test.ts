import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_STORAGE_TIMEOUT_MS, type DeviceKv, type KvGuard } from "../device-kv";
import { findBannedClaims, type AnswerStatus } from "../honesty";
import { canonicalAnswerValue } from "./answer-input";
import { buildClientState } from "./client-state";
import { EMPTY_CLIENT_ANSWERS, toAnswerMap } from "./client-store";
import {
  DEVICE_ANSWERS_CRYPTO_KEY_KEY,
  DEVICE_ANSWERS_ENVELOPE_KEY,
  type DeviceAnswerStoreOpen,
  isSealingKey,
} from "./device-answer-store";
import {
  DEVICE_INTAKE_COPY,
  answerNotice,
  answerOnDevice,
  askToKeepAnswers,
  deleteDeviceIntake,
  keepingBlurb,
  keepsAnswers,
  loadDeviceIntake,
  privateAnswerNote,
  refreshDeviceIntake,
  saveForLaterNotice,
  type DeviceIntake,
} from "./device-intake";
import { firstUnansweredIndex, visibleQuestions } from "./flow";
import { QUESTIONS, QUESTION_BY_ID, type Question } from "./spec";

// The step-by-step page's on-device intake (HACK-99): a whole journey runs
// without one network request, resumes after a reload exactly where the
// flow engine says, checks answers as the server does, and tells the
// person the truth about what the browser kept and what was deleted, in
// every storage failure the browser can produce.

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

function opener(kv: DeviceKv): () => Promise<DeviceAnswerStoreOpen> {
  return async () => ({ status: "ok", store: { kv, subtle: crypto.subtle } });
}
const unsupported = async (): Promise<DeviceAnswerStoreOpen> => ({ status: "unsupported" });
const failed = async (): Promise<DeviceAnswerStoreOpen> => ({ status: "failed" });

/** A valid answer for any question type, as the page's controls produce it. */
function validDraft(question: Question): unknown {
  switch (question.type) {
    case "text":
    case "address":
      return "  Some answer  ";
    case "number":
      return "3";
    case "boolean":
      return true;
    case "date":
      return "1990-04-02";
    case "single_select":
      return question.options![0].value;
    case "multi_select":
      return [question.options![0].value];
    case "work_activity":
      return [{ memberId: "member-1", activity: "job_internship", hours: 20 }];
    case "attribution":
      return [{ memberId: "member-1", situationId: "wr_income_580", months: "both" }];
    case "roster":
      return [{ id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" }];
  }
}

/** Answer the first `count` visible questions, as one visit would. */
async function answerFirst(intake: DeviceIntake, count: number): Promise<DeviceIntake> {
  let current = intake;
  for (let i = 0; i < count; i += 1) {
    const question = current.view.questions[current.view.currentIndex ?? 0];
    const result = await answerOnDevice(current, question.id, "known", validDraft(QUESTION_BY_ID[question.id]));
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") {
      throw new Error("not saved");
    }
    current = result.intake;
  }
  return current;
}

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("no network on the device path")));
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a whole journey on the device", () => {
  it("answers everything, resumes after reloads, and deletes, with zero network requests", async () => {
    const { kv, store } = memoryKv();
    const loaded = await loadDeviceIntake(opener(kv));
    expect(loaded.notice).toBe("");
    let intake = loaded.intake;
    expect(keepsAnswers(intake)).toBe(true);
    let steps = 0;
    while (intake.view.currentIndex !== null && steps < 200) {
      steps += 1;
      const question = intake.view.questions[intake.view.currentIndex];
      const status = steps % 5 === 0 ? "unknown" : steps % 7 === 0 ? "unverified" : "known";
      const result = await answerOnDevice(
        intake,
        question.id,
        status,
        validDraft(QUESTION_BY_ID[question.id]),
      );
      expect(result.kind).toBe("saved");
      if (result.kind !== "saved") {
        return;
      }
      intake = result.intake;
      // A reload at every step resumes exactly where the flow engine says.
      const reloaded = await loadDeviceIntake(opener(kv));
      expect(reloaded.notice).toBe(DEVICE_INTAKE_COPY.resumedOnLoad);
      expect(reloaded.intake.answers).toEqual(intake.answers);
      const map = toAnswerMap(reloaded.intake.answers);
      const visible = visibleQuestions(QUESTIONS, map);
      const first = firstUnansweredIndex(visible, map);
      expect(reloaded.intake.view.currentIndex).toBe(first === -1 ? null : first);
      intake = reloaded.intake;
    }
    expect(intake.view.complete).toBe(true);
    expect(store.size).toBe(2);

    const deleted = await deleteDeviceIntake(intake);
    expect(deleted.deleted).toBe(true);
    expect(deleted.notice).toBe(DEVICE_INTAKE_COPY.deleted);
    expect(deleted.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);
    expect(store.size).toBe(0);
    const afterDelete = await loadDeviceIntake(opener(kv));
    expect(afterDelete.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);
    expect(afterDelete.intake.view.currentIndex).toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never puts a private answer's value into what the page renders", async () => {
    const { kv } = memoryKv();
    let { intake } = await loadDeviceIntake(opener(kv));
    for (const question of QUESTIONS.filter((candidate) => candidate.pii)) {
      const result = await answerOnDevice(intake, question.id, "known", validDraft(question));
      if (result.kind === "saved") {
        intake = result.intake;
      }
    }
    for (const question of QUESTIONS.filter((candidate) => candidate.pii)) {
      const shown = intake.view.answers[question.id];
      if (shown) {
        expect("value" in shown).toBe(false);
      }
    }
    expect(intake.view).toEqual(buildClientState(toAnswerMap(intake.answers)));
  });
});

describe("answers are checked as the server checks them", () => {
  it("keeps the canonical value for any valid answer and refuses anything else", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...QUESTIONS),
        fc.oneof(
          fc.string({ maxLength: 12 }),
          fc.integer(),
          fc.double(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.string({ maxLength: 8 }), { maxLength: 3 }),
        ),
        async (question, draft) => {
          const { kv, store } = memoryKv();
          const { intake } = await loadDeviceIntake(opener(kv));
          const result = await answerOnDevice(intake, question.id, "known", draft);
          const canonical = canonicalAnswerValue(question, draft);
          if (canonical === null) {
            expect(result).toEqual({ kind: "invalid", message: DEVICE_INTAKE_COPY.invalidAnswer });
            expect(store.size).toBe(0);
          } else {
            expect(result.kind).toBe("saved");
            if (result.kind === "saved") {
              expect(result.intake.answers[question.id]?.value).toEqual(canonical);
            }
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it("an unknown answer keeps no value whatever was typed, and unknown question ids are refused", async () => {
    const { kv } = memoryKv();
    const { intake } = await loadDeviceIntake(opener(kv));
    const question = QUESTIONS[0];
    const result = await answerOnDevice(intake, question.id, "unknown", "typed then disavowed");
    expect(result.kind).toBe("saved");
    if (result.kind === "saved") {
      expect(result.intake.answers[question.id]?.value).toBeNull();
    }
    for (const id of ["nope", "constructor", "__proto__"]) {
      expect((await answerOnDevice(intake, id, "known", "x")).kind).toBe("invalid");
    }
  });
});

describe("a browser that can't store anything", () => {
  it("works in memory, says so at every step, and clears only the page on delete", async () => {
    const { intake, notice } = await loadDeviceIntake(unsupported);
    expect(notice).toBe(DEVICE_INTAKE_COPY.unsupportedOnLoad);
    expect(keepsAnswers(intake)).toBe(false);
    expect(keepingBlurb(intake)).toBe(DEVICE_INTAKE_COPY.unsupportedBlurb);
    const answered = await answerFirst(intake, 1);
    expect(answerNotice("known", answered.view.progress, answered)).toMatch(/can't save answers/);
    expect(privateAnswerNote(answered)).toBe(DEVICE_INTAKE_COPY.privateNotKept);
    expect(saveForLaterNotice(answered)).toBe(DEVICE_INTAKE_COPY.unsupportedBlurb);
    const cleared = await deleteDeviceIntake(answered);
    expect(cleared).toMatchObject({ deleted: true, notice: DEVICE_INTAKE_COPY.clearedNothingStored });
    expect(cleared.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);
  });
});

describe("storage that fails while answers from an earlier visit are stored", () => {
  async function earlierVisit() {
    const disk = memoryKv();
    const { intake } = await loadDeviceIntake(opener(disk.kv));
    await answerFirst(intake, 2);
    expect(disk.store.size).toBe(2);
    return disk;
  }

  it("a delete after a failed open runs the verified purge on a fresh open", async () => {
    const disk = await earlierVisit();
    const { intake, notice } = await loadDeviceIntake(failed);
    expect(notice).toBe(DEVICE_INTAKE_COPY.unavailableOnLoad);
    expect(keepingBlurb(intake)).toBe(DEVICE_INTAKE_COPY.unavailableBlurb);
    const result = await deleteDeviceIntake(intake, opener(disk.kv));
    expect(result).toMatchObject({ deleted: true, notice: DEVICE_INTAKE_COPY.deleted });
    expect(disk.store.size).toBe(0);
  });

  it("a delete that can't reach storage never reports success, and the stored answers are untouched", async () => {
    const disk = await earlierVisit();
    const { intake } = await loadDeviceIntake(failed);
    for (const reopen of [failed, () => Promise.reject(new Error("blocked"))]) {
      const result = await deleteDeviceIntake(intake, reopen);
      expect(result.deleted).toBe(false);
      expect(result.notice).toBe(DEVICE_INTAKE_COPY.deleteUnconfirmed);
    }
    expect(disk.store.size).toBe(2);
  });

  it("a store that opens but can't be read keeps its handle, so a delete still purges it", async () => {
    const disk = await earlierVisit();
    let reads = 0;
    const flaky: DeviceKv = {
      ...disk.kv,
      getMany: (keys) => {
        reads += 1;
        return reads === 1 ? Promise.reject(new Error("read failed")) : disk.kv.getMany(keys);
      },
    };
    const { intake, notice } = await loadDeviceIntake(opener(flaky));
    expect(notice).toBe(DEVICE_INTAKE_COPY.unavailableOnLoad);
    expect(intake.store).not.toBeNull();
    const result = await deleteDeviceIntake(intake, failed);
    expect(result).toMatchObject({ deleted: true, notice: DEVICE_INTAKE_COPY.deleted });
    expect(disk.store.size).toBe(0);
  });
});

describe("a save that fails mid-visit", () => {
  it("after earlier saves, says those are still on the device and new changes aren't", async () => {
    const disk = memoryKv();
    const failing: DeviceKv = { ...disk.kv };
    const { intake } = await loadDeviceIntake(opener(failing));
    const saved = await answerFirst(intake, 2);
    failing.setMany = () => Promise.reject(new Error("quota exceeded"));
    const next = saved.view.questions[saved.view.currentIndex ?? 0];
    const result = await answerOnDevice(saved, next.id, "known", validDraft(QUESTION_BY_ID[next.id]));
    expect(result).toMatchObject({ kind: "saved", notice: DEVICE_INTAKE_COPY.stoppedKeeping });
    if (result.kind !== "saved") {
      return;
    }
    expect(result.intake.keeping).toBe("stopped");
    expect(keepingBlurb(result.intake)).toBe(DEVICE_INTAKE_COPY.stoppedBlurb);
    expect(saveForLaterNotice(result.intake)).toBe(DEVICE_INTAKE_COPY.stoppedBlurb);
    const later = result.intake.view.questions[result.intake.view.currentIndex ?? 0];
    const after = await answerOnDevice(result.intake, later.id, "known", validDraft(QUESTION_BY_ID[later.id]));
    expect(after.kind).toBe("saved");
    if (after.kind === "saved") {
      expect(after.notice).toMatch(/This answer isn't saved\. Answers saved before stay on this device\./);
    }
    // And that is the truth: a reload brings back exactly the two saved answers.
    const reloaded = await loadDeviceIntake(opener(disk.kv));
    expect(Object.keys(reloaded.intake.answers)).toEqual(Object.keys(saved.answers));
    // A delete still reaches the stored answers.
    expect((await deleteDeviceIntake(result.intake)).deleted).toBe(true);
    expect(disk.store.size).toBe(0);
  });

  it("before anything was saved, says the answers last only until the page closes", async () => {
    const { kv } = memoryKv();
    const failing: DeviceKv = { ...kv, setMany: () => Promise.reject(new Error("quota exceeded")) };
    const { intake } = await loadDeviceIntake(opener(failing));
    const question = intake.view.questions[0];
    const result = await answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]));
    expect(result).toMatchObject({ kind: "saved", notice: DEVICE_INTAKE_COPY.stoppedKeepingNothingStored });
    if (result.kind === "saved") {
      expect(keepingBlurb(result.intake)).toBe(DEVICE_INTAKE_COPY.stoppedBlurbNothingStored);
    }
  });

  it("a save that never settles gives up at the deadline instead of hanging the page", async () => {
    vi.useFakeTimers();
    const { kv } = memoryKv();
    const stalled: DeviceKv = { ...kv, setMany: () => new Promise(() => undefined) };
    const { intake } = await loadDeviceIntake(opener(stalled));
    const question = intake.view.questions[0];
    const pending = answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]));
    await vi.advanceTimersByTimeAsync(DEVICE_STORAGE_TIMEOUT_MS + 1);
    const result = await pending;
    expect(result).toMatchObject({ kind: "saved", notice: DEVICE_INTAKE_COPY.saveTimedOut });
  });

  it("a save that lands after the deadline was only called possibly kept, and a delete still removes it", async () => {
    vi.useFakeTimers();
    const disk = memoryKv();
    let land: (() => void) | undefined;
    const slow: DeviceKv = {
      ...disk.kv,
      setMany: (entries, guard) =>
        new Promise((resolve) => {
          land = () => void disk.kv.setMany(entries, guard).then(resolve);
        }),
    };
    const { intake } = await loadDeviceIntake(opener(slow));
    const question = intake.view.questions[0];
    const pending = answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]));
    // Let the save reach its write (sealing runs on real crypto), then let
    // the deadline pass while that write is still in flight.
    await vi.waitFor(() => expect(land).toBeDefined());
    await vi.advanceTimersByTimeAsync(DEVICE_STORAGE_TIMEOUT_MS + 1);
    const result = await pending;
    expect(result).toMatchObject({ kind: "saved", notice: DEVICE_INTAKE_COPY.saveTimedOut });
    if (result.kind !== "saved") {
      return;
    }
    // The page never says the answer was not saved, and it treats the
    // device as possibly holding answers from here on.
    expect(result.notice).not.toMatch(/isn't saved|aren't saved|won't be/);
    expect(result.intake.keeping).toBe("stopped");
    expect(result.intake.stored).toBe(true);
    expect(keepingBlurb(result.intake)).toBe(DEVICE_INTAKE_COPY.stoppedBlurb);
    // The write the page gave up on commits anyway. A generated-key save
    // is two anchored writes now (review P2): the claim is the one in
    // flight here, so that is what commits; the envelope write awaited
    // it and never ran.
    land?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(disk.store.size).toBe(1);
    expect(isSealingKey(disk.store.get(DEVICE_ANSWERS_CRYPTO_KEY_KEY))).toBe(true);
    expect(disk.store.get(DEVICE_ANSWERS_ENVELOPE_KEY)).toBeUndefined();
    vi.useRealTimers();
    // ...and the delete still finds it and removes it.
    const deleted = await deleteDeviceIntake(result.intake);
    expect(deleted).toMatchObject({ deleted: true, notice: DEVICE_INTAKE_COPY.deleted });
    expect(disk.store.size).toBe(0);
  });
});

describe("other tabs and windows", () => {
  it("a refresh picks up another tab's answers and a delete made elsewhere", async () => {
    const disk = memoryKv();
    const mine = await answerFirst((await loadDeviceIntake(opener(disk.kv))).intake, 1);
    // Another tab answers one more question on the same device.
    const theirs = await answerFirst((await loadDeviceIntake(opener(disk.kv))).intake, 2);
    const refreshed = await refreshDeviceIntake(mine);
    expect(refreshed).toMatchObject({ changed: true, purged: false, notice: DEVICE_INTAKE_COPY.updatedElsewhere });
    expect(refreshed.intake.answers).toEqual(theirs.answers);
    expect((await refreshDeviceIntake(refreshed.intake)).changed).toBe(false);

    // Another tab deletes everything.
    disk.store.clear();
    const gone = await refreshDeviceIntake(refreshed.intake);
    expect(gone).toMatchObject({ changed: true, purged: true, notice: DEVICE_INTAKE_COPY.purgedElsewhere });
    expect(gone.intake.answers).toEqual(EMPTY_CLIENT_ANSWERS);
    expect(saveForLaterNotice(gone.intake)).toBe(DEVICE_INTAKE_COPY.savedForLaterKept);
  });

  it("a save after another tab's delete is not written, and the page starts fresh", async () => {
    const disk = memoryKv();
    const intake = await answerFirst((await loadDeviceIntake(opener(disk.kv))).intake, 1);
    disk.store.clear();
    const question = intake.view.questions[intake.view.currentIndex ?? 0];
    const result = await answerOnDevice(intake, question.id, "known", validDraft(QUESTION_BY_ID[question.id]));
    expect(result).toMatchObject({ kind: "purged", notice: DEVICE_INTAKE_COPY.purgedElsewhere });
    expect(disk.store.size).toBe(0);
  });

  it("a delete in another tab that a roster change's re-prune finds is told as a delete, not a save", async () => {
    // The roster save lands, then another tab deletes everything before
    // the re-prune of the attribution (HACK-135) or the work rows (HACK-128)
    // writes. The re-prune finds the delete, so the page starts fresh and
    // says the answers were deleted elsewhere, and the wizard clears what
    // was typed into the review, as for any delete made elsewhere.
    const twoMembers = [
      { id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" },
      { id: "member-2", displayName: "Jo", relationship: "child", ageBand: "under_14" },
    ];
    const pruned: Readonly<Record<string, readonly [string, unknown][]>> = {
      attribution: [
        ["wr_income_580", "yes"],
        [
          "wr_who_months",
          [
            { memberId: "member-1", situationId: "wr_income_580", months: "both" },
            { memberId: "member-2", situationId: "wr_income_580", months: "last_month" },
          ],
        ],
      ],
      "work rows": [
        [
          "wr_work_rows",
          [
            { memberId: "member-1", activity: "job_internship", hours: 40 },
            { memberId: "member-2", activity: "community_service", hours: 10 },
          ],
        ],
      ],
    };
    for (const [what, answers] of Object.entries(pruned)) {
      const disk = memoryKv();
      let deleteAfterNextSave = false;
      const kv: DeviceKv = {
        ...disk.kv,
        setMany: async (entries, guard) => {
          const written = await disk.kv.setMany(entries, guard);
          if (deleteAfterNextSave) {
            deleteAfterNextSave = false;
            // Another tab's Delete my answers lands right after this write.
            disk.store.clear();
          }
          return written;
        },
      };
      let intake = (await loadDeviceIntake(opener(kv))).intake;
      for (const [questionId, value] of [["household_roster", twoMembers] as const, ...answers]) {
        const saved = await answerOnDevice(intake, questionId, "known", value);
        expect(saved.kind, `${what}: ${questionId}`).toBe("saved");
        if (saved.kind === "saved") {
          intake = saved.intake;
        }
      }
      deleteAfterNextSave = true;
      const result = await answerOnDevice(intake, "household_roster", "known", twoMembers.slice(0, 1));
      expect(result, what).toMatchObject({ kind: "purged", notice: DEVICE_INTAKE_COPY.purgedElsewhere });
      if (result.kind === "purged") {
        expect(result.intake.answers, what).toEqual(EMPTY_CLIENT_ANSWERS);
        expect(result.intake.stored, what).toBe(false);
      }
      // Nothing came back to the device after the delete.
      expect(disk.store.size, what).toBe(0);
    }
  });
});

describe("honest copy", () => {
  it("does not claim a delete it could not confirm, and keeps showing what is still stored", async () => {
    const { kv, store } = memoryKv();
    const saved = await answerFirst((await loadDeviceIntake(opener(kv))).intake, 1);
    const refusing: DeviceIntake = {
      ...saved,
      store: { kv: { ...kv, deleteMany: () => Promise.reject(new Error("refused")) }, subtle: crypto.subtle },
    };
    const result = await deleteDeviceIntake(refusing);
    expect(result.deleted).toBe(false);
    expect(result.notice).toBe(DEVICE_INTAKE_COPY.deleteUnconfirmed);
    expect(result.intake.answers).toEqual(saved.answers);
    expect(store.size).toBe(2);
  });

  it("states progress plainly, keeps the standing blurb calm, and keeps every line free of promise language", async () => {
    const { kv } = memoryKv();
    const { intake } = await loadDeviceIntake(opener(kv));
    const progress = { answered: 3, remaining: 4, total: 7 };
    expect(answerNotice("known", progress, intake)).toBe("Saved on this device. 3 of 7 answered.");
    expect(answerNotice("unknown", progress, intake)).toBe("Marked as not sure. You can come back to it.");
    // HACK-139: the standing blurb promises the resume and states the
    // submission boundary, with the shared-computer caution moved out of
    // the ambient copy (the delete control stays on the page; the rules'
    // shared-computer statement remains at the download and in the
    // delete/purge copy).
    expect(keepingBlurb(intake)).toMatch(/pick up where you left off/);
    expect(saveForLaterNotice(intake)).toMatch(/Private windows/);
    const lines = [
      ...Object.values(DEVICE_INTAKE_COPY),
      answerNotice("unverified", progress, { keeping: "unsupported", stored: false, store: null }),
      answerNotice("known", progress, { keeping: "stopped", stored: true, store: null }),
      answerNotice("known", progress, { keeping: "unavailable", stored: false, store: null }),
    ];
    for (const line of lines) {
      expect(findBannedClaims(line)).toEqual([]);
    }
    // No line says answers are kept safe from other people using the browser.
    for (const line of Object.values(DEVICE_INTAKE_COPY)) {
      expect(line).not.toMatch(/locked|never leaves this browser|any time/i);
    }
  });

  it("keeps the landing's standing copy calm: one short privacy passage, no repeated deletion messaging (HACK-139)", () => {
    // The one calm privacy passage is the page intro: answers stay on
    // this device and nothing entered is sent — both claims true on the
    // device path (VAL-PICK-002).
    expect(DEVICE_INTAKE_COPY.pageIntro).toMatch(/answers stay on this device/);
    expect(DEVICE_INTAKE_COPY.pageIntro).toMatch(/nothing you enter is sent to us/);
    // The standing blurbs under the questions keep the resume promise and
    // the submission boundary, and carry no deletion messaging of their
    // own: deletion lives behind the person's own controls and the honest
    // outcome copy, not in the ambient landing text.
    expect(DEVICE_INTAKE_COPY.keptBlurb).toMatch(/pick up where you left off/);
    expect(DEVICE_INTAKE_COPY.keptBlurb).toMatch(/Nothing is submitted until you decide/);
    expect(DEVICE_INTAKE_COPY.keepPrompt).toMatch(/saying yes keeps your answers saved/);
    for (const line of [DEVICE_INTAKE_COPY.keptBlurb, DEVICE_INTAKE_COPY.keepPrompt]) {
      expect(line).not.toMatch(/delete|erase|cleared/i);
    }
  });

  it("says in every delete and purge message that a downloaded copy of the filled form stays on the device", () => {
    // The person may download a copy of the filled form at the end of
    // /intake (HACK-115), or save it as a PDF from the print window. That
    // file is outside this browser's storage, so no delete here reaches it,
    // and the rules (.github/claude-review/rules.md) require the delete and
    // purge copy to say a downloaded copy stays until the person deletes it.
    for (const key of ["deleteConfirm", "deleted", "clearedNothingStored", "deleteUnconfirmed", "purgedElsewhere"] as const) {
      expect(DEVICE_INTAKE_COPY[key], key).toContain(
        "If you downloaded a copy of the filled form, or saved it as a PDF when printing, that file stays on this device until you delete it.",
      );
    }
  });
});

// Asking the browser to keep this site's storage can show a permission
// prompt (Firefox does), so it is never asked silently mid-form: only when
// the person presses Save and finish later, after the page said it may ask,
// and only when this device holds their answers (HACK-113).
describe("asking the browser to keep the answers", () => {
  /** How this browser's storage behaves on a visit. */
  type Storage = "working" | "unsupported" | "fails to open" | "refuses saves";

  async function visitWith(storage: Storage): Promise<DeviceIntake> {
    switch (storage) {
      case "working":
        return (await loadDeviceIntake(opener(memoryKv().kv))).intake;
      case "unsupported":
        return (await loadDeviceIntake(unsupported)).intake;
      case "fails to open":
        return (await loadDeviceIntake(failed)).intake;
      case "refuses saves": {
        const { kv } = memoryKv();
        const refusing: DeviceKv = { ...kv, setMany: () => Promise.reject(new Error("quota exceeded")) };
        return (await loadDeviceIntake(opener(refusing))).intake;
      }
    }
  }

  it("answering never asks, however many answers and whatever their status", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom<AnswerStatus>("known", "unverified", "unknown"), { minLength: 1, maxLength: 8 }),
        async (statuses) => {
          const persist = vi.fn(async () => true);
          vi.stubGlobal("navigator", { storage: { persist } });
          let intake = await visitWith("working");
          for (const status of statuses) {
            const question = intake.view.questions[intake.view.currentIndex ?? 0];
            const result = await answerOnDevice(intake, question.id, status, validDraft(QUESTION_BY_ID[question.id]));
            expect(result.kind).toBe("saved");
            if (result.kind === "saved") {
              intake = result.intake;
            }
          }
          // Every answer is kept on the device, and the browser was never asked.
          expect(keepsAnswers(intake) && intake.stored).toBe(true);
          expect(persist).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 30 },
    );
  });

  it("asks once, and only when this device holds the person's answers", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Storage>("working", "unsupported", "fails to open", "refuses saves"),
        fc.integer({ min: 0, max: 4 }),
        async (storage, answered) => {
          const intake = await answerFirst(await visitWith(storage), answered);
          const persist = vi.fn(async () => true);
          const asked = askToKeepAnswers(intake, persist);
          // Only storage that works and saved at least one answer holds anything to keep.
          expect(asked).toBe(storage === "working" && answered > 0);
          expect(persist).toHaveBeenCalledTimes(asked ? 1 : 0);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("asks for answers kept from an earlier visit, and not once they are deleted", async () => {
    const disk = memoryKv();
    await answerFirst((await loadDeviceIntake(opener(disk.kv))).intake, 2);
    const resumed = (await loadDeviceIntake(opener(disk.kv))).intake;
    const persist = vi.fn(async () => true);
    expect(askToKeepAnswers(resumed, persist)).toBe(true);
    const deleted = await deleteDeviceIntake(resumed);
    expect(deleted.deleted).toBe(true);
    expect(askToKeepAnswers(deleted.intake, persist)).toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("a browser that refuses the request changes nothing and leaves no unhandled rejection", async () => {
    const intake = await answerFirst(await visitWith("working"), 1);
    expect(askToKeepAnswers(intake, () => Promise.reject(new Error("denied")))).toBe(true);
    expect(askToKeepAnswers(intake, async () => false)).toBe(true);
    await new Promise((done) => setTimeout(done, 0));
    expect(saveForLaterNotice(intake)).toBe(DEVICE_INTAKE_COPY.savedForLaterKept);
  });
});

describe("the stored keys", () => {
  it("are exactly the envelope and its key", async () => {
    const { kv, store } = memoryKv();
    await answerFirst((await loadDeviceIntake(opener(kv))).intake, 1);
    expect([...store.keys()].sort()).toEqual(
      [DEVICE_ANSWERS_CRYPTO_KEY_KEY, DEVICE_ANSWERS_ENVELOPE_KEY].sort(),
    );
  });
});

describe("per-person attribution re-pruning (HACK-135)", () => {
  it("drops attribution entries for a removed roster member when the roster changes", async () => {
    const { kv } = memoryKv();
    let intake = (await loadDeviceIntake(opener(kv))).intake;
    const save = async (id: string, value: unknown) => {
      const r = await answerOnDevice(intake, id, "known", value);
      expect(r.kind).toBe("saved");
      if (r.kind === "saved") intake = r.intake;
    };
    await save("household_roster", [
      { id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" },
      { id: "member-2", displayName: "Jo", relationship: "child", ageBand: "under_14" },
    ]);
    await save("wr_income_580", "yes");
    await save("wr_who_months", [
      { memberId: "member-1", situationId: "wr_income_580", months: "both" },
      { memberId: "member-2", situationId: "wr_income_580", months: "last_month" },
    ]);
    await save("household_roster", [
      { id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" },
    ]);
    expect(intake.answers["wr_who_months"]?.value).toEqual([
      { memberId: "member-1", situationId: "wr_income_580", months: "both" },
    ]);
  });

  it("makes the attribution unanswered again when re-pruning removes every entry", async () => {
    const { kv } = memoryKv();
    let intake = (await loadDeviceIntake(opener(kv))).intake;
    const save = async (id: string, value: unknown) => {
      const r = await answerOnDevice(intake, id, "known", value);
      expect(r.kind).toBe("saved");
      if (r.kind === "saved") intake = r.intake;
    };
    await save("household_roster", [
      { id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" },
      { id: "member-2", displayName: "Jo", relationship: "child", ageBand: "under_14" },
    ]);
    await save("wr_income_580", "yes");
    await save("wr_who_months", [
      { memberId: "member-2", situationId: "wr_income_580", months: "last_month" },
    ]);
    await save("household_roster", [
      { id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" },
    ]);
    expect(intake.answers["wr_who_months"]).toBeUndefined();
  });

  it("keeps the stored attribution when the persisted re-prune cannot be written", async () => {
    const base = memoryKv();
    let sets = 0;
    let failAfter = Number.POSITIVE_INFINITY;
    const kv: DeviceKv = {
      ...base.kv,
      setMany: async (entries, guard) => {
        sets += 1;
        if (sets > failAfter) throw new Error("storage full");
        return base.kv.setMany(entries, guard);
      },
    };
    let intake = (await loadDeviceIntake(async () => ({ status: "ok", store: { kv, subtle: crypto.subtle } }))).intake;
    const save = async (id: string, value: unknown) => {
      const r = await answerOnDevice(intake, id, "known", value);
      expect(r.kind).toBe("saved");
      if (r.kind === "saved") intake = r.intake;
    };
    await save("household_roster", [
      { id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" },
      { id: "member-2", displayName: "Jo", relationship: "child", ageBand: "under_14" },
    ]);
    await save("wr_income_580", "yes");
    await save("wr_who_months", [
      { memberId: "member-1", situationId: "wr_income_580", months: "both" },
      { memberId: "member-2", situationId: "wr_income_580", months: "last_month" },
    ]);
    // Let the roster change itself save, then fail the re-prune write.
    failAfter = sets + 1;
    await save("household_roster", [
      { id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" },
    ]);
    // Memory still shows what the device holds: both entries, unpruned.
    expect(intake.answers["wr_who_months"]?.value).toEqual([
      { memberId: "member-1", situationId: "wr_income_580", months: "both" },
      { memberId: "member-2", situationId: "wr_income_580", months: "last_month" },
    ]);
  });
});

describe("per-person work rows re-pruning (HACK-128)", () => {
  it("drops work rows for a removed roster member when the roster changes", async () => {
    const { kv } = memoryKv();
    let intake = (await loadDeviceIntake(opener(kv))).intake;
    const save = async (id: string, value: unknown) => {
      const r = await answerOnDevice(intake, id, "known", value);
      expect(r.kind).toBe("saved");
      if (r.kind === "saved") intake = r.intake;
    };
    await save("household_roster", [
      { id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" },
      { id: "member-2", displayName: "Jo", relationship: "child", ageBand: "under_14" },
    ]);
    await save("wr_work_rows", [
      { memberId: "member-1", activity: "job_internship", hours: 40 },
      { memberId: "member-2", activity: "community_service", hours: null, hoursNotSure: true },
    ]);
    await save("household_roster", [
      { id: "member-1", displayName: "Sam", relationship: "self", ageBand: "18_to_54" },
    ]);
    expect(intake.answers["wr_work_rows"]?.value).toEqual([
      { memberId: "member-1", activity: "job_internship", hours: 40 },
    ]);
  });
});
