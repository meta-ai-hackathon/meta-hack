import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { redactPiiValues } from "../conversation";
import { PII_QUESTION_IDS_IN_SPEC, QUESTION_BY_ID } from "./spec";
import { splitRedactedTranscript } from "./transcript-chips";

// HACK-158 (VAL-UX-005): the server's redaction (src/lib/conversation.ts)
// replaces private values in a user turn with bracket markers BEFORE the
// turn is stored or delivered; the transcript must render those markers as
// the same small "You told us" chip the answers list uses —
// never as raw bracket text. This module is the client-safe splitter the
// chips render from; these tests pin its segmentation and its consistency
// with the markers the server actually builds (display only — what is
// stored and sent is unchanged).

function segmentsText(segments: ReturnType<typeof splitRedactedTranscript>): string {
  return segments
    .map((segment) => (segment.kind === "redacted" ? "◇" : segment.text))
    .join("");
}

describe("splitRedactedTranscript (the You-told-us chip splitter, HACK-158)", () => {
  it("splits the ticket's repro transcript into text plus one redacted segment", () => {
    const transcript =
      'North Carolina, [redacted answer to "Which county or city area do you live in?"].';
    expect(splitRedactedTranscript(transcript)).toEqual([
      { kind: "text", text: "North Carolina, " },
      { kind: "redacted" },
      { kind: "text", text: "." },
    ]);
  });

  it("passes plain text through as a single unchanged segment", () => {
    const transcript = "Hi, I'm Testy McTestface. I live in Charlotte.";
    expect(splitRedactedTranscript(transcript)).toEqual([
      { kind: "text", text: transcript },
    ]);
  });

  it("returns no segments for an empty transcript", () => {
    expect(splitRedactedTranscript("")).toEqual([]);
  });

  it("recognizes every marker shape the server builds", () => {
    // The three markers redactPiiValues can produce: the question-answer
    // tag, the structural sweep's marker, and the fail-closed whole-turn
    // marker.
    expect(splitRedactedTranscript("[redacted answer to \"What is your date of birth?\"]")).toEqual([
      { kind: "redacted" },
    ]);
    expect(splitRedactedTranscript("[redacted personal detail]")).toEqual([
      { kind: "redacted" },
    ]);
    expect(splitRedactedTranscript("[redacted]")).toEqual([
      { kind: "redacted" },
    ]);
  });

  it("handles markers at the edges, adjacent markers, and many markers", () => {
    expect(splitRedactedTranscript("[redacted] rest")).toEqual([
      { kind: "redacted" },
      { kind: "text", text: " rest" },
    ]);
    expect(splitRedactedTranscript("start [redacted]")).toEqual([
      { kind: "text", text: "start " },
      { kind: "redacted" },
    ]);
    expect(splitRedactedTranscript("[redacted][redacted]")).toEqual([
      { kind: "redacted" },
      { kind: "redacted" },
    ]);
    expect(
      splitRedactedTranscript("a [redacted] b [redacted personal detail] c"),
    ).toEqual([
      { kind: "text", text: "a " },
      { kind: "redacted" },
      { kind: "text", text: " b " },
      { kind: "redacted" },
      { kind: "text", text: " c" },
    ]);
  });

  it("PROPERTY: the segments partition the transcript exactly — nothing lost, reordered, or duplicated", () => {
    // Re-joining the segments with each redacted segment swapped for a
    // sentinel must equal the original with the same swap — the
    // segmentation covers the whole string in order, for ANY string
    // (including malformed bracket fragments, which stay text).
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (transcript) => {
        const segments = splitRedactedTranscript(transcript);
        expect(segmentsText(segments)).toBe(
          transcript.replace(/\[redacted[^\]]*\]/g, "◇"),
        );
      }),
    );
  });

  it("PROPERTY: no text segment ever carries raw marker text", () => {
    const markerArb = fc.constantFrom(
      '[redacted answer to "Which county or city area do you live in?"]',
      "[redacted personal detail]",
      "[redacted]",
    );
    const fillerArb = fc.string({
      unit: fc.constantFrom(..."abcdefghi ,.XYZ".split("")),
      minLength: 0,
      maxLength: 20,
    });
    fc.assert(
      fc.property(
        fillerArb,
        fc.array(fc.tuple(fillerArb, markerArb, fillerArb), { maxLength: 4 }),
        (lead, pairs) => {
          const transcript = lead + pairs.map(([a, m, b]) => `${a}${m}${b}`).join("");
          const segments = splitRedactedTranscript(transcript);
          for (const segment of segments) {
            if (segment.kind === "text") {
              expect(segment.text).not.toMatch(/\[redacted[^\]]*\]/);
            }
          }
          // At least the planted markers became chips.
          expect(segments.filter((s) => s.kind === "redacted").length).toBe(
            pairs.length,
          );
        },
      ),
    );
  });

  it("PROPERTY: the markers the SERVER builds from the spec's pii answers all become chips — full pii population", () => {
    // Consistency pin: for every pii:true question in the spec, a turn
    // carrying that answer redacted by the real server function splits
    // into segments where the marker is a chip and the value survives in
    // none of the text (the display recognizes exactly what storage sends).
    fc.assert(
      fc.property(
        fc.constantFrom(...PII_QUESTION_IDS_IN_SPEC),
        fc.string({
          unit: fc.constantFrom(..."abcdefghi ,.".split("")),
          minLength: 0,
          maxLength: 20,
        }),
        (questionId, filler) => {
          const question = QUESTION_BY_ID[questionId]!;
          const value = "Rivertonshade";
          const redacted = redactPiiValues(
            `${filler} ${value} ${filler}`,
            [{ question, raw: value }],
          );
          const segments = splitRedactedTranscript(redacted);
          expect(segments.some((s) => s.kind === "redacted")).toBe(true);
          for (const segment of segments) {
            if (segment.kind === "text") {
              expect(segment.text).not.toContain(value);
              expect(segment.text).not.toMatch(/\[redacted[^\]]*\]/);
            }
          }
        },
      ),
      { numRuns: PII_QUESTION_IDS_IN_SPEC.length * 4 },
    );
  });
});
