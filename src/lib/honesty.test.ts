import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ANSWER_STATUS_LABELS,
  ANSWER_STATUSES,
  APP_SETTABLE_SESSION_STATUSES,
  BANNED_CLAIM_PATTERNS,
  BannedClaimError,
  SESSION_STATUSES,
  SESSION_STATUS_LABELS,
  USER_REPORTED_SESSION_STATUSES,
  type AppSettableSessionStatus,
  type SessionStatus,
  type UserReportedSessionStatus,
  assertNoBannedClaims,
  answerStatusLabel,
  findBannedClaims,
  isAnswerStatus,
  isAppSettableSessionStatus,
  isSessionStatus,
  isUserReportedSessionStatus,
} from "./honesty";

// Fixture strings containing banned promise language. The detector must flag
// every one of them (VAL-HON-001).
const BANNED_FIXTURES: { label: string; text: string }[] = [
  { label: "direct eligibility claim", text: "Great news: you are eligible for assistance." },
  { label: "contraction eligibility claim", text: "You're eligible for this program." },
  { label: "future eligibility claim", text: "You will be eligible once you apply." },
  { label: "modal eligibility claim", text: "You must be eligible with that income." },
  { label: "denial eligibility claim", text: "Sorry, you are not eligible." },
  { label: "direct qualification claim", text: "You qualify for food assistance." },
  { label: "future qualification claim", text: "You will qualify once you apply." },
  { label: "hedged-but-asserted qualification", text: "With that income, you should qualify." },
  { label: "denial qualification claim", text: "You do not qualify for this program." },
  { label: "future approval promise", text: "You will be approved." },
  { label: "present approval claim", text: "You are approved for the program." },
  { label: "contraction approval promise", text: "You'll be approved in no time." },
  { label: "going-to approval promise", text: "You are going to be approved, don't worry." },
  { label: "denial approval claim", text: "You will not be approved." },
  { label: "going-to denial approval claim", text: "You are not going to be approved." },
  { label: "going-to eligibility claim", text: "You are going to be eligible for this program." },
  { label: "going-to qualification claim", text: "You are going to qualify." },
  { label: "should eligibility claim", text: "You should be eligible." },
  { label: "easily approval promise", text: "You will easily be approved." },
  { label: "guaranteed outcome", text: "Approval is guaranteed." },
  { label: "guaranteed approval", text: "This is a guaranteed approval service." },
  { label: "we guarantee", text: "We guarantee results." },
  { label: "we can promise", text: "We can promise you a positive result." },
  { label: "benefits outcome promise", text: "You will receive benefits from the program." },
  { label: "contraction benefits promise", text: "You'll get the benefits you are owed." },
  { label: "instant approval marketing", text: "Get instant approval today." },
  { label: "automatic approval marketing", text: "Automatic approval for everyone who applies." },
  // Criteria-satisfaction determinations ("meets the rules" phrasing,
  // droid-review P3-2 on PR #45): asserting the person satisfies the
  // program's criteria is a determination whether addressed to the person
  // ("you") or in third person.
  { label: "meet rules determination", text: "Based on what you told us, you meet the income rules." },
  { label: "meet requirements determination", text: "You meet all the program's requirements." },
  { label: "third-person meet determination", text: "She meets the program's requirements." },
  { label: "plural meet determination", text: "They meet the guidelines for assistance." },
  { label: "future meet promise", text: "You will meet the eligibility criteria once you apply." },
  { label: "modal meet determination", text: "You should meet the income rules with that household size." },
  { label: "negated meet determination", text: "You do not meet the income rules." },
  { label: "future negated meet determination", text: "You will not meet the requirements without a verified ID." },
  { label: "contraction meet promise", text: "You'll meet the income rules once you apply." },
  { label: "that-clause meet determination", text: "Your answers show that you meet the requirements." },
  { label: "documentation meet determination", text: "She meets the documentation rules for the program." },
  { label: "of-form meet determination", text: "You meet all of the income rules." },
  { label: "past-tense meet determination", text: "You've met the requirements for assistance." },
  { label: "have met determination", text: "You have not met the requirements without a verified ID." },
  { label: "satisfy determination", text: "You satisfy the eligibility criteria." },
  { label: "third-person satisfy determination", text: "She satisfies the income rules." },
  { label: "contracted negation meet", text: "You don't meet the income rules." },
  { label: "contracted negation future meet", text: "You won't meet the requirements without a verified ID." },
  { label: "contracted negation past meet", text: "You haven't met the criteria for assistance." },
  { label: "reported determination without that", text: "Your answers show you meet the requirements." },
  { label: "singular rule determination", text: "You meet the income limit for the program." },
  { label: "singular requirement determination", text: "She meets the residency requirement." },
  // Continued-coverage and renewal-outcome promises (HACK-50 renewal
  // tracker): a renewal reminder must never say the person's coverage
  // carries on, or that the renewal or application will go through.
  { label: "stay covered promise", text: "You will stay covered as long as you renew." },
  { label: "stay eligible promise", text: "You'll stay eligible after this renewal." },
  { label: "remain enrolled promise", text: "You are going to remain enrolled." },
  { label: "keep coverage promise", text: "You'll keep your coverage after the renewal." },
  { label: "continue benefits promise", text: "You will continue to get your benefits." },
  { label: "never lose coverage promise", text: "You won't lose your health coverage." },
  { label: "will not lose promise", text: "You will not lose your benefits this year." },
  { label: "renewal approval promise", text: "Your renewal will be approved." },
  { label: "coverage continues promise", text: "Your coverage will continue after you renew." },
  { label: "application goes through promise", text: "Your application is going to go through." },
  // Every renewal promise from the HACK-50 trust review's probe (30 of
  // these 35 got through the first version of the two patterns above).
  { label: "probe: still eligible, contraction", text: "You're still eligible for Medicaid." },
  { label: "probe: still eligible after renewal", text: "You are still eligible after your renewal." },
  { label: "probe: still qualify", text: "You still qualify for NC Medicaid." },
  { label: "probe: remain eligible", text: "You remain eligible." },
  { label: "probe: remain covered", text: "You remain covered through 2027." },
  { label: "probe: still covered", text: "You are still covered." },
  { label: "probe: covered through", text: "You're covered through June 2027." },
  { label: "probe: stay covered, present", text: "You stay covered as long as you answer the letter." },
  { label: "probe: keep coverage, present", text: "You keep your coverage." },
  { label: "probe: keep Medicaid, present", text: "You keep your Medicaid." },
  { label: "probe: will keep Medicaid", text: "You will keep Medicaid." },
  { label: "probe: stay on Medicaid", text: "You'll stay on Medicaid." },
  { label: "probe: remain on NC Medicaid", text: "You'll remain on NC Medicaid." },
  { label: "probe: will not lose Medicaid", text: "You will not lose Medicaid." },
  { label: "probe: Medicaid will be renewed", text: "Your Medicaid will be renewed." },
  { label: "probe: NC Medicaid will continue", text: "Your NC Medicaid will continue." },
  { label: "probe: Medicaid won't stop", text: "Your Medicaid won't stop." },
  { label: "probe: coverage won't end", text: "Your coverage won't end." },
  { label: "probe: coverage will not end", text: "Your coverage will not end." },
  { label: "probe: coverage is safe", text: "Your coverage is safe." },
  { label: "probe: renewal is approved", text: "Your renewal is approved." },
  { label: "probe: renewal was approved", text: "Your renewal was approved." },
  { label: "probe: renewal has been approved", text: "Your renewal has been approved." },
  { label: "probe: renewed automatically", text: "You'll be renewed automatically." },
  { label: "probe: re-approved", text: "You will be re-approved." },
  {
    label: "probe: renewal happens automatically",
    text: "Your renewal happens automatically, so you don't need to do anything.",
  },
  { label: "probe: no gap in coverage", text: "There will be no gap in your coverage." },
  { label: "probe: won't be cut off", text: "You won't be cut off." },
  { label: "probe: definitely stay covered", text: "You will definitely stay covered." },
  { label: "probe: going to stay covered", text: "You're going to stay covered." },
  { label: "probe: continue to receive benefits", text: "You will continue to receive your benefits." },
  { label: "probe: continue to have Medicaid", text: "You will continue to have Medicaid." },
  { label: "probe: keep health coverage", text: "You'll keep your health coverage after you renew." },
  { label: "probe: renewal will go through", text: "Your renewal will go through." },
  { label: "probe: recertification will be approved", text: "Your recertification will be approved." },
  // The boundary the "that" rule draws: a reported or negated promise
  // after "that" stays banned, like "show that you meet" above.
  { label: "that-clause coverage promise", text: "This means that you will stay covered." },
  // Promises the second HACK-50 review's probe found getting through: other
  // negations before "lose", present-tense outcomes, "continue to be",
  // "still have", "won't be a gap", someone else the renewal is for, and
  // curly apostrophes.
  { label: "review 2: will never lose", text: "You will never lose your coverage." },
  { label: "review 2: 'll never lose", text: "You'll never lose your Medicaid." },
  { label: "review 2: can't lose", text: "You can't lose your coverage." },
  { label: "review 2: cannot lose", text: "You cannot lose your Medicaid." },
  { label: "review 2: won't be dropped", text: "You won't be dropped." },
  { label: "review 2: coverage continues", text: "Your coverage continues." },
  { label: "review 2: benefits continue", text: "Your benefits continue." },
  { label: "review 2: will renew automatically", text: "Your coverage will renew automatically." },
  { label: "review 2: continue to be covered", text: "You will continue to be covered." },
  { label: "review 2: still have coverage", text: "You will still have coverage." },
  { label: "review 2: still have Medicaid", text: "You'll still have Medicaid next year." },
  { label: "review 2: continue to be eligible", text: "You will continue to be eligible." },
  { label: "review 2: continue to qualify", text: "You will continue to qualify." },
  { label: "review 2: won't be a gap", text: "There won't be a gap in your coverage." },
  { label: "review 2: child will stay covered", text: "Your child will stay covered." },
  { label: "review 2: they will stay covered", text: "They will stay covered." },
  { label: "review 2: curly 'll stay covered", text: "You\u2019ll stay covered." },
  { label: "review 2: curly won't lose", text: "You won\u2019t lose your coverage." },
  { label: "review 2: curly 're still covered", text: "You\u2019re still covered." },
  { label: "review 2: curly 're eligible", text: "You\u2019re eligible." },
  { label: "third person: won't lose their coverage", text: "Your kids won't lose their coverage." },
  { label: "third person: she will keep her Medicaid", text: "She'll keep her Medicaid after the renewal." },
  { label: "coverage will never end", text: "Your coverage will never end." },
];

