// Per-person work-activity rows (HACK-128, Civilla 3-column table):
// Household Member | Type of Activity | Hours Last Month. Pure and
// browser-safe. Records answers only: hours are NEVER summed across
// people and nothing here decides compliance - the state decides.

import type { AnswerMap } from "./flow";
import { QUESTION_BY_ID } from "./spec";
import { rosterFromAnswers, type HouseholdMember } from "./roster";

export const WORK_ROWS_QUESTION_ID = "wr_work_rows";

/** Activity values: the wr_work_activity_types spec options, the single source. */
export function activityTypes(): { value: string; label: string }[] {
  return [...(QUESTION_BY_ID["wr_work_activity_types"]?.options ?? [])];
}

export interface WorkRow {
  readonly memberId: string;
  readonly activity: string;
  /** Hours last month; null means the person said "not sure". */
  readonly hours: number | null;
}

export function parseWorkRows(value: unknown): WorkRow[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const activities = new Set(activityTypes().map((a) => a.value));
  const seen = new Set<string>();
  const out: WorkRow[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.memberId !== "string" || r.memberId === "" || r.memberId.length > 32) return null;
    if (typeof r.activity !== "string" || !activities.has(r.activity)) return null;
    if (!(r.hours === null || (typeof r.hours === "number" && Number.isFinite(r.hours) && r.hours >= 0))) return null;
    const key = `${r.memberId}|${r.activity}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({ memberId: r.memberId, activity: r.activity, hours: r.hours });
  }
  return out;
}

/** Loose draft rows for the editor: malformed rows drop, never repaired. */
export function draftWorkRows(value: unknown, memberIds?: ReadonlySet<string>): WorkRow[] {
  const parsed = parseWorkRows(value);
  const rows = parsed ?? (Array.isArray(value) ? value.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.memberId !== "string" || typeof r.activity !== "string") return [];
    return [{ memberId: r.memberId, activity: r.activity, hours: typeof r.hours === "number" ? r.hours : null }];
  }) : []);
  return memberIds ? rows.filter((r) => memberIds.has(r.memberId)) : rows;
}

export function setWorkRow(rows: readonly WorkRow[], index: number, patch: Partial<WorkRow>): WorkRow[] {
  return rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
}

export function removeWorkRow(rows: readonly WorkRow[], index: number): WorkRow[] {
  return rows.filter((_, i) => i !== index);
}

/**
 * Prefill suggestions from the income section: when the household told
 * us money comes from a job or self-employment, offer a row (first/self
 * member, that activity, hours to fill in) for confirmation instead of
 * re-asking. No employer details are ever asked here, and hours stay
 * editable. Suggestions never override rows the person already made.
 */
export function suggestedWorkRows(answers: AnswerMap, members: readonly HouseholdMember[]): WorkRow[] {
  if (members.length === 0) return [];
  const stored = answers["income_sources"];
  if (!stored || stored.status === "unknown" || !Array.isArray(stored.value)) return [];
  const sources = stored.value.map(String);
  const self = members.find((m) => m.relationship === "self") ?? members[0];
  const out: WorkRow[] = [];
  if (sources.includes("job")) out.push({ memberId: self.id, activity: "job_internship", hours: null });
  if (sources.includes("self_employed")) out.push({ memberId: self.id, activity: "self_employment", hours: null });
  return out;
}

export interface WorkContext {
  readonly members: readonly HouseholdMember[];
  readonly suggestions: readonly WorkRow[];
}

export function workContextFromAnswers(answers: AnswerMap): WorkContext {
  const members = rosterFromAnswers(answers, { includeUnverified: true });
  return { members, suggestions: suggestedWorkRows(answers, members) };
}

/** The stored rows pruned to the current roster (removed members drop out). */
export function currentWorkRows(answers: AnswerMap): WorkRow[] {
  const stored = answers[WORK_ROWS_QUESTION_ID];
  if (!stored || stored.status === "unknown") return [];
  const parsed = parseWorkRows(stored.value);
  if (!parsed) return [];
  const memberIds = new Set(rosterFromAnswers(answers, { includeUnverified: true }).map((m) => m.id));
  // A roster marked unknown retains every row (nothing was withdrawn).
  if (answers["household_roster"]?.status === "unknown") return parsed;
  return parsed.filter((r) => memberIds.has(r.memberId));
}
