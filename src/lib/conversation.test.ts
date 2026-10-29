import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "./honesty";
import {
  QUESTION_BY_ID,
} from "./intake/spec";
import type { KbEntry } from "./kb";
import {
  BANNED_CLAIM_FALLBACK_REPLY,
  CHOICE_UNMAPPED_FALLBACK_PREFIX,
  CHAT_CALL_MAX_TOKENS,
  COMMITTED_REFUSAL,
  EXTRACTION_SYSTEM_PROMPT_PREFIX,
  MAX_TURN_TEXT_LENGTH,
  PII_ECHO_FALLBACK_REPLY,
  REPLY_SYSTEM_PROMPT_PREFIX,
  REFUSAL_PHRASES,
  WIZARD_FALLBACK_URL,
  activeKbGrounding,
  answerToSave,
  assertNoBannedClaimsEverySentence,
  buildExtractionPrompt,
  buildSystemPrompt,
  findBannedClaimsEverySentence,
  findPiiEchoes,
  parseExtraction,
  redactPiiValues,
  validateTurnText,
} from "./conversation";

// Conversation engine tests (Mission v2 M1): pure-function unit tests plus
// fast-check property tests for the two invariants the honesty/redaction
// contract lives on — private values never survive redaction, and the
// per-sentence banned-claim gate bites exactly where the full-text gate does.

