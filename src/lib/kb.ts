/**
 * Knowledge-base schema (BN-04 / HACK-29).
 *
 * The KB ships as data (kb/schema.json + kb/entries/*.json) plus this module:
 * TypeScript types, runtime validation mirroring the JSON Schema, and the
 * citation API that makes the honesty rule structural — stale or withdrawn
 * entries are never cited silently, because every citation carries the entry
 * status and non-active entries require explicit acknowledgment to cite.
 */

import sampleBEntryJson from "../../kb/entries/pilot-program-sample-b.json";
import sampleCEntryJson from "../../kb/entries/pilot-program-sample-c.json";
import realEntryJson from "../../kb/entries/nc-medicaid.json";
import sampleEntryJson from "../../kb/entries/pilot-program-sample.json";
import { PILOT_CONFIG } from "./pilot";

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

/**
 * Fact groups an entry MAY carry (mission v2 M3): `steps` feeds the
 * requirements checklist (BN-15) and `match_signals` feeds deterministic
 * scoring. Both validate with the same per-group provenance as the
 * required groups when present.
 */
export const OPTIONAL_KB_FACT_GROUPS = ["steps", "match_signals"] as const;

export type OptionalKbFactGroupName = (typeof OPTIONAL_KB_FACT_GROUPS)[number];

export const ALL_KB_FACT_GROUPS: readonly (KbFactGroupName | OptionalKbFactGroupName)[] =
  [...KB_FACT_GROUPS, ...OPTIONAL_KB_FACT_GROUPS];

/**
 * Handoff groups an entry MAY carry (BN-24 and BN-26, HACK-46 and
 * HACK-47): `submission_steps` lists, in order, what a person does with a
 * filled form to sign it and send it in themselves, and `after_you_apply`
 * says what the sources say happens after it is sent. Every item names its
 * own source, so these groups are cited one step at a time with
 * citeSourcedSteps, never with citeFactGroup. They feed only the handoff,
 * so ALL_KB_FACT_GROUPS, which the match card reads, leaves them out.
 */
export const SOURCED_STEP_KB_FACT_GROUPS = [
  "submission_steps",
  "after_you_apply",
] as const;

export type SourcedStepKbFactGroupName =
  (typeof SOURCED_STEP_KB_FACT_GROUPS)[number];

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

/**
 * One step in a handoff group (BN-24 and BN-26): what to do, or what to
 * expect, backed by its own source rather than the group's.
 */
export interface KbSourcedStep {
  /** Snake_case id, unique within its group. */
  readonly id: string;
  /** The step in a few words. */
  readonly label: string;
  /** What the step's source says, in plain language. */
  readonly detail: string;
  /** Official deep link for the step, when it has one. */
  readonly link?: KbLinkFact;
  /** Id of the entry source that backs this step. */
  readonly sourceId: string;
}

/** A handoff group: ordered steps, each carrying its own source. */
export interface KbSourcedStepGroup {
  readonly items: readonly KbSourcedStep[];
  /**
   * Id of the form-registry entry these steps are written for, when they
   * name that form's pages or steps. Omitted: they fit any form.
   */
  readonly formId?: string;
  /**
   * YYYY-MM-DD date the list was last checked against its sources. Each
   * step's citation carries its own source's retrieval date instead.
   */
  readonly retrievedAt: string;
}

