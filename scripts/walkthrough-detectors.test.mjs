import fc from "fast-check";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
  findPiiEcho,
  findPiiValueExposure,
  findPiiValueLeaks,
  foldForClaimScan,
  verifyRedaction,
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
  "Once you answer the letter, you will stay covered.",
  "Your Medicaid is renewed.",
  // Third review: a promise after a negated question is still caught.
  "Won't you stay covered? Yes, you will keep your Medicaid.",
  // Third review: the present-tense boundary.
  "You are enrolled in NC Medicaid.",
  "You are still enrolled.",
  "Good news, you're covered.",
  "Your renewal went through, so you stay covered.",
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
  "Recertification is when your NC Medicaid is renewed, which happens every 6 months.",
  "Will you stay covered? Only your local DSS can say.",
  "Do you keep your Medicaid if you move? Ask your local DSS.",
  "Here is how you keep your Medicaid: answer every letter right away.",
  "Once you are enrolled, you get a Medicaid ID card.",
  "When you are covered by Medicare too, other rules apply.",
  "Unless you are covered by other insurance, keep your Medicaid letter.",
  "You told us you are enrolled in NC Medicaid.",
  // Third review: negated direct questions pass like the positive ones,
  // typed with either apostrophe.
  "Won't you stay covered if you answer the letter?",
  "Don't you keep your Medicaid if you move?",
  "Won't you be renewed automatically?",
  "Won\u2019t you stay covered if you answer the letter?",
  "Doesn\u2019t your coverage continue after you move?",
  // Third review: present-tense intake and chat wording.
  "You are enrolled in school.",
  "You are insured through your employer.",
  "You're enrolled in a training program.",
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

// ---------------------------------------------------------------------------
// v2 detectors (VAL-WALK2-002): the fixtures are committed files under
// scripts/fixtures/walkthrough/ so the exact inputs that must bite are
// reviewable artifacts, and the v2-response-shapes list (VAL-X2-003)
// enumerates every client-visible response shape with a rationale.
// ---------------------------------------------------------------------------

const FIXTURE_DIR = fileURLToPath(
  new URL("./fixtures/walkthrough", import.meta.url),
);

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

describe("assistant banned-claim detection on the committed fixtures (v2, VAL-WALK2-002)", () => {
  // The assistant-turn gate reuses findBannedClaims (same spine patterns);
  // what makes it a distinct check is the violation kind and context at the
  // turn call site (walkthrough-core.mjs) — these fixtures pin that the
  // spine's patterns bite on assistant PHRASINGS specifically.
  it("flags the committed banned-claim assistant fixture", () => {
    const fixture = loadFixture("assistant-banned-claim.json");
    expect(fixture.expect).toBe("violation");
    expect(findBannedClaims(fixture.assistantReply)).not.toEqual([]);
  });

  it("passes the committed clean assistant fixture", () => {
    const fixture = loadFixture("assistant-clean.json");
    expect(fixture.expect).toBe("clean");
    expect(findBannedClaims(fixture.assistantReply)).toEqual([]);
  });

  it("reports the matched text and pattern on an assistant turn", () => {
    const matches = findBannedClaims("You will be approved shortly.");
    expect(matches.length).toBe(1);
    expect(matches[0].matchedText.length).toBeGreaterThan(0);
    expect(matches[0].patternSource.length).toBeGreaterThan(0);
  });

  it("stays silent on an empty reply", () => {
    expect(findBannedClaims("")).toEqual([]);
  });
});

describe("pii-echo detector on any client payload (v2, VAL-WALK2-002)", () => {
  it("flags the committed pii-echo fixture and names the echoing path", () => {
    const fixture = loadFixture("pii-echo.json");
    expect(fixture.expect).toBe("violation");
    const echoes = findPiiEcho(fixture.payload, fixture.privateValues);
    expect(echoes.length).toBeGreaterThan(0);
    expect(
      echoes.some((echo) => echo.path.includes("redactedUserTranscript")),
    ).toBe(true);
    // The report names paths, never values — the value is private content.
    for (const echo of echoes) {
      expect(echo).not.toHaveProperty("value");
    }
  });

  it("passes the committed clean payload fixture", () => {
    const fixture = loadFixture("pii-echo-clean.json");
    expect(fixture.expect).toBe("clean");
    expect(findPiiEcho(fixture.payload, fixture.privateValues)).toEqual([]);
  });

  it("attributes nested and array paths exactly", () => {
    const echoes = findPiiEcho(
      { a: { b: ["jamie.watts@example.com"] } },
      ["jamie.watts@example.com"],
    );
    expect(echoes).toEqual([
      { path: "a.b[0]", reason: "private_value_in_payload" },
    ]);
  });

  it("ignores blank and non-string private values", () => {
    expect(findPiiEcho({ note: "x  jamie.watts@example.com  x" }, ["", "   ", 42, null])).toEqual([]);
  });

  it("fails closed past the depth bound — unscanned nesting is a violation, never silence", () => {
    // Build a payload nested past the default bound; the detector must
    // report the unscanned subtree instead of passing it as clean.
    let deep = { value: "potentially private" };
    for (let i = 0; i < 14; i += 1) {
      deep = { nested: deep };
    }
    const echoes = findPiiEcho(deep, ["potentially private"]);
    // The walk enters depth 12 and reports the subtree it could not
    // descend into at depth 13.
    expect(echoes).toEqual([
      { path: Array(13).fill("nested").join("."), reason: "payload_nesting_past_scan_bound" },
    ]);
    // And a shallow payload still scans clean through the same code path.
    expect(findPiiEcho({ a: { b: "plain" } }, ["potentially private"])).toEqual([]);
  });
});

