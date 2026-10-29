/**
 * Knowledge-base schema (BN-04 / HACK-29).
 *
 * The KB ships as data (kb/schema.json + kb/entries/*.json) plus this module:
 * TypeScript types, runtime validation mirroring the JSON Schema, and the
 * citation API that makes the honesty rule structural — stale or withdrawn
 * entries are never cited silently, because every citation carries the entry
 * status and non-active entries require explicit acknowledgment to cite.
 */

import sampleEntryJson from "../../kb/entries/pilot-program-sample.json";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const KB_ENTRY_STATUSES = ["active", "stale", "withdrawn"] as const;

export type KbEntryStatus = (typeof KB_ENTRY_STATUSES)[number];

/** States that must never be cited silently: status and reason always surface. */
export const NON_ACTIVE_KB_STATUSES = ["stale", "withdrawn"] as const;

export type NonActiveKbStatus = (typeof NON_ACTIVE_KB_STATUSES)[number];

export function isNonActiveKbStatus(value: unknown): value is NonActiveKbStatus {
  return (
    typeof value === "string" &&
    (NON_ACTIVE_KB_STATUSES as readonly string[]).includes(value)
  );
}

export const KB_FACT_GROUPS = [
  "rules",
  "required_documents",
  "official_links",
  "deadlines",
] as const;

export type KbFactGroupName = (typeof KB_FACT_GROUPS)[number];

// ---------------------------------------------------------------------------
// Shapes (fact-group keys mirror the JSON data vocabulary; other fields are
// camelCase module API)
// ---------------------------------------------------------------------------

export interface KbSource {
  readonly id: string;
  readonly title: string;
  /** Official source URL, https only. */
  readonly url: string;
  /** YYYY-MM-DD date the source content was retrieved or re-verified. */
  readonly retrievedAt: string;
  /** What this source supports in the entry. */
  readonly supports: string;
}

export interface KbLinkFact {
  readonly label: string;
  readonly url: string;
}

export interface KbDeadlineFact {
  readonly label: string;
  readonly due: string;
}

export interface KbFactGroup<TItem> {
  readonly items: readonly TItem[];
  /** Id of the entry source that backs every item in this group. */
  readonly sourceId: string;
  /** YYYY-MM-DD date this group's facts were retrieved from the source. */
  readonly retrievedAt: string;
}

export interface KbFacts {
  readonly rules: KbFactGroup<string>;
  readonly required_documents: KbFactGroup<string>;
  readonly official_links: KbFactGroup<KbLinkFact>;
  readonly deadlines: KbFactGroup<KbDeadlineFact>;
}

export interface KbEntry {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly status: KbEntryStatus;
  /** Why the entry is stale or withdrawn; required for non-active states. */
  readonly statusReason?: string;
  /** Entry id that replaces this one, when a replacement exists. */
  readonly supersededBy?: string;
  readonly sources: readonly KbSource[];
  readonly facts: KbFacts;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class KbValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Knowledge-base entry failed validation (BN-04/HACK-29): ` +
        `${problems.length} problem(s): ${problems.join("; ")}`,
    );
    this.name = "KbValidationError";
    this.problems = problems;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HTTPS_URL_RE = /^https:\/\//;
const ENTRY_ID_RE = /^[a-z][a-z0-9_]*$/;
const SOURCE_ID_RE = /^[a-z][a-z0-9_-]*$/;

/** Exactly the keys kb/schema.json allows on an entry (additionalProperties: false). */
const ENTRY_KEYS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "version",
  "status",
  "status_reason",
  "superseded_by",
  "sources",
  "facts",
]);

const SOURCE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "title",
  "url",
  "retrieved_at",
  "supports",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  problems: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      problems.push(`${label}.${key} is not allowed by the schema`);
    }
  }
}

/**
 * Real-calendar-date check on top of the YYYY-MM-DD shape the JSON Schema
 * can only express as a pattern (2026-02-30 matches the shape, not the
 * calendar). setUTCFullYear avoids the Date.UTC quirk that maps years
 * 0-99 onto 1900-1999, so every four-digit year validates like the schema.
 */
export function isIsoCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function validateGroupProvenance(
  group: unknown,
  name: KbFactGroupName,
  problems: string[],
  sourceIds: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!isPlainObject(group)) {
    problems.push(
      `facts.${name} must be an object with items, source_id, and retrieved_at`,
    );
    return undefined;
  }
  if (!Array.isArray(group.items) || group.items.length < 1) {
    problems.push(`facts.${name}.items must be a non-empty array`);
  }
  if (typeof group.source_id !== "string" || !SOURCE_ID_RE.test(group.source_id)) {
    problems.push(`facts.${name}.source_id must name one of the entry's sources`);
  } else if (!sourceIds.has(group.source_id)) {
    problems.push(
      `facts.${name}.source_id "${group.source_id}" does not match a listed source`,
    );
  }
  if (
    typeof group.retrieved_at !== "string" ||
    !isIsoCalendarDate(group.retrieved_at)
  ) {
    problems.push(
      `facts.${name}.retrieved_at must be a real YYYY-MM-DD retrieval date`,
    );
  }
  return group;
}