/** One match signal: what this entry's rules consider about a person. */
export interface KbSignalFact {
  /** Id of a question in the generic question spec this signal evaluates. */
  readonly questionId: string;
  /** Option values the signal matches on; omitted = any known answer. */
  readonly values?: readonly string[];
  /** Score contribution when matched (default 1, bounded 1-9 by the schema). */
  readonly weight?: number;
  /** Program-side reason the card shows when the signal matches. */
  readonly reason: string;
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
  /** Optional: ordered steps for sending a filled form in (BN-24). */
  readonly submission_steps?: KbSourcedStepGroup;
  /** Optional: what the sources say happens after it is sent (BN-26). */
  readonly after_you_apply?: KbSourcedStepGroup;
  /** Optional: application steps for the requirements checklist (BN-15). */
  readonly steps?: KbFactGroup<string>;
  /** Optional: deterministic match-scoring signals over the question spec. */
  readonly match_signals?: KbFactGroup<KbSignalFact>;
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

/** Exactly the keys kb/schema.json allows on one match_signal item. */
const SIGNAL_KEYS: ReadonlySet<string> = new Set([
  "question_id",
  "values",
  "weight",
  "reason",
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
  name: KbFactGroupName | OptionalKbFactGroupName,
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

/** Exactly the keys kb/schema.json allows on a handoff group. */
const SOURCED_STEP_GROUP_KEYS: ReadonlySet<string> = new Set([
  "items",
  "form_id",
  "retrieved_at",
]);

/** The form-registry id shape (kb/forms/schema.json). */
const FORM_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Exactly the keys kb/schema.json allows on one handoff step. */
const SOURCED_STEP_KEYS: ReadonlySet<string> = new Set([
  "id",
  "label",
  "detail",
  "link",
  "source_id",
]);

/** Exactly the keys kb/schema.json allows on a handoff step's link. */
const STEP_LINK_KEYS: ReadonlySet<string> = new Set(["label", "url"]);

/**
 * A handoff group (BN-24 and BN-26): the schema's shape plus what JSON
 * Schema cannot express. Step ids are unique within the group, and every
 * step's own source_id names one of the entry's sources, so a step can
 * never render without the page that backs it.
 */
function validateSourcedStepGroup(
  group: unknown,
  name: SourcedStepKbFactGroupName,
  problems: string[],
  sourceIds: ReadonlySet<string>,
): void {
  if (!isPlainObject(group)) {
    problems.push(`facts.${name} must be an object with items and retrieved_at`);
    return;
  }
  checkUnknownKeys(group, SOURCED_STEP_GROUP_KEYS, `facts.${name}`, problems);
  if (
    group.form_id !== undefined &&
    (typeof group.form_id !== "string" || !FORM_ID_RE.test(group.form_id))
  ) {
    problems.push(`facts.${name}.form_id must be a form-registry id when present`);
  }
  if (
    typeof group.retrieved_at !== "string" ||
    !isIsoCalendarDate(group.retrieved_at)
  ) {
    problems.push(
      `facts.${name}.retrieved_at must be a real YYYY-MM-DD retrieval date`,
    );
  }
  if (!Array.isArray(group.items) || group.items.length < 1) {
    problems.push(`facts.${name}.items must be a non-empty array`);
    return;
  }
  const seenIds = new Set<string>();
  group.items.forEach((item: unknown, index) => {
    const label = `facts.${name}.items[${index}]`;
    if (!isPlainObject(item)) {
      problems.push(`${label} must be an object`);
      return;
    }
    checkUnknownKeys(item, SOURCED_STEP_KEYS, label, problems);
    if (typeof item.id !== "string" || !ENTRY_ID_RE.test(item.id)) {
      problems.push(`${label}.id must be a snake_case step id`);
    } else if (seenIds.has(item.id)) {
      problems.push(`${label}.id "${item.id}" repeats an earlier step id`);
    } else {
      seenIds.add(item.id);
    }
    if (typeof item.label !== "string" || item.label.length === 0) {
      problems.push(`${label}.label must be a non-empty string`);
    }
    if (typeof item.detail !== "string" || item.detail.length === 0) {
      problems.push(`${label}.detail must be a non-empty string`);
    }
    if (item.link !== undefined) {
      const link = item.link;
      if (!isPlainObject(link)) {
        problems.push(`${label}.link must be an object with a label and a url`);
      } else {
        checkUnknownKeys(link, STEP_LINK_KEYS, `${label}.link`, problems);
        if (typeof link.label !== "string" || link.label.length === 0) {
          problems.push(`${label}.link.label must be a non-empty string`);
        }
        if (typeof link.url !== "string" || !HTTPS_URL_RE.test(link.url)) {
          problems.push(`${label}.link.url must be an official https:// URL`);
        }
      }
    }
    if (typeof item.source_id !== "string" || !SOURCE_ID_RE.test(item.source_id)) {
      problems.push(`${label}.source_id must name one of the entry's sources`);
    } else if (!sourceIds.has(item.source_id)) {
      problems.push(
        `${label}.source_id "${item.source_id}" does not match a listed source`,
      );
    }
  });
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
  const allowedGroups: readonly string[] = [
    ...ALL_KB_FACT_GROUPS,
    ...SOURCED_STEP_KB_FACT_GROUPS,
  ];
  for (const key of Object.keys(facts)) {
    if (!allowedGroups.includes(key)) {
      problems.push(
        `facts.${key} is not one of the allowed fact groups (${allowedGroups.join(", ")})`,
      );
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
  for (const name of OPTIONAL_KB_FACT_GROUPS) {
    // Optional groups validate with identical provenance rules when present.
    if (facts[name] === undefined) {
      continue;
    }
    const group = validateGroupProvenance(facts[name], name, problems, sourceIds);
    if (!group || !Array.isArray(group.items)) {
      continue;
    }
    if (name === "match_signals") {
      for (let index = 0; index < group.items.length; index += 1) {
        const item = group.items[index];
        const label = `facts.match_signals.items[${index}]`;
        if (!isPlainObject(item)) {
          problems.push(`${label} must be an object`);
          continue;
        }
        checkUnknownKeys(item, SIGNAL_KEYS, label, problems);
        if (
          typeof item.question_id !== "string" ||
          !ENTRY_ID_RE.test(item.question_id)
        ) {
          problems.push(`${label}.question_id must be a snake_case question id`);
        }
        if (typeof item.reason !== "string" || item.reason.length === 0) {
          problems.push(`${label}.reason must be a non-empty string`);
        }
        if (
          item.values !== undefined &&
          (!Array.isArray(item.values) ||
            item.values.length < 1 ||
            item.values.some((value) => typeof value !== "string" || value.length === 0))
        ) {
          problems.push(`${label}.values must be a non-empty list of strings`);
        }
        if (
          item.weight !== undefined &&
          (typeof item.weight !== "number" ||
            !Number.isInteger(item.weight) ||
            item.weight < 1 ||
            item.weight > 9)
        ) {
          problems.push(`${label}.weight must be an integer from 1 to 9`);
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
  for (const name of SOURCED_STEP_KB_FACT_GROUPS) {
    // Handoff groups carry a source on every step instead of one per group.
    if (facts[name] !== undefined) {
      validateSourcedStepGroup(facts[name], name, problems, sourceIds);
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
  const sourcedStepGroup = (group: Record<string, unknown>): KbSourcedStepGroup => ({
    items: (group.items as Record<string, unknown>[]).map((item) => {
      const link = item.link as Record<string, unknown> | undefined;
      return {
        id: item.id as string,
        label: item.label as string,
        detail: item.detail as string,
        ...(link ? { link: { label: link.label as string, url: link.url as string } } : {}),
        sourceId: item.source_id as string,
      };
    }),
    ...(typeof group.form_id === "string" ? { formId: group.form_id } : {}),
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
      ...(rawFacts.submission_steps
        ? { submission_steps: sourcedStepGroup(rawFacts.submission_steps) }
        : {}),
      ...(rawFacts.after_you_apply
        ? { after_you_apply: sourcedStepGroup(rawFacts.after_you_apply) }
        : {}),
      ...(rawFacts.steps
        ? {
            steps: {
              items: rawFacts.steps.items as string[],
              sourceId: rawFacts.steps.source_id as string,
              retrievedAt: rawFacts.steps.retrieved_at as string,
            },
          }
        : {}),
      ...(rawFacts.match_signals
        ? {
            match_signals: {
              items: (rawFacts.match_signals.items as Record<string, unknown>[]).map(
                (item) => ({
                  questionId: item.question_id as string,
                  ...(Array.isArray(item.values)
                    ? { values: item.values as string[] }
                    : {}),
                  ...(typeof item.weight === "number" ? { weight: item.weight } : {}),
                  reason: item.reason as string,
                }),
              ),
              sourceId: rawFacts.match_signals.source_id as string,
              retrievedAt: rawFacts.match_signals.retrieved_at as string,
            },
          }
        : {}),
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
  readonly group: KbFactGroupName | OptionalKbFactGroupName;
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
 * What a source card shows for one KB fact (BN-27): the source's title
 * and official URL, its retrieval date, and the entry's version and
 * status, with the reason when the entry is not active (BN-29).
 */
export interface KbSourceCardView {
  readonly title: string;
  readonly url: string;
  /** YYYY-MM-DD retrieval date. */
  readonly retrievedAt: string;
  readonly entryVersion: number;
  readonly entryStatus: KbEntryStatus;
  readonly statusReason?: string;
}

/**
 * One handoff step with the source that backs it (BN-24 and BN-26). Like
 * KbCitation, `status` is required, so a step from a stale or withdrawn
 * entry can never reach the UI without its status and reason.
 */
export interface KbStepCitation {
  readonly entryId: string;
  readonly entryTitle: string;
  readonly entryVersion: number;
  /** Always present: the consuming API surfaces status with every fact. */
  readonly status: KbEntryStatus;
  /** Present whenever the entry carries one (required for stale/withdrawn). */
  readonly statusReason?: string;
  readonly group: SourcedStepKbFactGroupName;
  readonly step: KbSourcedStep;
  /** The step's own source, never the group's or the entry's first one. */
  readonly sourceId: string;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
  /** YYYY-MM-DD: when the step's own source was retrieved. */
  readonly retrievedAt: string;
}

/**
 * Cite every step of a handoff group, in order, each with its own source
 * and that source's retrieval date, so one source being re-checked can
 * never leave another step showing the wrong date. The same refusal as
 * citeFactGroup: a stale or withdrawn entry is never cited silently, so
 * its steps need acknowledgeNonActive and still carry the status and
 * reason.
 */
export function citeSourcedSteps(
  entry: KbEntry,
  group: SourcedStepKbFactGroupName,
  options: CiteOptions = {},
): readonly KbStepCitation[] {
  const facts = entry.facts[group];
  if (!facts) {
    throw new KbValidationError([
      `entry "${entry.id}" carries no ${group} fact group to cite`,
    ]);
  }
  const sourced = facts.items.map((step) => {
    const source = entry.sources.find(
      (candidate) => candidate.id === step.sourceId,
    );
    if (!source) {
      throw new KbValidationError([
        `facts.${group} step "${step.id}" source_id "${step.sourceId}" does not match a listed source`,
      ]);
    }
    return { step, source };
  });
  if (entry.status !== "active" && options.acknowledgeNonActive !== true) {
    throw new SilentCitationError(
      `entry "${entry.id}" is ${entry.status} and must never be cited silently: ` +
        "pass acknowledgeNonActive and surface the status and reason wherever " +
        "these facts appear",
    );
  }
  return sourced.map(({ step, source }) => ({
    entryId: entry.id,
    entryTitle: entry.title,
    entryVersion: entry.version,
    status: entry.status,
    statusReason: entry.statusReason,
    group,
    step,
    sourceId: source.id,
    sourceTitle: source.title,
    sourceUrl: source.url,
    retrievedAt: source.retrievedAt,
  }));
}

/**
 * Build the citation for one fact group. Refuses to cite a stale or
 * withdrawn entry unless the caller explicitly acknowledges the state,
 * so non-active facts can only enter the UI with their status attached.
 */
export function citeFactGroup(
  entry: KbEntry,
  group: KbFactGroupName | OptionalKbFactGroupName,
  options: CiteOptions = {},
): KbCitation {
  const facts = entry.facts[group];
  if (!facts) {
    throw new KbValidationError([
      `entry "${entry.id}" carries no ${group} fact group to cite`,
    ]);
  }
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
 * The three pilot-agnostic sample entries (mission v2 M3 — matching needs
 * more than one entry to rank). TEST-ONLY fixtures: they never ship in the
 * production dataset, so a placeholder-program card cannot rank for real
 * users (VAL-PILOTREAL-004). Every entry is validated at module load, so
 * invalid KB data fails fast instead of leaking unverified facts.
 */
export const SAMPLE_KB_ENTRIES: readonly KbEntry[] = [
  sampleEntryJson,
  sampleBEntryJson,
  sampleCEntryJson,
].map((json) => parseKbEntry(json as unknown));

// Every shipped entry (the samples plus the real pilot entry), parsed once
// and validated at module load. The production export below is derived from
// this index by the pilot seam.
const SHIPPED_ENTRIES_BY_ID = new Map<string, KbEntry>(
  [
    ...SAMPLE_KB_ENTRIES,
    parseKbEntry(realEntryJson as unknown),
  ].map((entry) => [entry.id, entry]),
);

/**
 * The PRODUCTION knowledge base (mission v2.1 M7 — VAL-PILOTREAL-004):
 * exactly the entries the pilot-config seam references
 * (PILOT_CONFIG.kbEntryIds — the real pilot entry from the HACK-16 lock,
 * official sources + retrieval dates + HACK-17 claim-verification notes).
 * The synthetic samples live only in SAMPLE_KB_ENTRIES above, so a
 * placeholder-program card can never rank beside — or instead of — the
 * real entry in production. An unknown id in the seam fails fast at
 * module load.
 */
export const KB_ENTRIES: readonly KbEntry[] = PILOT_CONFIG.kbEntryIds.map(
  (id) => {
    const entry = SHIPPED_ENTRIES_BY_ID.get(id);
    if (entry === undefined) {
      throw new Error(
        `PILOT_CONFIG.kbEntryIds references an unknown KB entry: "${id}"`,
      );
    }
    return entry;
  },
);
