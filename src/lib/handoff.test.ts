import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import realEntryJson from "../../kb/entries/nc-medicaid.json";
import sampleEntryJson from "../../kb/entries/pilot-program-sample.json";
import {
  HANDOFF_ACTION_KINDS,
  HANDOFF_WHERE,
  HANDOFF_WHERE_LABELS,
  PILOT_HANDOFF_COMPANION,
  firstHandoffCompanion,
  handoffCompanion,
  nextHandoffAction,
  showsAfterYouApply,
  type HandoffAction,
  type HandoffState,
} from "./handoff";
import {
  SESSION_STATUSES,
  USER_REPORTED_SESSION_STATUSES,
  findBannedClaims,
  type SessionStatus,
} from "./honesty";
import { KB_ENTRIES, parseKbEntry, type KbEntry } from "./kb";

// The handoff's one next action (BN-23, HACK-49) and its sourced companion
// steps (BN-24 and BN-26, HACK-46 and HACK-47). The properties below are
// the contract: every state gets exactly one action, the action only ever
// moves the session forward by one BN-25 step, the where label follows the
// lifecycle, and no copy promises an outcome or says the app sent anything.

const statusArb = fc.constantFrom(...SESSION_STATUSES);
const stateArb: fc.Arbitrary<HandoffState> = fc.record({
  sessionStatus: statusArb,
  downloaded: fc.boolean(),
  stillNeededCount: fc.nat({ max: 60 }),
});

const statusIndex = (status: SessionStatus) => SESSION_STATUSES.indexOf(status);
const kindIndex = (action: HandoffAction) => HANDOFF_ACTION_KINDS.indexOf(action.kind);

/** Copy that says the app itself signed, sent, submitted, filed, or faxed. */
const APP_SENT_CLAIM =
  /\b(?:we|the app|this app)\s+(?:have\s+|has\s+|already\s+)*(?:signed|sent|submitted|filed|faxed|mailed)\b|\b(?:was|were|has been|have been)\s+(?:signed|sent|submitted|filed|faxed|mailed)\b|\b(?:signed|sent|submitted|filed|faxed|mailed)\s+(?:it|this|your application)\s+for you\b/i;

function copyOf(action: HandoffAction): string[] {
  return [action.title, action.detail, HANDOFF_WHERE_LABELS[action.where]];
}

