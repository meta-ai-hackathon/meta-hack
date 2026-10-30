import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ANSWER_STATUS_LABELS as SPINE_LABELS,
  BANNED_CLAIM_PATTERNS as SPINE_PATTERNS,
  findBannedClaims as spineFindBannedClaims,
  foldForClaimScan as spineFoldForClaimScan,
} from "../src/lib/honesty";
import {
  ANSWER_STATUS_LABELS,
  BANNED_CLAIM_PATTERNS,
  findBannedClaims,
  findPiiValueExposure,
  findPiiValueLeaks,
  foldForClaimScan,
} from "./walkthrough-detectors.mjs";

// The walkthrough CLI's violation detectors are the runtime check behind
// VAL-WALK-003: they must provably bite on banned-claim language and on
// client-visible pii:true content, and stay silent on clean surfaces. These
// tests run against the exact module scripts/walkthrough.mjs imports — not a
// parallel copy — so a green run proves the shipped CLI detects violations.

// Fixture strings containing banned promise language (mirrors the VAL-HON-001
// fixture family in src/lib/honesty.test.ts).
const BANNED_FIXTURES = [
  "Great news: you are eligible for assistance.",
  "You will be approved once you submit.",
  "You qualify for food assistance.",
  "You should qualify with that income.",
  "You do not qualify for this program.",
  "Approval is guaranteed.",
  "We can promise you a positive result.",
  "You will receive benefits from the program.",
  "Get instant approval today.",
  "Based on what you told us, you meet the income rules.",
  "She meets the program's requirements.",
  "You do not meet the income rules.",
  "You'll meet the income rules once you apply.",
  "Your answers show that you meet the requirements.",
  "She meets the documentation rules for the program.",
  "You meet all of the income rules.",
  "You've met the requirements for assistance.",
  "You satisfy the eligibility criteria.",
  "You don't meet the income rules.",
  "You haven't met the criteria for assistance.",
  "Your answers show you meet the requirements.",
  "You meet the income limit for the program.",
  "You will stay covered as long as you renew.",
  "You won't lose your health coverage.",
  "Your renewal will be approved.",
  "You're still eligible for Medicaid.",
  "You keep your Medicaid.",
  "Your coverage won't end.",
  "Your renewal has been approved.",
  "You'll be renewed automatically.",
  "There will be no gap in your coverage.",
  // The second HACK-50 review's probe, including curly apostrophes, which
  // the CLI folds the same way the app does.
  "You will never lose your coverage.",
  "You'll never lose your Medicaid.",
  "You can't lose your coverage.",
  "You cannot lose your Medicaid.",
  "You won't be dropped.",
  "Your coverage continues.",
  "Your benefits continue.",
  "Your coverage will renew automatically.",
  "You will continue to be covered.",
  "You will still have coverage.",
  "You'll still have Medicaid next year.",
  "You will continue to be eligible.",
  "You will continue to qualify.",
  "There won't be a gap in your coverage.",
  "Your child will stay covered.",
  "They will stay covered.",
  "You\u2019ll stay covered.",
  "You won\u2019t lose your coverage.",
  "You\u2019re still covered.",
  "You\u2019re eligible.",
];

// Honest sentences that must pass untouched. Hedged uncertainty stays
// allowed — surfacing uncertainty is the point.
const CLEAN_TEXT_FIXTURES = [
  "You told us your case is pending.",
  "You may be eligible for some programs; you can check with the office.",
  "Only the official program can decide your eligibility.",
  "Nothing here is a promise about your case.",
  "We cannot guarantee outcomes, and we say so.",
  "You may meet the income rules for this program.",
  "You may not meet the income rules yet; the official rules decide.",
  "If you meet the income limits, you may be eligible.",
  "Unless you meet the limits, the office may review your file.",
  "Your renewal may be due around March 1, 2027.",
  "You may lose your coverage if you do not answer the letter.",
  "If your renewal is approved, you get a letter from the office.",
  "Ask your local DSS whether you will stay covered.",
  "We can't tell you if your renewal will be approved.",
  "You can lose your coverage if you do not answer the letter.",
  "Ask the office whether your child will stay covered.",
];

// A client-state fixture: the shape /api/intake/* and /api/session return.
// Two pii questions answered — one correctly carrying status only, one
// leaking a value (the bug the detector must catch).
const PII_LEAK_STATE = {
  questions: [
    {
      id: "date_of_birth",
      prompt: "What is your date of birth?",
      help: "",
      type: "date",
      required: true,
      pii: true,
    },
    {
      id: "household_size",
      prompt: "How many people live in your household?",
      help: "",
      type: "number",
      required: true,
      pii: false,
    },
  ],
  answers: {
    date_of_birth: { status: "known", value: "1990-05-14" },
    household_size: { status: "known", value: 3 },
  },
  progress: { answered: 2, remaining: 0, total: 2 },
  currentIndex: null,
  complete: true,
};

// The same state with the boundary intact: pii answers carry status alone.
const CLEAN_STATE_FIXTURE = {
  ...PII_LEAK_STATE,
  answers: {
    date_of_birth: { status: "known" },
    household_size: { status: "known", value: 3 },
  },
};