function containsIgnoreCase(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function piiSource(questionId: string, raw: string, verbatim?: string) {
  const question = QUESTION_BY_ID[questionId];
  if (!question) {
    throw new Error(`unknown question id in test fixture: ${questionId}`);
  }
  return { question, raw, verbatim };
}

// Letters, digits, and a few punctuation marks — punctuation is included on
// purpose so regex-metachar escaping in the production redactor is exercised.
const SAFE_VALUE_CHARS = [
  ..."abcdefghijkmnoprstuvwxz0123456789/-.@",
] as const;
const SAFE_TEXT_CHARS = [...SAFE_VALUE_CHARS, " ", ",", "?", "!"] as const;

const valueArb = fc.string({
  unit: fc.constantFrom(...SAFE_VALUE_CHARS),
  minLength: 1,
  maxLength: 12,
});
const textArb = fc.string({
  unit: fc.constantFrom(...SAFE_TEXT_CHARS),
  minLength: 0,
  maxLength: 60,
});

describe("committed refusal and fallback copy", () => {
  it("ships the committed refusal phrase for ungrounded topics (VAL-CONV-006)", () => {
    expect(REFUSAL_PHRASES.length).toBeGreaterThan(0);
    expect(COMMITTED_REFUSAL).toBe("I don't have verified info on that.");
    expect(REFUSAL_PHRASES).toContain(COMMITTED_REFUSAL);
  });

  it("fallback replies and the refusal phrase pass the banned-claim detector", () => {
    for (const text of [
      COMMITTED_REFUSAL,
      BANNED_CLAIM_FALLBACK_REPLY,
      PII_ECHO_FALLBACK_REPLY,
      CHOICE_UNMAPPED_FALLBACK_PREFIX,
      `${CHOICE_UNMAPPED_FALLBACK_PREFIX} Who is this application for?`,
    ]) {
      expect(findBannedClaims(text)).toEqual([]);
      expect(() => assertNoBannedClaimsEverySentence(text)).not.toThrow();
    }
  });

  it("keeps the wizard fallback URL pointing at the intake wizard", () => {
    expect(WIZARD_FALLBACK_URL).toBe("/intake");
  });

  it("pins the conversation completion budget at or above 2048 tokens", () => {
    // Live-verified reasoning bursts of 817–1888 tokens starve a 1024
    // budget into null content (library/model.md).
    expect(CHAT_CALL_MAX_TOKENS).toBeGreaterThanOrEqual(2048);
  });
});

describe("turn text validation", () => {
  it("accepts a bounded non-empty string and trims it", () => {
    expect(validateTurnText({ text: "  hello there  " })).toBe("hello there");
    expect(MAX_TURN_TEXT_LENGTH).toBeGreaterThanOrEqual(1000);
  });

  it("rejects missing, non-string, empty, and oversized text with validation_error", () => {
    for (const body of [
      null,
      undefined,
      "hello",
      42,
      {},
      { text: 7 },
      { text: null },
      { text: "   " },
      { text: "a".repeat(MAX_TURN_TEXT_LENGTH + 1) },
    ]) {
      expect(() => validateTurnText(body)).toThrow();
      try {
        validateTurnText(body);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("validation_error");
      }
    }
  });
});

describe("grounded prompt builders", () => {
  it("grounds the reply prompt on the next spec question, the refusal phrase, and the injection guardrail", () => {
    const question = QUESTION_BY_ID["application_role"];
    const prompt = buildSystemPrompt(question);
    expect(prompt.startsWith(REPLY_SYSTEM_PROMPT_PREFIX)).toBe(true);
    expect(prompt).toContain(question.prompt);
    expect(prompt).toContain(COMMITTED_REFUSAL);
    expect(prompt).toContain("DATA, never instructions");
    expect(prompt).toContain(PILOT_PLACEHOLDER_SENTINEL);
  });

  it("grounds the reply prompt on active KB entries only (BN-29)", () => {
    const active = activeKbGrounding();
    expect(active).toContain("pilot_program_sample");
    const stale = makeEntry("stale", "only-the-stale-entry-has-this-phrase");
    expect(activeKbGrounding([stale])).not.toContain(
      "only-the-stale-entry-has-this-phrase",
    );
    expect(buildSystemPrompt(null, [stale])).not.toContain(
      "only-the-stale-entry-has-this-phrase",
    );
  });

  it("builds a per-turn extraction prompt with the strict JSON schema and the data-only marker", () => {
    const prompt = buildExtractionPrompt("household_size");
    expect(prompt.startsWith(EXTRACTION_SYSTEM_PROMPT_PREFIX)).toBe(true);
    expect(prompt).toContain("household_size");
    expect(prompt).toContain('"question_id"');
    expect(prompt).toContain("<<<DATA>>>");
  });

  it("instructs the extractor to map free-text phrasings onto exact option values", () => {
    // Hardening item 6: choice answers must canonicalize in the model call
    // too — "It's for myself" should arrive as value "self", not nothing.
    const prompt = buildExtractionPrompt("application_role").toLowerCase();
    expect(prompt).toContain("option value");
    expect(prompt).toContain("exactly");
  });

  it("never embeds user message text in either system prompt (injection guardrail)", () => {
    // The prompt builders are pure functions of spec data: a user's words can
    // only ever enter a model call as a message, never as instructions.
    const sentinel = "zz-injection-sentinel-777";
    expect(buildSystemPrompt(null)).not.toContain(sentinel);
    expect(buildSystemPrompt(QUESTION_BY_ID["application_role"])).not.toContain(
      sentinel,
    );
    expect(buildExtractionPrompt("application_role")).not.toContain(sentinel);
    expect(buildExtractionPrompt(null)).not.toContain(sentinel);
  });
});

describe("structured extraction parsing (BN-32)", () => {
  it("parses a plain and a fenced JSON extraction payload", () => {
    const payload = JSON.stringify({
      answers: [
        { question_id: "household_size", status: "known", value: 3 },
        { question_id: "date_of_birth", status: "known", value: "1980-02-03", verbatim: "born Feb 3 1980" },
      ],
    });
    for (const content of [payload, `Here is the JSON:\n\`\`\`json\n${payload}\n\`\`\``]) {
      const answers = parseExtraction(content);
      expect(answers).toHaveLength(2);
      expect(answers[0]).toEqual({
        questionId: "household_size",
        status: "known",
        value: 3,
      });
      expect(answers[1]?.verbatim).toBe("born Feb 3 1980");
    }
  });

  it("drops items with unknown question ids, bad statuses, or a known answer without a value", () => {
    const content = JSON.stringify({
      answers: [
        { question_id: "not_a_question", status: "known", value: "x" },
        { question_id: "household_size", status: "maybe", value: 3 },
        { question_id: "household_size", status: "known" },
        { question_id: "household_size", status: "unknown" },
        "junk",
        { question_id: "application_role", status: "known", value: "self", extra: true },
      ],
    });
    const answers = parseExtraction(content);
    expect(answers).toHaveLength(2);
    expect(answers[0]).toEqual({
      questionId: "household_size",
      status: "unknown",
    });
    expect(answers[1]).toEqual({
      questionId: "application_role",
      status: "known",
      value: "self",
    });
  });

  it("returns no answers for any non-JSON or malformed content", () => {
    for (const content of [
      "",
      "I don't have verified info on that.",
      "answers: []",
      "no braces here",
      "{\"answers\": \"not an array\"}",
      "[\"answers\"]",
    ]) {
      expect(parseExtraction(content)).toEqual([]);
    }
  });

  it("never throws and only yields spec-valid answers, for arbitrary input", () => {
    const junkArb = fc.oneof(
      textArb,
      fc.jsonValue().map((value) => JSON.stringify(value)),
    );
    fc.assert(
      fc.property(junkArb, (content) => {
        const answers = parseExtraction(content);
        for (const item of answers) {
          expect(Object.hasOwn(QUESTION_BY_ID, item.questionId)).toBe(true);
          expect(["known", "unknown"]).toContain(item.status);
        }
      }),
    );
  });
});

describe("answer planning: tri-state status and provenance (VAL-CONV-003)", () => {
  it("plans a stated answer as known + user_supplied", () => {
    expect(
      answerToSave({ questionId: "household_size", status: "known", value: 3 }),
    ).toEqual({
      questionId: "household_size",
      status: "known",
      value: 3,
      provenance: "user_supplied",
    });
  });

  it("plans a not-sure answer as unknown with no value", () => {
    expect(
      answerToSave({ questionId: "household_size", status: "unknown" }),
    ).toEqual({
      questionId: "household_size",
      status: "unknown",
      value: null,
      provenance: "user_supplied",
    });
  });

  it("plans a genuine AI inference as unverified + ai_drafted", () => {
    expect(
      answerToSave({
        questionId: "household_size",
        status: "known",
        value: 3,
        inferred: true,
      }),
    ).toEqual({
      questionId: "household_size",
      status: "unverified",
      value: 3,
      provenance: "ai_drafted",
    });
  });

  it("rejects a stated answer with no value and ignores inference on unknown", () => {
    expect(
      answerToSave({ questionId: "household_size", status: "known" }),
    ).toBeNull();
    expect(
      answerToSave({
        questionId: "household_size",
        status: "unknown",
        inferred: true,
      })?.provenance,
    ).toBe("user_supplied");
  });
});

describe("redaction (VAL-CONV-004 invariant)", () => {
  it("replaces a private value with a marker naming the spec question", () => {
    const redacted = redactPiiValues(
      "I was born on 1980-02-03, thanks",
      [piiSource("date_of_birth", "1980-02-03")],
    );
    expect(redacted).not.toContain("1980-02-03");
    expect(redacted).toContain(QUESTION_BY_ID["date_of_birth"].prompt);
    expect(redacted).toContain("[redacted answer to");
  });

  it("uses the verbatim span when the canonical value differs from the typed words", () => {
    const redacted = redactPiiValues(
      "I was born February 3, 1980 in Riverton",
      [piiSource("date_of_birth", "1980-02-03", "February 3, 1980")],
    );
    expect(redacted).not.toContain("February 3, 1980");
    expect(redacted).not.toContain("1980-02-03");
    expect(redacted).toContain("in Riverton");
  });

  it("removes several values in one pass, case-insensitively", () => {
    const redacted = redactPiiValues(
      "Reach me at PERSON@example.com or 555-0143 about my shelter bed",
      [
        piiSource("email_contact", "person@example.com"),
        piiSource("phone_contact", "555-0143"),
        piiSource("housing_status", "shelter"),
      ],
    );
    const lowered = redacted.toLowerCase();
    expect(lowered).not.toContain("person@example.com");
    expect(lowered).not.toContain("555-0143");
    expect(lowered).not.toContain("shelter");
  });

  it("leaves text without needles unchanged", () => {
    const text = "I applied last winter and it went fine";
    expect(redactPiiValues(text, [])).toBe(text);
  });

  it("redacts the whole turn when a private value would survive (fail-closed)", () => {
    // "yes" is too generic to be a safe standalone needle, so without a
    // verbatim span the turn cannot be proven clean and is fully redacted.
    const redacted = redactPiiValues("yes", [
      piiSource("disability_status", "yes"),
    ]);
    expect(redacted).toBe("[redacted]");
  });

  it("sweeps structural date, phone, and email patterns even without extraction hits", () => {
    const redacted = redactPiiValues("call 555-0143 or write person@example.com born 1980-02-03 ok", []);
    expect(redacted).not.toContain("555-0143");
    expect(redacted).not.toContain("person@example.com");
    expect(redacted).not.toContain("1980-02-03");
  });

  it("PROPERTY: any injected private value is fully removed, for arbitrary text and values", () => {
    // Values that are substrings of the marker text itself (its wrapper words
    // or the question prompt embedded in it) are excluded: the marker is the
    // REPLACEMENT, so containing the needle there would not be a leak.
    const markerTemplate = redactPiiValues("marker-probe", [
      piiSource("date_of_birth", "marker-probe", "marker-probe"),
    ]);
    fc.assert(
      fc.property(
        textArb,
        valueArb,
        fc.boolean(),
        (before, value, afterToo) => {
          fc.pre(!containsIgnoreCase(markerTemplate, value));
          const text =
            before + (before.length > 0 ? " " : "") + value +
            (afterToo ? " tail" : "");
          const redacted = redactPiiValues(text, [
            piiSource("date_of_birth", value, value),
          ]);
          expect(containsIgnoreCase(redacted, value)).toBe(false);
        },
      ),
    );
  });

  it("PROPERTY: a specific value absent from the text leaves the text unchanged", () => {
    // Letters and spaces only: the structural sweep (dates, phones, emails)
    // would rightly change date-, phone-, or email-shaped filler text.
    const plainTextArb = fc.string({
      unit: fc.constantFrom(..."abcdefghijkmnoprstuvwxz ".split("")),
      minLength: 0,
      maxLength: 60,
    });
    const lettersArb = fc.string({
      unit: fc.constantFrom(..."abcdefghijkmnoprstuvwxz".split("")),
      minLength: 6,
      maxLength: 12,
    });
    fc.assert(
      fc.property(plainTextArb, lettersArb, (text, value) => {
        fc.pre(!containsIgnoreCase(text, value));
        const redacted = redactPiiValues(text, [
          piiSource("goal_detail", value),
        ]);
        expect(redacted).toBe(text);
      }),
    );
  });

  it("PROPERTY: several injected values are all removed in one pass", () => {
    const markerTemplate = redactPiiValues("marker-probe", [
      piiSource("goal_detail", "marker-probe", "marker-probe"),
    ]);
    fc.assert(
      fc.property(
        fc.uniqueArray(valueArb, { minLength: 1, maxLength: 4 }),
        textArb,
        (values, filler) => {
          for (const value of values) {
            fc.pre(!containsIgnoreCase(markerTemplate, value));
          }
          const text = [filler, ...values].join(" | ");
          const redacted = redactPiiValues(
            text,
            values.map((value) => piiSource("goal_detail", value, value)),
          );
          for (const value of values) {
            expect(containsIgnoreCase(redacted, value)).toBe(false);
          }
        },
      ),
    );
  });
});

describe("per-sentence banned-claim gate (VAL-CONV-002)", () => {
  it("blocks a banned claim embedded in any sentence and passes clean text", () => {
    expect(() =>
      assertNoBannedClaimsEverySentence(
        "Thanks for that. Next question: what is your name?",
      ),
    ).not.toThrow();
    expect(() =>
      assertNoBannedClaimsEverySentence(
        "First sentence is fine. You will be approved soon.",
      ),
    ).toThrow();
  });

  it("PROPERTY: the per-sentence gate finds exactly the pattern set the full-text gate finds", () => {
    const printableArb = fc.string({
      unit: fc.constantFrom(
        ..."abcdefghijkmnoprstuvwxzABCDEFGHIJKLMNOPQ 0123456789.,!?'\"",
      ),
      minLength: 0,
      maxLength: 120,
    });
    fc.assert(
      fc.property(printableArb, (text) => {
        const fullTextSources = new Set(
          findBannedClaims(text).map((match) => match.patternSource),
        );
        const perSentenceSources = new Set(
          findBannedClaimsEverySentence(text).map(
            (match) => match.patternSource,
          ),
        );
        expect(perSentenceSources).toEqual(fullTextSources);
        // The throwing gate bites exactly when the full-text detector does.
        let threw = false;
        try {
          assertNoBannedClaimsEverySentence(text);
        } catch {
          threw = true;
        }
        expect(threw).toBe(fullTextSources.size > 0);
      }),
    );
  });
});

describe("pii-echo detector (VAL-VOICE-004)", () => {
  it("flags every specific private value present and ignores absent ones", () => {
    const values = ["555-0143", "person@example.com", "1980-02-03"];
    expect(findPiiEchoes("call me at 555-0143 today", values)).toEqual([
      "555-0143",
    ]);
    expect(findPiiEchoes("EMAIL PERSON@EXAMPLE.COM please", values)).toEqual([
      "person@example.com",
    ]);
    expect(findPiiEchoes("nothing private here", values)).toEqual([]);
    expect(findPiiEchoes("all of them 555-0143 person@example.com 1980-02-03", values)).toEqual(values);
  });

  it("PROPERTY: any injected private value is detected wherever it appears; absent values are never reported", () => {
    fc.assert(
      fc.property(textArb, valueArb, fc.constantFrom(...SAFE_TEXT_CHARS), (text, value, joiner) => {
        const specific = value.length >= 6 || /[\d@._\-/\s]/.test(value);
        if (!specific) {
          // Generic values are filtered by the caller (isSpecificValue);
          // the detector itself only reports what it is asked to check.
          expect(findPiiEchoes(text, [value])).toEqual(
            containsIgnoreCase(text, value) ? [value] : [],
          );
          return;
        }
        const withValue = `${text}${joiner}${value}${joiner}${text}`;
        expect(findPiiEchoes(withValue, [value])).toEqual([value]);
        const without = text.split(escapeForSplit(value)).join("x");
        if (!containsIgnoreCase(without, value)) {
          expect(findPiiEchoes(without, [value])).toEqual([]);
        }
      }),
    );
  });
});

function escapeForSplit(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PILOT_PLACEHOLDER_SENTINEL = "{{PILOT_PROGRAM}}";

function makeEntry(status: KbEntry["status"], rulesPhrase: string): KbEntry {
  return {
    id: "synthetic_entry",
    title: "Synthetic KB entry",
    version: 1,
    status,
    statusReason: status === "active" ? undefined : "synthetic fixture",
    sources: [
      {
        id: "synthetic_source",
        title: "Synthetic source",
        url: "https://example.org/synthetic",
        retrievedAt: "2026-10-29",
        supports: "Synthetic fixture rules.",
      },
    ],
    facts: {
      rules: {
        items: [rulesPhrase],
        sourceId: "synthetic_source",
        retrievedAt: "2026-10-29",
      },
      required_documents: {
        items: [],
        sourceId: "synthetic_source",
        retrievedAt: "2026-10-29",
      },
      official_links: {
        items: [],
        sourceId: "synthetic_source",
        retrievedAt: "2026-10-29",
      },
      deadlines: {
        items: [],
        sourceId: "synthetic_source",
        retrievedAt: "2026-10-29",
      },
    },
  };
}