/**
 * Collect every problem with a raw entry (the same rules kb/schema.json
 * expresses, plus the cross-references and calendar semantics JSON Schema
 * cannot express). An empty list means the entry validates.
 */
export function validateKbEntry(raw: unknown): readonly string[] {
  const problems: string[] = [];
  if (!isPlainObject(raw)) {
    return ["entry must be a JSON object"];
  }
  checkUnknownKeys(raw, ENTRY_KEYS, "entry", problems);

  if (typeof raw.id !== "string" || !ENTRY_ID_RE.test(raw.id)) {
    problems.push("id must be a snake_case identifier");
  }
  if (typeof raw.title !== "string" || raw.title.length === 0) {
    problems.push("title must be a non-empty string");
  }
  if (
    typeof raw.version !== "number" ||
    !Number.isInteger(raw.version) ||
    raw.version < 1
  ) {
    problems.push("version must be an integer >= 1");
  }
  const status: unknown = raw.status;
  if (
    typeof status !== "string" ||
    !(KB_ENTRY_STATUSES as readonly string[]).includes(status)
  ) {
    problems.push("status must be one of: active, stale, withdrawn");
  }
  if (
    raw.status_reason !== undefined &&
    (typeof raw.status_reason !== "string" || raw.status_reason.length === 0)
  ) {
    problems.push("status_reason must be a non-empty string when present");
  }
  if (
    isNonActiveKbStatus(status) &&
    (typeof raw.status_reason !== "string" || raw.status_reason.length === 0)
  ) {
    problems.push(
      "status_reason is required when status is stale or withdrawn " +
        "(non-active entries may be cited only with their reason surfaced)",
    );
  }
  if (
    raw.superseded_by !== undefined &&
    (typeof raw.superseded_by !== "string" || !ENTRY_ID_RE.test(raw.superseded_by))
  ) {
    problems.push("superseded_by must be a snake_case entry id when present");
  }

  const sourceIds = new Set<string>();
  if (!Array.isArray(raw.sources) || raw.sources.length < 1) {
    problems.push("sources must be a non-empty array");
  } else {
    raw.sources.forEach((source, index) => {
      const label = `sources[${index}]`;
      if (!isPlainObject(source)) {
        problems.push(`${label} must be an object`);
        return;
      }
      checkUnknownKeys(source, SOURCE_KEYS, label, problems);
      if (typeof source.id !== "string" || !SOURCE_ID_RE.test(source.id)) {
        problems.push(`${label}.id must be a snake_case source id`);
      } else {
        sourceIds.add(source.id);
      }
      if (typeof source.title !== "string" || source.title.length === 0) {
        problems.push(`${label}.title must be a non-empty string`);
      }
      if (typeof source.url !== "string" || !HTTPS_URL_RE.test(source.url)) {
        problems.push(`${label}.url must be an official https:// URL`);
      }
      if (
        typeof source.retrieved_at !== "string" ||
        !isIsoCalendarDate(source.retrieved_at)
      ) {
        problems.push(
          `${label}.retrieved_at must be a real YYYY-MM-DD retrieval date`,
        );
      }
      if (typeof source.supports !== "string" || source.supports.length === 0) {
        problems.push(`${label}.supports must say what the source supports`);
      }
    });
  }

  const facts = raw.facts;
  if (!isPlainObject(facts)) {
    problems.push(
      "facts must be an object with the rules, required_documents, " +
        "official_links, and deadlines groups",
    );
    return problems;
  }
  for (const key of Object.keys(facts)) {
    if (!(KB_FACT_GROUPS as readonly string[]).includes(key)) {
      problems.push(`facts.${key} is not one of the four fact groups`);
    }
  }
  for (const name of KB_FACT_GROUPS) {
    const group = validateGroupProvenance(facts[name], name, problems, sourceIds);
    if (!group || !Array.isArray(group.items)) {
      continue;
    }
    if (name === "official_links") {
      for (const item of group.items) {
        if (
          !isPlainObject(item) ||
          typeof item.label !== "string" ||
          item.label.length === 0 ||
          typeof item.url !== "string" ||
          !HTTPS_URL_RE.test(item.url) ||
          Object.keys(item).some((key) => key !== "label" && key !== "url")
        ) {
          problems.push(
            "facts.official_links.items entries need a label and an official https:// url",
          );
          break;
        }
      }
    } else if (name === "deadlines") {
      for (const item of group.items) {
        if (
          !isPlainObject(item) ||
          typeof item.label !== "string" ||
          item.label.length === 0 ||
          typeof item.due !== "string" ||
          item.due.length === 0 ||
          Object.keys(item).some((key) => key !== "label" && key !== "due")
        ) {
          problems.push(
            "facts.deadlines.items entries need a label and a due statement",
          );
          break;
        }
      }
    } else {
      for (const item of group.items) {
        if (typeof item !== "string" || item.length === 0) {
          problems.push(`facts.${name}.items entries must be non-empty strings`);
          break;
        }
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function buildSource(raw: Record<string, unknown>): KbSource {
  return {
    id: raw.id as string,
    title: raw.title as string,
    url: raw.url as string,
    retrievedAt: raw.retrieved_at as string,
    supports: raw.supports as string,
  };
}

function buildEntry(raw: Record<string, unknown>): KbEntry {
  const rawSources = raw.sources as Record<string, unknown>[];
  const rawFacts = raw.facts as Record<string, Record<string, unknown>>;
  const stringGroup = (group: Record<string, unknown>): KbFactGroup<string> => ({
    items: group.items as string[],
    sourceId: group.source_id as string,
    retrievedAt: group.retrieved_at as string,
  });
  return {
    id: raw.id as string,
    title: raw.title as string,
    version: raw.version as number,
    status: raw.status as KbEntryStatus,
    statusReason: raw.status_reason as string | undefined,
    supersededBy: raw.superseded_by as string | undefined,
    sources: rawSources.map(buildSource),
    facts: {
      rules: stringGroup(rawFacts.rules),
      required_documents: stringGroup(rawFacts.required_documents),
      official_links: {
        items: (rawFacts.official_links.items as Record<string, unknown>[]).map(
          (item) => ({ label: item.label as string, url: item.url as string }),
        ),
        sourceId: rawFacts.official_links.source_id as string,
        retrievedAt: rawFacts.official_links.retrieved_at as string,
      },
      deadlines: {
        items: (rawFacts.deadlines.items as Record<string, unknown>[]).map(
          (item) => ({ label: item.label as string, due: item.due as string }),
        ),
        sourceId: rawFacts.deadlines.source_id as string,
        retrievedAt: rawFacts.deadlines.retrieved_at as string,
      },
    },
  };
}

/**
 * Parse and validate a raw entry, or throw KbValidationError listing every
 * problem. This is the only sanctioned way to turn KB JSON into a KbEntry.
 */
export function parseKbEntry(raw: unknown): KbEntry {
  const problems = validateKbEntry(raw);
  if (problems.length > 0) {
    throw new KbValidationError(problems);
  }
  return buildEntry(raw as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Citation API: the no-silent-citation rule, as a type
// ---------------------------------------------------------------------------

/**
 * What the app surfaces when it shows KB facts. `status` is a required
 * field — there is no citation a consumer could receive without the entry's
 * status in hand, and stale/withdrawn entries always carry their reason.
 */
export interface KbCitation {
  readonly entryId: string;
  readonly entryTitle: string;
  readonly entryVersion: number;
  /** Always present: the consuming API surfaces status with every fact. */
  readonly status: KbEntryStatus;
  /** Present whenever the entry carries one (required for stale/withdrawn). */
  readonly statusReason?: string;
  readonly group: KbFactGroupName;
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
  readonly items: readonly unknown[];
}

export class SilentCitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SilentCitationError";
  }
}

export interface CiteOptions {
  /**
   * Required to cite a stale or withdrawn entry. Acknowledging does not
   * hide the state — the citation still surfaces status and reason.
   */
  readonly acknowledgeNonActive?: boolean;
}

/**
 * Build the citation for one fact group. Refuses to cite a stale or
 * withdrawn entry unless the caller explicitly acknowledges the state,
 * so non-active facts can only enter the UI with their status attached.
 */
export function citeFactGroup(
  entry: KbEntry,
  group: KbFactGroupName,
  options: CiteOptions = {},
): KbCitation {
  const facts = entry.facts[group];
  const source = entry.sources.find(
    (candidate) => candidate.id === facts.sourceId,
  );
  if (!source) {
    throw new KbValidationError([
      `facts.${group}.source_id "${facts.sourceId}" does not match a listed source`,
    ]);
  }
  if (entry.status !== "active" && options.acknowledgeNonActive !== true) {
    throw new SilentCitationError(
      `entry "${entry.id}" is ${entry.status} and must never be cited silently: ` +
        "pass acknowledgeNonActive and surface the status and reason wherever " +
        "these facts appear",
    );
  }
  return {
    entryId: entry.id,
    entryTitle: entry.title,
    entryVersion: entry.version,
    status: entry.status,
    statusReason: entry.statusReason,
    group,
    sourceId: source.id,
    sourceUrl: source.url,
    retrievedAt: facts.retrievedAt,
    items: facts.items,
  };
}

// ---------------------------------------------------------------------------
// The shipped dataset
// ---------------------------------------------------------------------------

/**
 * The shipped knowledge base: one pilot-agnostic sample entry until the
 * pilot decision lands. Every entry is validated at module load, so invalid
 * KB data fails fast instead of leaking unverified facts.
 */
export const KB_ENTRIES: readonly KbEntry[] = [
  parseKbEntry(sampleEntryJson as unknown),
];