describe("banned-claim detector (walkthrough CLI)", () => {
  it.each(BANNED_FIXTURES.map((text) => [text]))(
    "flags banned fixture: %s",
    (text) => {
      expect(findBannedClaims(text)).not.toEqual([]);
    },
  );

  it.each(CLEAN_TEXT_FIXTURES.map((text) => [text]))(
    "passes clean fixture: %s",
    (text) => {
      expect(findBannedClaims(text)).toEqual([]);
    },
  );

  it("reports the matched text and pattern for every hit", () => {
    const matches = findBannedClaims("You qualify. You will be approved.");
    expect(matches.length).toBe(2);
    for (const match of matches) {
      expect(match.matchedText.length).toBeGreaterThan(0);
      expect(match.patternSource.length).toBeGreaterThan(0);
    }
  });
});

describe("pii-leak detector (walkthrough CLI)", () => {
  it("flags a value shipped under a pii:true question", () => {
    const leaks = findPiiValueLeaks(PII_LEAK_STATE);
    expect(leaks).toEqual([
      { questionId: "date_of_birth", reason: "value_under_pii_question" },
    ]);
  });

  it("passes a state where pii answers carry status only", () => {
    expect(findPiiValueLeaks(CLEAN_STATE_FIXTURE)).toEqual([]);
  });

  it("flags a submitted pii value echoed back in a payload body", () => {
    const privateValues = ["1990-05-14", "jamie.watts@example.com"];
    const body =
      '{"answers":{"household_size":{"status":"known","value":3}},' +
      '"note":"contact jamie.watts@example.com if needed"}';
    const leaks = findPiiValueExposure(body, privateValues);
    expect(leaks).toEqual([{ value: "jamie.watts@example.com" }]);
  });

  it("stays silent when no submitted pii value appears in the body", () => {
    const privateValues = ["1990-05-14", "jamie.watts@example.com"];
    const body = '{"answers":{"household_size":{"status":"known","value":3}}}';
    expect(findPiiValueExposure(body, privateValues)).toEqual([]);
  });
});

describe("walkthrough CLI vocabulary mirrors the honesty spine", () => {
  it("uses the spine's banned-claim patterns verbatim", () => {
    expect(
      BANNED_CLAIM_PATTERNS.map((pattern) => pattern.source),
    ).toEqual(SPINE_PATTERNS.map((pattern) => pattern.source));
  });

  it("uses the spine's honest-status labels verbatim", () => {
    expect(ANSWER_STATUS_LABELS).toEqual(SPINE_LABELS);
  });

  it("folds text exactly as the spine does, so both gates agree on any text", () => {
    const apostrophes = fc.constantFrom("\u2018", "\u2019", "\u201b", "\u02bc", "'", "`", "\u2032", "\u200b", "\u200d", "\ufeff");
    const text = fc.array(fc.oneof(apostrophes, fc.constantFrom("You", "re", "ll", " ", "eligible", "covered", "x")), {
      maxLength: 12,
    });
    fc.assert(
      fc.property(text, (parts) => {
        const joined = parts.join("");
        expect(foldForClaimScan(joined)).toBe(spineFoldForClaimScan(joined));
        expect(foldForClaimScan(joined)).toHaveLength(joined.length);
        expect(findBannedClaims(joined)).toEqual(spineFindBannedClaims(joined));
      }),
      { numRuns: 300 },
    );
  });
});

describe("detector properties (property-based)", () => {
  // Safe alphabet disjoint from every banned-claim trigger word: a detector
  // that scanned too broadly would fire here.
  const safeText = fc.stringMatching(/^[xyz ]{0,40}$/);

  it("never flags text built from safe alphabet words", () => {
    fc.assert(
      fc.property(safeText, (text) => {
        expect(findBannedClaims(text)).toEqual([]);
      }),
    );
  });

  it("detects a banned sentence embedded in arbitrary surrounding text", () => {
    // Fillers are space-delimited so the banned phrase keeps its word
    // boundaries — the detector scans prose, not character soup (a word
    // character glued to "approved" correctly does not match \bapproved\b).
    const before = fc.stringMatching(/^[abc]{0,10} $/);
    const after = fc.stringMatching(/^ [abc]{0,10}$/);
    fc.assert(
      fc.property(before, after, (lead, tail) => {
        const text = `${lead}You will be approved${tail}`;
        expect(findBannedClaims(text)).not.toEqual([]);
      }),
    );
  });

  it("detects any non-empty private value embedded in arbitrary body text", () => {
    const value = fc.stringMatching(/^[pqr]{3,8}$/);
    const filler = fc.stringMatching(/^[xyz ]{0,30}$/);
    fc.assert(
      fc.property(filler, value, filler, (before, leak, after) => {
        const leaks = findPiiValueExposure(`${before}${leak}${after}`, [leak]);
        expect(leaks).toEqual([{ value: leak }]);
      }),
    );
  });

  it("stays silent on body text built from a disjoint alphabet", () => {
    const body = fc.stringMatching(/^[xyz ]{0,60}$/);
    fc.assert(
      fc.property(body, (text) => {
        expect(findPiiValueExposure(text, ["ppp", "qqq"])).toEqual([]);
      }),
    );
  });
});
