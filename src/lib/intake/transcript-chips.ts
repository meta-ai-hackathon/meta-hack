// HACK-158 (VAL-UX-005): the server's redaction (src/lib/conversation.ts)
// replaces private answers in a user turn with bracket markers BEFORE the
// turn is stored or delivered — the question-answer tag
// `[redacted answer to "<prompt>"]`, the structural sweep's
// `[redacted personal detail]`, and the fail-closed whole-turn
// `[redacted]`. The transcript renders those markers as the same small
// "You told us" chip the answers list uses (AnswerStatusBadge,
// status "known"), never as raw bracket text. Display only: what is
// stored and sent is unchanged (redaction expansion is HACK-103, out of
// scope). Pure string logic — no storage, no network, no model access,
// browser-safe (the talk-path.ts client-safe precedent).

/**
 * One display piece of a redacted transcript: the words the person typed
 * (kind "text"), or a redaction marker the chip stands in for (kind
 * "redacted"). The marker's own text is deliberately dropped — the chip
 * speaks for it.
 */
export type TranscriptSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "redacted" };

/**
 * The marker pattern, mirroring the redactor's own fail-closed sweep in
 * src/lib/conversation.ts (the same `/\[redacted[^\]]*\]/g` there): any
 * bracketed marker that starts with "redacted". Spec prompts carry no
 * brackets, so every server-built marker closes cleanly and none of the
 * person's bracketed words begin with "redacted".
 */
const REDACTION_MARKER_PATTERN = /\[redacted[^\]]*\]/g;

/**
 * Split a redacted transcript into display segments in order: text
 * between markers stays verbatim (typed names and free text remain
 * visible as typed), each marker becomes one "redacted" segment the
 * bubble renders as the You-told-us chip.
 */
export function splitRedactedTranscript(
  transcript: string,
): readonly TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let last = 0;
  for (const match of transcript.matchAll(REDACTION_MARKER_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) {
      segments.push({ kind: "text", text: transcript.slice(last, start) });
    }
    segments.push({ kind: "redacted" });
    last = start + match[0].length;
  }
  if (last < transcript.length) {
    segments.push({ kind: "text", text: transcript.slice(last) });
  }
  return segments;
}