// Honest sentences that must pass the detector untouched. Hedged uncertainty
// ("may be eligible") is allowed — surfacing uncertainty is the point.
const HONEST_SENTENCES: string[] = [
  "You told us your case is pending.",
  "You reported that you were approved last month.",
  "We cannot guarantee outcomes, and only the official program decides.",
  "Only the official program can decide your eligibility.",
  "You may be eligible for some programs; you can check with the office.",
  "Nothing here is a promise about your case.",
  // Hedged and requirement forms of the criteria phrasing stay allowed —
  // uncertainty and program requirements are honest, determinations are not.
  "You may meet the income rules for this program.",
  "You would need to meet the income rules the official source lists.",
  "You may not meet the income rules yet; the official rules decide.",
  // Conditionals are not determinations: the hedge lives in the consequent,
  // and any assertion there is still caught by the eligible/qualify/approved
  // patterns. Reporting clauses ("shows that you meet...") are assertions.
  "If you meet the income limits, you may be eligible.",
  "The checklist shows whether you meet the requirements.",
  "When you meet the income limits, you may be eligible.",
  "Once you meet the requirements, you may be eligible.",
  // Open conditionals describe what may happen, not the person's outcome.
  "You can keep your answers until you meet the caseworker.",
  "Unless you meet the limits, the office may review your file.",
  // Renewal copy (HACK-50): dates that "may be due", hedged risk, and what
  // the office decides stay allowed.
  "Your renewal may be due around March 1, 2027.",
  "You may lose your coverage if you do not answer the letter.",
  "The office decides whether your coverage continues.",
  "If your renewal is approved, you get a letter from the office.",
  "You will still need to renew on time.",
  "You'll keep your answers on this device until you remove them.",
  "You will get a letter if you need to do anything to renew.",
  "Answer any letter right away so there is no gap in your coverage.",
  // Open questions about the outcome (the HACK-50 trust review's honest
  // framings that start with "whether" or "if").
  "Ask your local DSS whether you will stay covered.",
  "Only your local DSS can say whether your coverage will continue.",
  "We can't tell you if your renewal will be approved.",
  "Your local DSS decides whether your application will go through.",
  // How to word a negated report under the "that" rule.
  "No one can promise coverage after a renewal.",
  // Reported past and conditionals stay allowed.
  "You told us you were renewed in March.",
  "If you're covered by another plan, tell the office.",
  "If you lose your Medicaid, you will get a letter.",
  "Recertification is how the office decides whether their Medicaid continues.",
  // Near misses for the second review's patterns: a hedge with "can", a
  // "never" that is not about coverage, "have" without "still", questions,
  // and the third-person conditional.
  "You can lose your coverage if you do not answer the letter.",
  "You can never be sure which date applies, so check your letter.",
  "You will have your answers on this device until you remove them.",
  "Ask the office whether your child will stay covered.",
  "If they keep their coverage, the office sends a letter.",
  "Will there be a gap in your coverage? Ask your local DSS.",
];

