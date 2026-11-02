import fc from "fast-check";
import { describe, expect, it } from "vitest";
import dhb5200Raw from "../../../kb/forms/dhb-5200.json";
import { PILOT_CONFIG } from "../pilot";
import { visibleQuestions, type AnswerMap, type StoredAnswer } from "./flow";
import { buildClientState } from "./client-state";
import {
  DEFAULT_PROGRAM_IDS,
  PROGRAM_REQUIREMENTS,
  remainingQuickQuestions,
  requiredForPrograms,
} from "./requirements";
import { QUESTION_BY_ID, QUESTIONS } from "./spec";

// Quick-questions requirements engine (quick-questions milestone, part 1):
// the committed program-requirements layer plus the form registries'
// spec_question_id links decide which questions a session still needs.
// These tests pin the honest math: M (the required-for-programs universe)
// and N (still to ask = required minus answered minus skippable, reusing
// flow.ts's skip logic — never a fork) are computed live from real data.

const ALL_IDS = QUESTIONS.map((question) => question.id);

/** A type-fitting non-blank value for a question (first option, say). */
function fittingValue(questionId: string): unknown {
  const question = QUESTION_BY_ID[questionId]!;
  if (question.type === "single_select" || question.type === "multi_select") {
    return question.options![0]!.value;
  }
  if (question.type === "boolean") {
    return true;
  }
  if (question.type === "number") {
    return 1;
  }
  return "2026-01-01";
}

/** A known stored answer carrying a type-fitting non-blank value. */
function knownAnswer(questionId: string): StoredAnswer {
  return { status: "known", value: fittingValue(questionId) };
}

function answersFor(ids: readonly string[]): AnswerMap {
  const answers: Record<string, StoredAnswer> = {};
  for (const id of ids) {
    answers[id] = knownAnswer(id);
  }
  return answers;
}

/** fast-check arbitrary for one stored answer of a given question. */
function answerArb(questionId: string): fc.Arbitrary<StoredAnswer> {
  const question = QUESTION_BY_ID[questionId]!;
  const fitting: fc.Arbitrary<unknown> =
    question.type === "single_select"
      ? fc.constantFrom(...question.options!.map((option) => option.value))
      : question.type === "multi_select"
        ? fc.subarray(
            question.options!.map((option) => option.value),
            { minLength: 1 },
          )
        : question.type === "boolean"
          ? fc.boolean()
          : question.type === "number"
            ? fc.integer({ min: 0, max: 2000 })
            : fc.constant(fittingValue(questionId));
  return fc.oneof(
    // Known, with a type-fitting value (never blank — blank answers never
    // satisfy operators, which is flow.ts's fail-open contract).
    fc.record({
      status: fc.constant("known" as const),
      value: fitting,
    }),
    // Unknown/unverified — stored, but never satisfying an operator.
    fc.constant({ status: "unknown" as const, value: null }),
    fc.constant({ status: "unverified" as const, value: null }),
  );
}

/** Arbitrary for an arbitrary answer map over the full spec population. */
const answerMapsArb: fc.Arbitrary<AnswerMap> = fc
  .subarray(ALL_IDS)
  .chain((ids) => fc.tuple(...ids.map((id) => fc.tuple(fc.constant(id), answerArb(id)))))
  .map((tuples) => Object.fromEntries(tuples) as AnswerMap);

/** Arbitrary for a batch of extra answers layered onto an existing map. */
const extraAnswerIdsArb: fc.Arbitrary<readonly string[]> = fc.subarray(ALL_IDS, {
  maxLength: 20,
});

/** The spec question ids a committed registry's fields link to (raw read). */
function registryLinks(registryId: string): readonly string[] {
  expect(registryId).toBe("dhb-5200");
  const raw = dhb5200Raw as unknown as {
    fields: readonly { spec_question_id: string | null }[];
  };
  return raw.fields.flatMap((field) =>
    field.spec_question_id === null ? [] : [field.spec_question_id],
  );
}