describe("nextHandoffAction: exactly one action for every state", () => {
  it("is total and deterministic over the BN-25 lifecycle", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const action = nextHandoffAction(state);
        expect(HANDOFF_ACTION_KINDS).toContain(action.kind);
        expect(HANDOFF_WHERE).toContain(action.where);
        expect(action.title.trim()).not.toBe("");
        expect(action.detail.trim()).not.toBe("");
        expect(nextHandoffAction({ ...state })).toEqual(action);
      }),
      { numRuns: 300 },
    );
  });

  it("labels where it happens by the lifecycle: the app, then an official channel, then a caseworker", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const { where } = nextHandoffAction(state);
        if (state.sessionStatus === "draft" || state.sessionStatus === "prepared") {
          expect(where).toBe("in_app");
        } else if (state.sessionStatus === "handed_off") {
          expect(where).toBe("official_channel");
        } else {
          expect(USER_REPORTED_SESSION_STATUSES).toContain(state.sessionStatus);
          expect(where).toBe("caseworker");
        }
      }),
      { numRuns: 300 },
    );
  });

  it("only ever leads to the very next BN-25 state, so nothing user-reported comes before the handoff", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const { leadsTo } = nextHandoffAction(state);
        if (leadsTo === undefined) {
          return;
        }
        expect(statusIndex(leadsTo)).toBe(statusIndex(state.sessionStatus) + 1);
        if ((USER_REPORTED_SESSION_STATUSES as readonly string[]).includes(leadsTo)) {
          expect(state.sessionStatus).toBe("handed_off");
        }
      }),
      { numRuns: 300 },
    );
  });

  it("moves forward as the session moves forward, never back", () => {
    // Two distinct lifecycle positions, built directly (no filtering), each
    // with its own download flag and count.
    const positionsArb = fc.uniqueArray(
      fc.integer({ min: 0, max: SESSION_STATUSES.length - 1 }),
      { minLength: 2, maxLength: 2 },
    );
    fc.assert(
      fc.property(
        positionsArb,
        fc.boolean(),
        fc.boolean(),
        fc.nat({ max: 60 }),
        fc.nat({ max: 60 }),
        ([first, second], downloadedA, downloadedB, countA, countB) => {
          const [low, high] = first! < second! ? [first!, second!] : [second!, first!];
          const earlier = nextHandoffAction({
            sessionStatus: SESSION_STATUSES[low]!,
            downloaded: downloadedA,
            stillNeededCount: countA,
          });
          const later = nextHandoffAction({
            sessionStatus: SESSION_STATUSES[high]!,
            downloaded: downloadedB,
            stillNeededCount: countB,
          });
          expect(kindIndex(earlier)).toBeLessThan(kindIndex(later));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("reads the download only once prepared, and the count only in draft", () => {
    fc.assert(
      fc.property(stateArb, fc.boolean(), fc.nat({ max: 60 }), (state, downloaded, count) => {
        if (state.sessionStatus !== "prepared") {
          expect(nextHandoffAction({ ...state, downloaded })).toEqual(
            nextHandoffAction(state),
          );
        }
        if (state.sessionStatus !== "draft") {
          expect(nextHandoffAction({ ...state, stillNeededCount: count })).toEqual(
            nextHandoffAction(state),
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  it("says exactly how many items are still needed while answering", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.nat({ max: 60 }), (downloaded, count) => {
        const action = nextHandoffAction({ sessionStatus: "draft", downloaded, stillNeededCount: count });
        if (count === 0) {
          expect(action.kind).toBe("mark_prepared");
          return;
        }
        expect(action.kind).toBe("answer_remaining");
        expect(action.detail).toContain(count === 1 ? "1 item as needed" : `${count} items as needed`);
      }),
      { numRuns: 200 },
    );
  });

  it("stays one sensible action even for a count that is not a whole number", () => {
    const oddCountArb = fc.oneof(
      fc.double({ min: -1e6, max: 1e6 }),
      fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
    );
    fc.assert(
      fc.property(statusArb, fc.boolean(), oddCountArb, (sessionStatus, downloaded, count) => {
        const action = nextHandoffAction({ sessionStatus, downloaded, stillNeededCount: count });
        expect(HANDOFF_ACTION_KINDS).toContain(action.kind);
        expect(action.detail).not.toMatch(/NaN|Infinity|-\d|\d\.\d/);
      }),
      { numRuns: 300 },
    );
  });

  it.each<[SessionStatus, boolean, number, HandoffAction["kind"], string]>([
    ["draft", false, 3, "answer_remaining", "In the app"],
    ["draft", true, 1, "answer_remaining", "In the app"],
    ["draft", false, 0, "mark_prepared", "In the app"],
    ["prepared", false, 5, "download", "In the app"],
    ["prepared", true, 5, "mark_handed_off", "In the app"],
    ["handed_off", false, 5, "sign_and_send", "On an official channel"],
    ["handed_off", true, 0, "sign_and_send", "On an official channel"],
    ["user_reported_submitted", true, 0, "follow_up", "With a caseworker"],
    ["user_reported_decided", false, 2, "decision_questions", "With a caseworker"],
  ])("%s, downloaded %s, %i still needed: %s, labeled %s", (sessionStatus, downloaded, count, kind, label) => {
    const action = nextHandoffAction({ sessionStatus, downloaded, stillNeededCount: count });
    expect(action.kind).toBe(kind);
    expect(HANDOFF_WHERE_LABELS[action.where]).toBe(label);
  });
});

describe("nextHandoffAction: honest copy", () => {
  it("never promises an outcome and never says the app signed or sent anything", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        for (const text of copyOf(nextHandoffAction(state))) {
          expect(findBannedClaims(text), text).toEqual([]);
          expect(text).not.toMatch(APP_SENT_CLAIM);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never brings up submitting before the session is handed off", () => {
    const beforeHandoffArb = fc.record({
      sessionStatus: fc.constantFrom<SessionStatus>("draft", "prepared"),
      downloaded: fc.boolean(),
      stillNeededCount: fc.nat({ max: 60 }),
    });
    fc.assert(
      fc.property(beforeHandoffArb, (state) => {
        expect(copyOf(nextHandoffAction(state)).join(" ")).not.toMatch(/submit/i);
      }),
      { numRuns: 200 },
    );
  });

  it("tells the person, at the handoff, that they sign and send it themselves", () => {
    const action = nextHandoffAction({
      sessionStatus: "handed_off",
      downloaded: true,
      stillNeededCount: 0,
    });
    expect(action.title).toContain("yourself");
    expect(action.detail).toContain("The app doesn't sign, send, or submit anything for you.");
  });

  it("bites: the copy checks flag promise and app-sent language", () => {
    expect(findBannedClaims("Good news: you will be approved.")).not.toEqual([]);
    for (const text of [
      "We submitted your application.",
      "Your application was sent.",
      "The app has faxed it.",
      "We sent it for you.",
    ]) {
      expect(text).toMatch(APP_SENT_CLAIM);
    }
    expect("The app doesn't sign, send, or submit anything for you.").not.toMatch(
      APP_SENT_CLAIM,
    );
  });
});

describe("handoffCompanion: the sourced steps behind the actions", () => {
  const real = parseKbEntry(realEntryJson as unknown);

  it("builds the pilot's companion from the production KB entry, in KB order", () => {
    expect(KB_ENTRIES[0]?.id).toBe(real.id);
    expect(PILOT_HANDOFF_COMPANION).not.toBeNull();
    expect(PILOT_HANDOFF_COMPANION?.submissionSteps.map((step) => step.id)).toEqual(
      real.facts.submission_steps?.items.map((step) => step.id),
    );
    expect(PILOT_HANDOFF_COMPANION?.afterYouApply.map((step) => step.id)).toEqual(
      real.facts.after_you_apply?.items.map((step) => step.id),
    );
  });

  it("gives every step the card of the source it names, never another one", () => {
    const companion = handoffCompanion(real)!;
    const kbSteps = [
      ...(real.facts.submission_steps?.items ?? []),
      ...(real.facts.after_you_apply?.items ?? []),
    ];
    const steps = [...companion.submissionSteps, ...companion.afterYouApply];
    expect(steps).toHaveLength(kbSteps.length);
    steps.forEach((step, index) => {
      const kbStep = kbSteps[index]!;
      const source = real.sources.find((candidate) => candidate.id === kbStep.sourceId)!;
      expect(step.id).toBe(kbStep.id);
      expect(step.label).toBe(kbStep.label);
      expect(step.detail).toBe(kbStep.detail);
      expect(step.link).toEqual(kbStep.link);
      expect(step.source).toEqual({
        title: source.title,
        url: source.url,
        retrievedAt: "2026-10-30",
        entryVersion: real.version,
        entryStatus: "active",
      });
    });
  });

  it("backs every action outside the app with a non-empty list of steps", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const action = nextHandoffAction(state);
        if (action.where !== "in_app") {
          expect(action.guide).toBeDefined();
        }
        if (action.guide === "submission_steps") {
          expect(PILOT_HANDOFF_COMPANION?.submissionSteps.length).toBeGreaterThan(0);
        }
        if (action.guide === "after_you_apply") {
          expect(PILOT_HANDOFF_COMPANION?.afterYouApply.length).toBeGreaterThan(0);
          expect(showsAfterYouApply(state.sessionStatus)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("shows what to expect only once the form is handed off", () => {
    for (const status of SESSION_STATUSES) {
      expect(showsAfterYouApply(status), status).toBe(
        statusIndex(status) >= statusIndex("handed_off"),
      );
    }
  });

  function variant(changes: Record<string, unknown>, dropGroups: string[] = []): KbEntry {
    const raw = structuredClone(realEntryJson) as Record<string, unknown>;
    Object.assign(raw, changes);
    for (const group of dropGroups) {
      delete (raw.facts as Record<string, unknown>)[group];
    }
    return parseKbEntry(raw);
  }

  it("flags every step of a stale entry with the status and reason", () => {
    const stale = variant({ status: "stale", status_reason: "The county page changed." });
    const companion = handoffCompanion(stale)!;
    for (const step of [...companion.submissionSteps, ...companion.afterYouApply]) {
      expect(step.source.entryStatus).toBe("stale");
      expect(step.source.statusReason).toBe("The county page changed.");
    }
  });

  it("never cites a withdrawn entry, and needs both lists to back the handoff", () => {
    expect(handoffCompanion(variant({ status: "withdrawn", status_reason: "Retracted." }))).toBeNull();
    expect(handoffCompanion(variant({}, ["submission_steps"]))).toBeNull();
    expect(handoffCompanion(variant({}, ["after_you_apply"]))).toBeNull();
    expect(handoffCompanion(parseKbEntry(sampleEntryJson as unknown))).toBeNull();
  });

  it("takes the first entry that can back the handoff", () => {
    const sample = parseKbEntry(sampleEntryJson as unknown);
    const withdrawn = variant({ status: "withdrawn", status_reason: "Retracted." });
    expect(firstHandoffCompanion([])).toBeNull();
    expect(firstHandoffCompanion([sample, withdrawn])).toBeNull();
    expect(firstHandoffCompanion([sample, withdrawn, real])).toEqual(handoffCompanion(real));
  });
});

describe("the handoff code stays name-free", () => {
  // The program, jurisdiction, and portal names from the KB and forms
  // blocklists (tests/test_kb_schema.py, tests/test_forms_registry.py): the
  // handoff's names come from the knowledge base, never from its code.
  const NAMES =
    /\b(?:SNAP|CalFresh|food stamps|Section 8|Medicaid|Medicare|SSI|SSDI|TANF|WIC|LIHEAP|EBT|ACA|CHIP|EITC|North Carolina|Mecklenburg|Charlotte|Raleigh|ePASS|NCID|ncdhhs|mecknc)\b/i;
  const FILES = ["./handoff.ts", "../components/source-card.tsx"];

  it.each(FILES)("%s names no program, place, or portal", (file) => {
    const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    expect(source.match(NAMES)?.[0] ?? null).toBeNull();
  });

  it("bites: the scan catches a name", () => {
    expect("Apply online through ePASS").toMatch(NAMES);
    expect("the Mecklenburg County page").toMatch(NAMES);
  });
});