// Parsed from the repo's spec and migration files at test time — the literals
// are compared against this module's constants (VAL-HON-003).
const SPEC_PATH = fileURLToPath(
  new URL("../../specs/question-spec/generic-questions.json", import.meta.url),
);
const SCHEMA_PATH = fileURLToPath(
  new URL("../../specs/question-spec/schema.json", import.meta.url),
);
const MIGRATION_PATH = fileURLToPath(
  new URL("../../migrations/0001_core.sql", import.meta.url),
);

function statusCheckValues(sql: string, constraintName: string): string[] {
  const pattern = new RegExp(`${constraintName}\\s+CHECK \\(status IN \\(([^)]*)\\)`);
  const match = sql.match(pattern);
  if (!match) {
    throw new Error(`constraint ${constraintName} not found in migration`);
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe("banned-claims detector", () => {
  it("flags every banned-claim fixture", () => {
    const misses = BANNED_FIXTURES.filter(
      (fixture) => findBannedClaims(fixture.text).length === 0,
    ).map((fixture) => fixture.label);
    expect(misses, "fixtures not flagged by any pattern").toEqual([]);
  });

  it("has no dead patterns: every pattern matches at least one fixture", () => {
    for (const pattern of BANNED_CLAIM_PATTERNS) {
      const covered = BANNED_FIXTURES.some((fixture) => pattern.test(fixture.text));
      expect(covered, pattern.source).toBe(true);
    }
  });

  it("lets honest language through", () => {
    for (const sentence of HONEST_SENTENCES) {
      expect(findBannedClaims(sentence), sentence).toEqual([]);
    }
  });

  it("throws BannedClaimError from assertNoBannedClaims", () => {
    expect(() => assertNoBannedClaims("You are eligible.")).toThrow(BannedClaimError);
    expect(() => assertNoBannedClaims(HONEST_SENTENCES.join(" "))).not.toThrow();
  });
});

describe("AnswerStatus vs the question spec", () => {
  it("literals equal answer_statuses parsed from generic-questions.json", () => {
    const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
      answer_statuses: string[];
    };
    expect([...ANSWER_STATUSES].sort()).toEqual([...spec.answer_statuses].sort());
  });

  it("schema.json pins the same tri-state enum", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as {
      properties: { answer_statuses: { items: { enum: string[] } } };
    };
    const enumValues = schema.properties.answer_statuses.items.enum;
    expect([...enumValues].sort()).toEqual([...ANSWER_STATUSES].sort());
  });

  it("literals equal the answer_status_check values in the migration", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    expect([...ANSWER_STATUSES].sort()).toEqual(
      statusCheckValues(sql, "answer_status_check").sort(),
    );
  });
});