describe("requiredForPrograms", () => {
  it("derives the default programs' universe from committed data, in spec order", () => {
    const universe = requiredForPrograms(DEFAULT_PROGRAM_IDS);
    const specOrder = ALL_IDS.filter((id) => universe.includes(id));
    expect(universe).toEqual(specOrder);
    expect(universe.length).toBeGreaterThan(0);
    for (const id of universe) {
      expect(QUESTION_BY_ID[id], id).toBeDefined();
    }
  });

  it("covers every spec_question_id link of the pilot's form registry", () => {
    // The registry links are real data (kb/forms/dhb-5200.json), read raw
    // here: the derived universe must always contain them.
    const registryId = PILOT_CONFIG.formRegistryId;
    const entry = PROGRAM_REQUIREMENTS.programs.find((program) =>
      program.form_registry_ids.includes(registryId),
    )!;
    const universe = new Set(requiredForPrograms([entry.id]));
    for (const link of registryLinks(registryId)) {
      expect(universe.has(link), `registry link ${link}`).toBe(true);
    }
  });

  it("is idempotent and deduplicates program ids (property)", () => {
    const programIds = PROGRAM_REQUIREMENTS.programs.map((program) => program.id);
    fc.assert(
      fc.property(
        fc.subarray(programIds, { minLength: 1 }),
        fc.subarray(programIds, { minLength: 1 }),
        (list, repeat) => {
          const once = requiredForPrograms(list);
          expect(requiredForPrograms(list)).toEqual(once);
          expect(requiredForPrograms([...list, ...repeat])).toEqual(once);
        },
      ),
    );
  });

  it("throws on an unknown program id", () => {
    expect(() => requiredForPrograms(["not_a_program"])).toThrow();
  });
});

describe("remainingQuickQuestions", () => {
  it("with no answers, nothing is skippable yet: N equals M", () => {
    const view = remainingQuickQuestions({});
    expect(view.remainingCount).toBe(view.requiredCount);
    expect(view.remainingIds).toEqual(view.requiredIds);
    expect(view.complete).toBe(false);
  });

  it("with the whole universe answered, nothing remains (any stored status counts)", () => {
    const universe = requiredForPrograms(DEFAULT_PROGRAM_IDS);
    for (const status of ["known", "unknown", "unverified"] as const) {
      const answers: Record<string, StoredAnswer> = {};
      for (const id of universe) {
        answers[id] = { status, value: fittingValue(id) };
      }
      const view = remainingQuickQuestions(answers);
      expect(view.remainingCount, status).toBe(0);
      expect(view.complete, status).toBe(true);
    }
  });

  it("reuses flow.ts skip logic: remaining is unanswered and visible (property)", () => {
    fc.assert(
      fc.property(answerMapsArb, (answers) => {
        const view = remainingQuickQuestions(answers);
        const visible = new Set(
          visibleQuestions(QUESTIONS, answers).map((question) => question.id),
        );
        for (const id of view.remainingIds) {
          expect(answers[id], `${id} must be unanswered`).toBeUndefined();
          expect(visible.has(id), `${id} must be visible`).toBe(true);
        }
      }),
    );
  });

  it("shrinks monotonically as answers accumulate, while M stays fixed (property)", () => {
    fc.assert(
      fc.property(answerMapsArb, extraAnswerIdsArb, (answers, extraIds) => {
        const before = remainingQuickQuestions(answers);
        // Accumulate answers only for questions not yet answered — a
        // session's answer set grows. (Re-answering an existing question
        // is a correction and may legitimately reveal a previously
        // skipped question; the next test pins that deliberate behavior.)
        const extended: Record<string, StoredAnswer> = {};
        for (const [id, answer] of Object.entries(answers)) {
          if (answer !== undefined) {
            extended[id] = answer;
          }
        }
        const added = extraIds.filter((id) => answers[id] === undefined);
        for (const id of added) {
          extended[id] = knownAnswer(id);
        }
        const after = remainingQuickQuestions(extended);

        expect(after.requiredCount).toBe(before.requiredCount);
        const beforeIds = new Set(before.remainingIds);
        for (const id of after.remainingIds) {
          expect(beforeIds.has(id), `${id} reappeared`).toBe(true);
        }
        expect(after.remainingIds.length).toBeLessThanOrEqual(
          before.remainingIds.length,
        );
        // Answered questions never reappear: the ask-once guarantee.
        for (const id of added) {
          expect(after.remainingIds, id).not.toContain(id);
        }
      }),
    );
  });

  it("recomputes honestly when an answer is corrected (re-ask may reveal)", () => {
    // income_sources = none skips the income branch; correcting it to a
    // job brings income_kind back into the still-to-ask set. The counter
    // reflects the session's real state — never a frozen number.
    const before = remainingQuickQuestions({
      income_sources: { status: "known", value: ["none"] },
    });
    expect(before.remainingIds).not.toContain("income_kind");
    const corrected = remainingQuickQuestions({
      income_sources: { status: "known", value: ["job"] },
    });
    expect(corrected.remainingIds).toContain("income_kind");
  });

  it("keeps N within M (property)", () => {
    fc.assert(
      fc.property(answerMapsArb, (answers) => {
        const view = remainingQuickQuestions(answers);
        expect(view.remainingCount).toBeLessThanOrEqual(view.requiredCount);
        expect(view.remainingCount).toBe(view.remainingIds.length);
      }),
    );
  });

  it("honors the skip chains in both directions (directed)", () => {
    // income_sources = none (known) skips income_kind and the whole
    // income-branch family out of the still-to-ask set.
    const noneView = remainingQuickQuestions({
      income_sources: { status: "known", value: ["none"] },
    });
    const noneRemaining = new Set(noneView.remainingIds);
    for (const id of [
      "income_kind",
      "job_income_amount",
      "job_income_frequency",
      "benefits_income_amount",
      "benefits_income_frequency",
      "other_income_amount",
    ]) {
      expect(noneRemaining.has(id), `${id} should be skippable`).toBe(false);
    }

    // Fail-open: an unknown income_sources answer never skips income_kind.
    const unknownView = remainingQuickQuestions({
      income_sources: { status: "unknown", value: null },
    });
    expect(unknownView.remainingIds).toContain("income_kind");

    // And a job income answer keeps the amount question in the set.
    const jobView = remainingQuickQuestions({
      income_sources: { status: "known", value: ["job"] },
    });
    expect(jobView.remainingIds).toContain("job_income_amount");
  });

  it("defaults to the committed default programs", () => {
    const answers = answersFor(["application_role"]);
    expect(remainingQuickQuestions(answers)).toEqual(
      remainingQuickQuestions(answers, DEFAULT_PROGRAM_IDS),
    );
  });

  it("exposes the targeted program ids it computed for", () => {
    expect(remainingQuickQuestions({}).programs).toEqual(DEFAULT_PROGRAM_IDS);
  });
});

