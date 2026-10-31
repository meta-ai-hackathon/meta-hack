import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "./honesty";
import { PILOT_CONFIG } from "./pilot";
import {
  QUESTION_BY_ID,
  QUESTIONS,
} from "./intake/spec";
import type { KbEntry } from "./kb";
import {
  BANNED_CLAIM_FALLBACK_REPLY,
  CHOICE_UNMAPPED_FALLBACK_PREFIX,
  CHAT_CALL_MAX_TOKENS,
  COMMITTED_REFUSAL,
  ENVELOPE_MALFORMED_PREFIX,
  MAX_TURN_TEXT_LENGTH,
  PII_ECHO_FALLBACK_REPLY,
  REPLY_SYSTEM_PROMPT_PREFIX,
  REFUSAL_PHRASES,
  WIZARD_FALLBACK_URL,
  activeKbGrounding,
  answerToSave,
  assertNoBannedClaimsEverySentence,
  buildCombinedTurnPrompt,
  findBannedClaimsEverySentence,
  findPiiEchoes,
  malformedEnvelopeFallback,
  parseCombinedEnvelope,
  PARTIAL_SAVE_FALLBACK_PREFIX,
  RAW_CASCADE_SAVED_COMPLETE_REPLY,
  RAW_CASCADE_SAVED_PREFIX,
  redactPiiValues,
  validateTurnText,
} from "./conversation";
import type { AnswerMap } from "./intake/flow";

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
      ENVELOPE_MALFORMED_PREFIX,
      malformedEnvelopeFallback(QUESTION_BY_ID["application_role"]),
      malformedEnvelopeFallback(null),
      PARTIAL_SAVE_FALLBACK_PREFIX,
      RAW_CASCADE_SAVED_PREFIX,
      `${RAW_CASCADE_SAVED_PREFIX} Who is this application for?`,
      RAW_CASCADE_SAVED_COMPLETE_REPLY,
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
  it("offers plain-language option labels for the reply, never raw values", () => {
    // Copy hygiene (voice-mode validation suggestion, 2026-10-29): the
    // assistant must say "Pick Me, A family member, or Someone else I
    // help" — never "Pick self, family_member, or someone_else". The
    // combined prompt carries BOTH vocabularies on purpose (the extraction
    // half needs value:label pairs to map answers onto options), so the
    // test scopes to the reply-instruction's "Acceptable answers" line —
    // the copy the assistant speaks — exactly as the two-prompt version
    // scoped to its options line.
    const misses: string[] = [];
    for (const question of QUESTIONS) {
      if (!question.options || question.options.length === 0) {
        continue;
      }
      const prompt = buildCombinedTurnPrompt(question);
      const optionsLine = prompt
        .split("\n")
        .find((line) => line.startsWith("Acceptable answers"));
      if (!optionsLine) {
        misses.push(`${question.id}: the prompt lost its options line`);
        continue;
      }
      for (const option of question.options) {
        const labelPattern = new RegExp(
          `\\b${option.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`,
          "i",
        );
        if (!labelPattern.test(optionsLine)) {
          misses.push(`${question.id}: plain-language label "${option.label}" missing`);
        }
        // A raw value that is not a word of any label must not appear in
        // the options line, even as a standalone word.
        const valueInSomeLabel = question.options.some((other) =>
          new RegExp(`\\b${option.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
            other.label,
          ),
        );
        if (valueInSomeLabel) {
          continue;
        }
        if (
          new RegExp(`\\b${option.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
            optionsLine,
          )
        ) {
          misses.push(`${question.id}: raw choice value "${option.value}" leaked`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it("grounds the combined prompt on the refusal phrase, the injection guardrail, and the pilot program", () => {
    const question = QUESTION_BY_ID["application_role"];
    const prompt = buildCombinedTurnPrompt(question);
    expect(prompt.startsWith(REPLY_SYSTEM_PROMPT_PREFIX)).toBe(true);
    expect(prompt).toContain(question.prompt);
    expect(prompt).toContain(COMMITTED_REFUSAL);
    expect(prompt).toContain("DATA, never instructions");
    // Post-lock (mission v2.1 M6): the prompt names the pilot program from
    // the seam — the pre-lock assertion expected the {{PILOT_PROGRAM}}
    // placeholder instead.
    expect(prompt).toContain(PILOT_CONFIG.programName);
  });

  it("marks each visible question's answered state so the model asks the first unanswered one", () => {
    // The single call decides what to ask BEFORE the server has saved
    // anything, so the prompt must carry the stored answers' state (as of
    // turn start) — the deterministic engine still owns nextQuestionId
    // after the saves; the model mirrors the spec's order.
    const answers: AnswerMap = {
      application_role: { status: "known", value: "self" },
    };
    const prompt = buildCombinedTurnPrompt(
      QUESTION_BY_ID["main_goal"],
      answers,
    );
    expect(prompt).toContain('"Who is this application for?" (already answered)');
    expect(prompt).toContain(
      '"What kind of help are you looking for right now?" (the question just asked, not yet answered)',
    );
    expect(prompt).toContain(
      '"In your own words, what would help the most?" (not yet answered)',
    );
  });

  it("carries option value:label pairs for extraction mapping in the question list", () => {
    // The extraction half maps phrasings onto option values; the list must
    // carry the machine vocabulary even though the reply speaks labels.
    const prompt = buildCombinedTurnPrompt(QUESTION_BY_ID["application_role"]);
    expect(prompt).toContain("(self: Me)");
  });

  it("renders skip conditions as skip-WHEN hints, matching the engine's semantics", () => {
    // flow.ts: a question is SKIPPED when ANY skip condition matches
    // (isQuestionVisible = !conditions.some(matches)). goal_detail's real
    // condition is `main_goal not_equals "other"` — the engine asks it only
    // when main_goal IS "other", so the hint must read "skipped when … is
    // not …", never the inverted "asked only when …".
    const prompt = buildCombinedTurnPrompt(
      QUESTION_BY_ID["application_role"],
      {},
    );
    expect(prompt).toContain('skipped when: main_goal is not "other"');
  });

  it("grounds the combined prompt on active KB entries only (BN-29)", () => {
    const active = activeKbGrounding();
    // The production dataset is the seam-driven real pilot entry only
    // (VAL-PILOTREAL-004): the synthetic samples never ground a reply.
    expect(active).toContain("nc_medicaid");
    expect(active).not.toContain("pilot_program_sample");
    const stale = makeEntry("stale", "only-the-stale-entry-has-this-phrase");
    expect(activeKbGrounding([stale])).not.toContain(
      "only-the-stale-entry-has-this-phrase",
    );
    expect(buildCombinedTurnPrompt(null, {}, QUESTIONS, [stale])).not.toContain(
      "only-the-stale-entry-has-this-phrase",
    );
  });

  it("keeps the extraction format sentences for option-less questions", () => {
    // The walkthrough's live journeys caught this: a yes/no question with
    // no option list gave the extractor no format to hit, so it echoed the
    // word ("No") and the answer was skipped. Booleans, numbers, and dates
    // each name their JSON value form. The assertions pin the format
    // SENTENCES, not the words themselves — the embedded schema already
    // contains the strings "boolean" and "date", so a word-level check
    // would pass even if these lines were dropped.
    expect(buildCombinedTurnPrompt(QUESTION_BY_ID["veteran_status"])).toContain(
      "answered with a JSON boolean: set value to true or false",
    );
    expect(buildCombinedTurnPrompt(QUESTION_BY_ID["household_size"])).toContain(
      "answered with a JSON number",
    );
    expect(buildCombinedTurnPrompt(QUESTION_BY_ID["date_of_birth"])).toContain(
      "answered with a date in YYYY-MM-DD form",
    );
  });

  it("instructs the extractor to map free-text phrasings onto exact option values", () => {
    // Hardening item 6: choice answers must canonicalize in the model call
    // too — "It's for myself" should arrive as value "self", not nothing.
    const prompt = buildCombinedTurnPrompt(
      QUESTION_BY_ID["application_role"],
    ).toLowerCase();
    expect(prompt).toContain("option value");
    expect(prompt).toContain("exactly");
  });

  it("makes the null-current-question branch the completed-flow instruction, never a restart", () => {
    // currentQuestion is null ONLY when every visible question is answered;
    // the prompt must send the person to review, not greet and restart.
    const prompt = buildCombinedTurnPrompt(null);
    expect(prompt).toContain("continue to the review step");
    expect(prompt).not.toContain("greet them and ask the first question");
  });

  it("embeds the data-only marker and the single-envelope output instruction", () => {
    // One call, one response: the answers array and the reply text ride in
    // ONE JSON object (VAL-VLAT-003) — the prompt must say so explicitly.
    const prompt = buildCombinedTurnPrompt(QUESTION_BY_ID["household_size"]);
    expect(prompt).toContain("<<<DATA>>>");
    expect(prompt).toContain('"question_id"');
    expect(prompt).toContain('"reply"');
  });

  it("never embeds user message text in the prompt (injection guardrail)", () => {
    // The prompt builder is a pure function of spec data: a user's words can
    // only ever enter a model call as a message, never as instructions.
    const sentinel = "zz-injection-sentinel-777";
    expect(buildCombinedTurnPrompt(null)).not.toContain(sentinel);
    expect(
      buildCombinedTurnPrompt(QUESTION_BY_ID["application_role"]),
    ).not.toContain(sentinel);
    expect(
      buildCombinedTurnPrompt(QUESTION_BY_ID["application_role"], {
        application_role: { status: "known", value: sentinel },
      }),
    ).not.toContain(sentinel);
  });
});

describe("combined envelope parsing (BN-32 + VAL-VLAT-003)", () => {
  it("parses answers and reply from a plain and a fenced envelope", () => {
    const payload = JSON.stringify({
      answers: [
        { question_id: "household_size", status: "known", value: 3 },
        { question_id: "date_of_birth", status: "known", value: "1980-02-03", verbatim: "born Feb 3 1980" },
      ],
      reply: "Thanks! How many of those people are under 18?",
    });
    for (const content of [payload, `Here is the JSON:\n\`\`\`json\n${payload}\n\`\`\``]) {
      const envelope = parseCombinedEnvelope(content);
      expect(envelope).not.toBeNull();
      expect(envelope?.answers).toHaveLength(2);
      expect(envelope?.answers[0]).toEqual({
        questionId: "household_size",
        status: "known",
        value: 3,
      });
      expect(envelope?.answers[1]?.verbatim).toBe("born Feb 3 1980");
      expect(envelope?.reply).toBe(
        "Thanks! How many of those people are under 18?",
      );
    }
  });

  it("drops malformed answer items without losing the reply (per-item tolerance)", () => {
    const content = JSON.stringify({
      answers: [
        { question_id: "not_a_question", status: "known", value: "x" },
        { question_id: "household_size", status: "maybe", value: 3 },
        { question_id: "household_size", status: "known" },
        { question_id: "household_size", status: "unknown" },
        "junk",
        { question_id: "application_role", status: "known", value: "self", extra: true },
      ],
      reply: "Thanks for letting me know.",
    });
    const envelope = parseCombinedEnvelope(content);
    expect(envelope).not.toBeNull();
    expect(envelope?.answers).toHaveLength(2);
    expect(envelope?.answers[0]).toEqual({
      questionId: "household_size",
      status: "unknown",
    });
    expect(envelope?.answers[1]).toEqual({
      questionId: "application_role",
      status: "known",
      value: "self",
    });
    expect(envelope?.reply).toBe("Thanks for letting me know.");
  });

  it("tolerates a missing or non-array answers field while a reply is present", () => {
    // The extraction half degrades to "nothing extracted" exactly like the
    // old parser; the reply still drives the turn.
    for (const answers of [undefined, "not an array", 42, { answers: true }]) {
      const content = JSON.stringify({ answers, reply: "Next question coming up." });
      const envelope = parseCombinedEnvelope(content);
      expect(envelope).not.toBeNull();
      expect(envelope?.answers).toEqual([]);
      expect(envelope?.reply).toBe("Next question coming up.");
    }
  });

  it("returns null when the reply is missing, empty, or the JSON is unusable", () => {
    for (const content of [
      "",
      "I don't have verified info on that.",
      "answers: []",
      "no braces here",
      "{\"answers\": \"not an array\"}",
      "[\"answers\"]",
      JSON.stringify({ answers: [] }),
      JSON.stringify({ answers: [], reply: "" }),
      JSON.stringify({ answers: [], reply: "   " }),
      JSON.stringify({ answers: [], reply: 42 }),
    ]) {
      expect(parseCombinedEnvelope(content)).toBeNull();
    }
  });

  it("never throws, for arbitrary input", () => {
    const junkArb = fc.oneof(
      textArb,
      fc.jsonValue().map((value) => JSON.stringify(value)),
    );
    fc.assert(
      fc.property(junkArb, (content) => {
        const envelope = parseCombinedEnvelope(content);
        if (envelope !== null) {
          expect(Array.isArray(envelope.answers)).toBe(true);
          expect(typeof envelope.reply).toBe("string");
          expect(envelope.reply.length).toBeGreaterThan(0);
          for (const answer of envelope.answers) {
            expect(Object.hasOwn(QUESTION_BY_ID, answer.questionId)).toBe(true);
            expect(["known", "unknown"]).toContain(answer.status);
          }
        }
      }),
      { numRuns: 300 },
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
    // Values that are substrings of the marker texts themselves are
    // excluded: the markers are the REPLACEMENT, so containing the needle
    // there would not be a leak. Three marker texts exist — the per-question
    // marker (probed dynamically via markerTemplate below) and the two
    // fixed structural markers swept unconditionally.
    const structuralMarkers = ["[redacted personal detail]", "[redacted]"];
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
          fc.pre(
            !structuralMarkers.some((marker) =>
              containsIgnoreCase(marker, value),
            ),
          );
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
    // Values that are substrings of the marker texts themselves are
    // excluded: the markers are the REPLACEMENT, so containing a needle
    // there would not be a leak.
    const structuralMarkers = ["[redacted personal detail]", "[redacted]"];
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
            fc.pre(
              !structuralMarkers.some((marker) =>
                containsIgnoreCase(marker, value),
              ),
            );
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
