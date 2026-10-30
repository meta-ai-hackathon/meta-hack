import glossaryJson from "../../kb/glossary.json";

import { isIsoCalendarDate } from "./kb";

// Plain-language glossary (BN-30): benefits terms explained from official
// sources. The assistant's prompt grounding and the match card both consume
// this module, so every definition carries an official https source URL and
// a retrieval date the UI can surface. The data is pilot-agnostic by
// construction: generic benefits vocabulary only, no program names (the KB
// blocklist scan covers this file's data too, since it lives under kb/).

export interface GlossarySource {
  readonly title: string;
  /** Official source URL, https only. */
  readonly url: string;
  /** YYYY-MM-DD date the definition was retrieved from the source. */
  readonly retrievedAt: string;
}

export interface GlossaryTerm {
  /** Snake_case identifier (mirrors the question spec's optional terms ids). */
  readonly id: string;
  /** The term as shown to a person. */
  readonly term: string;
  /** Plain-language definition, non-promissory. */
  readonly definition: string;
  readonly source: GlossarySource;
}

export class GlossaryValidationError extends Error {
  constructor(problems: readonly string[]) {
    super(
      `Glossary data failed validation (BN-30): ${problems.join("; ")}`,
    );
    this.name = "GlossaryValidationError";
  }
}

const TERM_ID_RE = /^[a-z][a-z0-9_]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and build one glossary term. Exported for tests and future
 * loaders; the shipped dataset runs through this at module load. The
 * retrieval-date check is the sibling kb.ts loader's REAL-calendar check
 * (isIsoCalendarDate), not just the YYYY-MM-DD shape — an impossible date
 * like 2026-02-30 must fail fast, not surface in card copy (droid-review
 * P3 on PR #45).
 */
export function parseGlossaryTerm(raw: unknown): GlossaryTerm {
  const problems: string[] = [];
  if (!isPlainObject(raw)) {
    throw new GlossaryValidationError(["each glossary term must be an object"]);
  }
  if (typeof raw.id !== "string" || !TERM_ID_RE.test(raw.id)) {
    problems.push("id must be a snake_case identifier");
  }
  if (typeof raw.term !== "string" || raw.term.trim() === "") {
    problems.push("term must be a non-empty string");
  }
  if (typeof raw.definition !== "string" || raw.definition.trim() === "") {
    problems.push("definition must be a non-empty string");
  }
  const source = raw.source;
  if (!isPlainObject(source)) {
    problems.push("source must be an object with title, url, and retrieved_at");
  } else {
    if (typeof source.title !== "string" || source.title.trim() === "") {
      problems.push("source.title must be a non-empty string");
    }
    if (typeof source.url !== "string" || !source.url.startsWith("https://")) {
      problems.push("source.url must be an official https:// URL");
    }
    if (
      typeof source.retrieved_at !== "string" ||
      !isIsoCalendarDate(source.retrieved_at)
    ) {
      problems.push(
        "source.retrieved_at must be a real YYYY-MM-DD retrieval date",
      );
    }
  }
  if (problems.length > 0) {
    throw new GlossaryValidationError(problems);
  }
  const sourceRecord = source as Record<string, unknown>;
  return {
    id: raw.id as string,
    term: raw.term as string,
    definition: raw.definition as string,
    source: {
      title: sourceRecord.title as string,
      url: sourceRecord.url as string,
      retrievedAt: sourceRecord.retrieved_at as string,
    },
  };
}

/**
 * The shipped glossary, validated at module load: invalid data fails fast
 * instead of leaking an unsourced definition into copy.
 */
export const GLOSSARY_TERMS: readonly GlossaryTerm[] = (
  glossaryJson as { terms: readonly unknown[] }
).terms.map(parseGlossaryTerm);

const TERM_BY_ID: Readonly<Record<string, GlossaryTerm>> = Object.fromEntries(
  GLOSSARY_TERMS.map((term) => [term.id, term]),
);

/** Look one term up by id (the question spec's `terms` ids resolve here). */
export function glossaryTermById(id: string): GlossaryTerm | undefined {
  return TERM_BY_ID[id];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The glossary terms whose full term phrase appears in the given text, in
 * dataset order, deduplicated. Word-boundary matched and case-insensitive:
 * this is how card copy names the jargon it uses, so the card can explain
 * each term in plain language right where it appears (BN-30).
 */
export function glossaryTermsForText(text: string): readonly GlossaryTerm[] {
  const found: GlossaryTerm[] = [];
  for (const term of GLOSSARY_TERMS) {
    const pattern = new RegExp(`\\b${escapeRegExp(term.term)}\\b`, "i");
    if (pattern.test(text)) {
      found.push(term);
    }
  }
  return found;
}