describe("the committed layer's consistency with the pilot", () => {
  it("the pilot's form registry belongs to a default program's requirements", () => {
    const entry = PROGRAM_REQUIREMENTS.programs.find((program) =>
      program.form_registry_ids.includes(PILOT_CONFIG.formRegistryId),
    );
    expect(entry).toBeDefined();
    expect(DEFAULT_PROGRAM_IDS).toContain(entry!.id);
  });

  it("references only question ids the spec defines", () => {
    for (const program of PROGRAM_REQUIREMENTS.programs) {
      for (const id of program.required_question_ids) {
        expect(QUESTION_BY_ID[id], `${program.id}: ${id}`).toBeDefined();
      }
    }
  });
});

describe("work-requirements skip chains (VAL-WR-004/005)", () => {
  // The Civilla two-section design, encoded in the spec: work-activity
  // reporting (who / types / hours last month) is visible ONLY when no
  // exemption, income, or student path applies. The hiding lives in the
  // new questions' skip_conditions — the flow engine's isQuestionVisible
  // does the work; nothing forks flow.ts.

  const WORK_ACTIVITY_IDS = [
    "wr_work_activity_who",
    "wr_work_activity_types",
    "wr_work_activity_hours",
  ];

  const known = (id: string, value: unknown): AnswerMap => ({
    [id]: { status: "known", value },
  });

  /** One fixture per hiding path: a known answer that must hide all three. */
  const HIDING_CASES: readonly {
    readonly path: string;
    readonly answers: AnswerMap;
  }[] = [
    ...["parent_child_under_18", "nonparent_caregiver_child_under_14", "caregiver_daily_activities", "already_snap_tanf_work_requirements"].map(
      (option) => ({
        path: `exemption selection: ${option}`,
        answers: known("wr_exempt_situations", [option]),
      }),
    ),
    ...[
      "wr_pregnant",
      "wr_drug_alcohol_treatment",
      "wr_drug_alcohol_disorder",
      "wr_disability_hard_work",
      "wr_mental_health_hard_work",
      "wr_serious_health_condition",
      "wr_jail_prison_past_4_months",
      "wr_foster_care_under_26",
      "wr_veteran_100_disabled",
    ].map((id) => ({
      path: `exemption yes: ${id}`,
      answers: known(id, "yes"),
    })),
    { path: "past-month situation: wr_applied_last_month", answers: known("wr_applied_last_month", "yes") },
    { path: "other situation: wr_medical_travel_1hr", answers: known("wr_medical_travel_1hr", "yes") },
    { path: "other situation: wr_hospital_care_24hr", answers: known("wr_hospital_care_24hr", "yes") },
    { path: "income path: wr_income_580", answers: known("wr_income_580", "yes") },
    { path: "student path: full_time", answers: known("wr_student_enrolled", "full_time") },
    { path: "student path: at_least_half_time", answers: known("wr_student_enrolled", "at_least_half_time") },
  ];

  it("hides the work-activity questions for each exemption/income/student path (directed, VAL-WR-004)", () => {
    for (const { path, answers } of HIDING_CASES) {
      // Both surfaces of the same engine: the visible-question filter and
      // the quick-questions still-to-ask set (which reuses it).
      const visible = new Set(
        visibleQuestions(QUESTIONS, answers).map((question) => question.id),
      );
      const view = remainingQuickQuestions(answers);
      for (const id of WORK_ACTIVITY_IDS) {
        expect(visible.has(id), `${path}: ${id} visible`).toBe(false);
        expect(view.remainingIds, `${path}: ${id} still asked`).not.toContain(
          id,
        );
      }
      // ...and the hiding path never over-hides: the exemption screen
      // itself stays in the still-to-ask set (the skip targets ONLY the
      // reporting section).
      const answeredIds = Object.keys(answers);
      for (const id of Object.keys(QUESTION_BY_ID).filter(
        (candidate) =>
          candidate.startsWith("wr_") &&
          !WORK_ACTIVITY_IDS.includes(candidate) &&
          !answeredIds.includes(candidate),
      )) {
        expect(view.remainingIds, `${path}: ${id} over-hidden`).toContain(id);
      }
    }
  });

  it("fail-open: unknown, unverified, or blank answers never trigger the skip", () => {
    for (const status of ["unknown", "unverified"] as const) {
      const answers: Record<string, StoredAnswer> = {};
      for (const id of [
        "wr_exempt_situations",
        "wr_pregnant",
        "wr_applied_last_month",
        "wr_medical_travel_1hr",
        "wr_hospital_care_24hr",
        "wr_income_580",
        "wr_student_enrolled",
      ]) {
        answers[id] = { status, value: null };
      }
      const view = remainingQuickQuestions(answers);
      for (const id of WORK_ACTIVITY_IDS) {
        expect(view.remainingIds, `${status}: ${id}`).toContain(id);
      }
    }
    // Absent answers: a fresh session is asked everything, reporting too.
    const fresh = remainingQuickQuestions({});
    for (const id of WORK_ACTIVITY_IDS) {
      expect(fresh.remainingIds, id).toContain(id);
    }
  });

  it("keeps the work-activity questions visible when every path resolves negative (VAL-WR-005, engine direction)", () => {
    const answers: AnswerMap = {
      wr_exempt_situations: { status: "known", value: ["none"] },
      wr_pregnant: { status: "known", value: "no" },
      wr_drug_alcohol_treatment: { status: "known", value: "no" },
      wr_drug_alcohol_disorder: { status: "known", value: "no" },
      wr_disability_hard_work: { status: "known", value: "no" },
      wr_mental_health_hard_work: { status: "known", value: "no" },
      wr_serious_health_condition: { status: "known", value: "no" },
      wr_jail_prison_past_4_months: { status: "known", value: "no" },
      wr_foster_care_under_26: { status: "known", value: "no" },
      wr_veteran_100_disabled: { status: "known", value: "no" },
      wr_applied_last_month: { status: "known", value: "no" },
      wr_medical_travel_1hr: { status: "known", value: "no" },
      wr_hospital_care_24hr: { status: "known", value: "no" },
      wr_income_580: { status: "known", value: "no" },
      wr_student_enrolled: { status: "known", value: "not_enrolled" },
    };
    const view = remainingQuickQuestions(answers);
    for (const id of WORK_ACTIVITY_IDS) {
      expect(view.remainingIds, id).toContain(id);
    }
    // The which-situations follow-up is NOT asked when nothing applied
    // last month (its own skip chain).
    expect(view.remainingIds).not.toContain("wr_applied_last_month_which");
  });
});