describe("answer status labels", () => {
  it("uses the plain-language contract labels", () => {
    expect(ANSWER_STATUS_LABELS.known).toBe("You told us");
    expect(ANSWER_STATUS_LABELS.unknown).toBe("You're not sure");
    expect(ANSWER_STATUS_LABELS.unverified).toBe("Answered but not verified");
    expect(answerStatusLabel("unknown")).toBe("You're not sure");
  });

  it("labels are non-promissory and cover every status", () => {
    expect(Object.keys(ANSWER_STATUS_LABELS).sort()).toEqual(
      [...ANSWER_STATUSES].sort(),
    );
    for (const label of Object.values(ANSWER_STATUS_LABELS)) {
      expect(() => assertNoBannedClaims(label)).not.toThrow();
    }
  });
});

describe("isAnswerStatus", () => {
  it("accepts the tri-state and rejects everything else", () => {
    for (const status of ANSWER_STATUSES) {
      expect(isAnswerStatus(status)).toBe(true);
    }
    expect(isAnswerStatus("maybe")).toBe(false);
    expect(isAnswerStatus("submitted")).toBe(false);
    expect(isAnswerStatus(null)).toBe(false);
  });
});

describe("BN-25 session-state vocabulary", () => {
  it("is exactly the five BN-25 states", () => {
    expect([...SESSION_STATUSES].sort()).toEqual([
      "draft",
      "handed_off",
      "prepared",
      "user_reported_decided",
      "user_reported_submitted",
    ]);
  });

  it("app-settable and user-reported states exactly partition the vocabulary", () => {
    expect(
      [...APP_SETTABLE_SESSION_STATUSES, ...USER_REPORTED_SESSION_STATUSES].sort(),
    ).toEqual([...SESSION_STATUSES].sort());
    expect(
      APP_SETTABLE_SESSION_STATUSES.some((status) =>
        isUserReportedSessionStatus(status),
      ),
      "no app-settable state may carry user-reported semantics",
    ).toBe(false);
  });

  it("session_status_check values in the migration equal the vocabulary", () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    expect([...SESSION_STATUSES].sort()).toEqual(
      statusCheckValues(sql, "session_status_check").sort(),
    );
  });

  it("guards classify app-settable and user-reported states", () => {
    expect(isSessionStatus("submitted")).toBe(false);
    expect(isAppSettableSessionStatus("prepared")).toBe(true);
    expect(isAppSettableSessionStatus("user_reported_submitted")).toBe(false);
    expect(isUserReportedSessionStatus("user_reported_decided")).toBe(true);
    expect(isUserReportedSessionStatus("draft")).toBe(false);
  });

  it("labels every session state in plain language, non-promissory", () => {
    expect(Object.keys(SESSION_STATUS_LABELS).sort()).toEqual(
      [...SESSION_STATUSES].sort(),
    );
    for (const label of Object.values(SESSION_STATUS_LABELS)) {
      expect(() => assertNoBannedClaims(label)).not.toThrow();
    }
  });

  it("partition and vocabulary hold at the type level (VAL-HON-004)", () => {
    type Unpartitioned = Exclude<
      SessionStatus,
      AppSettableSessionStatus | UserReportedSessionStatus
    >;
    expectTypeOf<Unpartitioned>().toEqualTypeOf<never>();
    expectTypeOf<AppSettableSessionStatus>().not.toExtend<UserReportedSessionStatus>();
    expectTypeOf<AppSettableSessionStatus>().toEqualTypeOf<
      "draft" | "prepared" | "handed_off"
    >();
    expectTypeOf<UserReportedSessionStatus>().toEqualTypeOf<
      "user_reported_submitted" | "user_reported_decided"
    >();
    expectTypeOf<"submitted">().not.toExtend<SessionStatus>();
  });

  it("assigning a submitted state to an app-settable status is a compile error", () => {
    const prepared: AppSettableSessionStatus = "prepared";
    // @ts-expect-error BN-25: no app-settable session state may be a submitted state
    const appSetSubmitted: AppSettableSessionStatus = "submitted";
    expect(prepared).toBe("prepared");
    expect(isUserReportedSessionStatus(appSetSubmitted)).toBe(false);
  });
});