describe("redaction verification (v2, VAL-WALK2-002)", () => {
  const fixture = loadFixture("redaction.json");

  it.each(fixture.cases.map((testCase) => [testCase.name, testCase]))(
    "%s",
    (_name, testCase) => {
      const leaked = verifyRedaction(
        testCase.rawUserText,
        testCase.redactedUserTranscript,
        testCase.privateValues,
      );
      if (testCase.expect === "violation") {
        expect(leaked.length).toBeGreaterThan(0);
      } else {
        expect(leaked).toEqual([]);
      }
    },
  );

  it("only fires for values the raw turn actually carried", () => {
    expect(
      verifyRedaction("no private value here", "no private value here", [
        "1990-05-14",
      ]),
    ).toEqual([]);
  });
});

describe("v2 response shapes (VAL-X2-003): honesty across every committed shape", () => {
  const shapes = loadFixture("v2-response-shapes.json");
  const privateValues = shapes.persona.privateValues;

  it("enumerates the complete shape set, each with surface and rationale", () => {
    expect(shapes.shapes.length).toBeGreaterThanOrEqual(15);
    for (const shape of shapes.shapes) {
      expect(shape.shape.length).toBeGreaterThan(0);
      expect(shape.surface.length).toBeGreaterThan(0);
      expect(shape.rationale.length).toBeGreaterThan(0);
      expect(shape.example).toBeDefined();
    }
  });

  it("carries zero banned claims and zero pii echoes in every example", () => {
    for (const shape of shapes.shapes) {
      const text = JSON.stringify(shape.example);
      expect(findBannedClaims(text)).toEqual([]);
      expect(findPiiEcho(shape.example, privateValues)).toEqual([]);
    }
  });

  it("state-bearing examples ship no value under a pii:true question", () => {
    for (const shape of shapes.shapes) {
      // Collect every `state` payload wherever it sits in the example.
      const states = [];
      const queue = [shape.example];
      while (queue.length > 0) {
        const node = queue.pop();
        if (Array.isArray(node)) {
          queue.push(...node);
          continue;
        }
        if (node === null || typeof node !== "object") {
          continue;
        }
        if (node.state !== undefined) {
          states.push(node.state);
        }
        queue.push(...Object.values(node));
      }
      for (const state of states) {
        expect(findPiiValueLeaks(state)).toEqual([]);
      }
    }
  });
});

describe("v2 detector properties (property-based)", () => {
  // findPiiEcho is a recursive payload walker — the most property-amenable
  // logic in the file: it must find ANY non-empty private value at ANY
  // depth, attribute the exact path, and stay silent on disjoint payloads.
  const leafValue = fc.stringMatching(/^[pqr]{3,8}$/);
  const filler = fc.stringMatching(/^[xyz ]{0,10}$/);
  // Disjoint from every private-value alphabet: an echo-detector that
  // scanned too broadly would fire here.
  const disjointString = fc.stringMatching(/^[abc]{0,20}$/);

  function seededPayload(depth, value) {
    if (depth === 0) {
      return { note: `keep ${value} private` };
    }
    return { nested: seededPayload(depth - 1, value) };
  }

  it("finds a private value at any nesting depth, with the exact path", () => {
    fc.assert(
      fc.property(
        filler,
        leafValue,
        filler,
        fc.integer({ min: 0, max: 12 }),
        (before, value, after, depth) => {
          const payload = seededPayload(depth, `${before}${value}${after}`);
          const echoes = findPiiEcho(payload, [value]);
          expect(echoes).toHaveLength(1);
          // The detector attributes the STRING leaf that carries the
          // value: "note" at the top, "nested" chains down to it.
          const expectedPath =
            depth === 0 ? "note" : `${Array(depth).fill("nested").join(".")}.note`;
          expect(echoes[0].path).toBe(expectedPath);
          expect(echoes[0].reason).toBe("private_value_in_payload");
        },
      ),
    );
  });

  it("finds values inside arrays of objects and attributes the index path", () => {
    fc.assert(
      fc.property(leafValue, fc.integer({ min: 0, max: 5 }), (value, index) => {
        const items = Array.from({ length: index }, () => ({ x: "aaa" }));
        items.push({ transcript: value });
        const echoes = findPiiEcho({ turns: items }, [value]);
        expect(echoes).toEqual([
          { path: `turns[${index}].transcript`, reason: "private_value_in_payload" },
        ]);
      }),
    );
  });

  it("stays silent on payloads built from a disjoint alphabet", () => {
    fc.assert(
      fc.property(disjointString, (text) => {
        expect(findPiiEcho({ note: text, list: [text, { deep: text }] }, ["ppp", "qqq"]))
          .toEqual([]);
      }),
    );
  });

  it("never reports the value itself — paths and reasons only", () => {
    fc.assert(
      fc.property(leafValue, (value) => {
        const echoes = findPiiEcho({ transcript: value }, [value]);
        const serialized = JSON.stringify(echoes);
        expect(serialized).not.toContain(value);
      }),
    );
  });

  it("verifyRedaction flags any typed private value that survives, whatever the surrounding words", () => {
    fc.assert(
      fc.property(filler, leafValue, filler, filler, (lead, value, mid, tail) => {
        const raw = `${lead} ${value} ${mid}`;
        const survivors = verifyRedaction(raw, raw, [value]);
        expect(survivors).toEqual([value]);
        // With the value replaced, the same transcript is clean.
        const redacted = raw.split(value).join("[redacted]");
        expect(verifyRedaction(raw, redacted, [value])).toEqual([]);
        expect(verifyRedaction(raw, `${raw}${tail}`, [value])).toEqual([value]);
      }),
    );
  });
});