describe("the live completeness definition (client-state complete, pinned)", () => {
  // The results auto-advance's "complete" is the FULL visible-spec walk
  // the conversation has always done: every VISIBLE spec question
  // answered — never required-for-programs only. The quick-questions
  // block's complete narrows to the required universe (the honest
  // counter's denominator); the journey gate does NOT. Pinned explicitly
  // (orchestrator note, Nov 2): live behavior stays as validated across
  // the walkthrough assertions; talk remains the catch-all.
  it("state.complete stays false while a spec question outside the required universe is unanswered", () => {
    const universe = requiredForPrograms(DEFAULT_PROGRAM_IDS);
    const answers: Record<string, StoredAnswer> = {};
    for (const id of universe) {
      answers[id] = knownAnswer(id);
    }
    const state = buildClientState(answers);
    expect(state.quickQuestions.complete).toBe(true);
    // household_seniors, received_benefits_before, and student_status are
    // spec questions outside the required universe (visible, unanswered):
    // the full-spec walk is not done, so the journey gate stays open.
    expect(state.complete).toBe(false);
  });

  it("state.complete turns true exactly when every visible spec question is answered (skips included)", () => {
    const answers: Record<string, StoredAnswer> = {};
    for (const question of QUESTIONS) {
      answers[question.id] = knownAnswer(question.id);
    }
    // Every id has a stored answer, so whatever the skip logic hides is
    // invisible and every visible question is answered.
    expect(buildClientState(answers).complete).toBe(true);
  });
});
