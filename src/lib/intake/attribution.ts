// Per-person exemption attribution (HACK-135, Civilla): for each
// situation the household has told us about, WHO it applies to (a
// household-roster member) and WHICH MONTHS (this month / last month /
// both / not sure). Pure and browser-safe; records answers only - the
// state decides whether anyone is exempt. Never sums or decides.

import { QUESTION_BY_ID } from "./spec";
import { ROSTER_QUESTION_ID, rosterFromAnswers, type HouseholdMember } from "./roster";
import type { AnswerMap } from "./flow";

export const ATTRIBUTION_QUESTION_ID = "wr_who_months";

export const MONTH_VALUES = ["this_month", "last_month", "both", "not_sure"] as const;
export type Months = (typeof MONTH_VALUES)[number];
export const MONTH_LABELS: Readonly<Record<Months, string>> = {
  this_month: "This month",
  last_month: "Last month",
  both: "Both months",
  not_sure: "Not sure",
};

/** Boolean-style exemption questions whose "yes" creates a situation to attribute. */
export const EXEMPTION_QUESTION_IDS: readonly string[] = [
  "wr_pregnant",
  "wr_drug_alcohol_treatment",
  "wr_drug_alcohol_disorder",
  "wr_disability_hard_work",
  "wr_mental_health_hard_work",
  "wr_serious_health_condition",
  "wr_jail_prison_past_4_months",
  "wr_foster_care_under_26",
  "wr_veteran_100_disabled",
  "wr_medical_travel_1hr",
  "wr_hospital_care_24hr",
];

/** The $580 screen also gets a per-person which-months follow-up (HACK-135). */
export const INCOME_580_SITUATION_ID = "wr_income_580";

export interface AttributionSituation {
  readonly id: string;
  readonly label: string;
}

export interface AttributionEntry {
  readonly memberId: string;
  readonly situationId: string;
  readonly months: Months;
}

/** Every situation id an attribution entry may name. */
export function allSituationIds(): Set<string> {
  const ids = new Set<string>([...EXEMPTION_QUESTION_IDS, INCOME_580_SITUATION_ID]);
  const exempt = QUESTION_BY_ID["wr_exempt_situations"];
  for (const option of exempt?.options ?? []) {
    if (option.value !== "none") ids.add(option.value);
  }
  return ids;
}

function isMonths(v: unknown): v is Months {
  return typeof v === "string" && (MONTH_VALUES as readonly string[]).includes(v);
}

/**
 * Canonical attribution entries from an unknown value, or null when
 * invalid: a non-empty array of entries with distinct
 * (memberId, situationId) pairs, known situation ids, and known months.
 */
export function parseAttribution(value: unknown, situationIds: ReadonlySet<string> = allSituationIds()): AttributionEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const seen = new Set<string>();
  const out: AttributionEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const e = raw as Record<string, unknown>;
    if (typeof e.memberId !== "string" || e.memberId === "" || e.memberId.length > 32) return null;
    if (typeof e.situationId !== "string" || !situationIds.has(e.situationId)) return null;
    if (!isMonths(e.months)) return null;
    const key = `${e.memberId}|${e.situationId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({ memberId: e.memberId, situationId: e.situationId, months: e.months });
  }
  return out;
}

/** Situations the household's answers make applicable, in spec order. */
export function applicableSituations(answers: AnswerMap): AttributionSituation[] {
  const out: AttributionSituation[] = [];
  const labelFor = (id: string): string => QUESTION_BY_ID[id]?.prompt ?? id;
  const exempt = answers["wr_exempt_situations"];
  if (exempt && exempt.status !== "unknown" && Array.isArray(exempt.value)) {
    const options = QUESTION_BY_ID["wr_exempt_situations"]?.options ?? [];
    for (const option of options) {
      if (option.value !== "none" && exempt.value.map(String).includes(option.value)) {
        out.push({ id: option.value, label: option.label });
      }
    }
  }
  for (const id of EXEMPTION_QUESTION_IDS) {
    const stored = answers[id];
    // A best-guess ("unverified") yes is still the person's answer: the
    // situation is attributable, and its entries are never pruned as if
    // the answer had been "no". Only known-or-absent "no" withdraws it.
    if (stored && stored.status !== "unknown" && stored.value === "yes") {
      out.push({ id, label: labelFor(id) });
    }
  }
  const income = answers[INCOME_580_SITUATION_ID];
  if (income && income.status !== "unknown" && income.value === "yes") {
    out.push({ id: INCOME_580_SITUATION_ID, label: labelFor(INCOME_580_SITUATION_ID) });
  }
  return out;
}

export interface AttributionContext {
  readonly members: readonly HouseholdMember[];
  readonly situations: readonly AttributionSituation[];
  /**
   * Ids retained through pruning even when not currently applicable:
   * entries whose source answer is "unknown" (not withdrawn). A null
   * member set retains every member (the roster itself is unknown).
   */
  readonly retainMemberIds?: readonly string[] | null;
  readonly retainSituationIds?: readonly string[];
}

export function attributionContextFromAnswers(answers: AnswerMap): AttributionContext {
  const retainSituationIds = new Set<string>();
  const exempt = answers["wr_exempt_situations"];
  if (exempt?.status === "unknown") {
    // Only the exempt list's own option values are retained: an unknown
    // exempt list says nothing about the separate exemption questions or
    // the $580 screen, whose known "no" answers still withdraw theirs.
    for (const option of QUESTION_BY_ID["wr_exempt_situations"]?.options ?? []) {
      if (option.value !== "none") retainSituationIds.add(option.value);
    }
  }
  for (const id of EXEMPTION_QUESTION_IDS) {
    if (answers[id]?.status === "unknown") retainSituationIds.add(id);
  }
  if (answers[INCOME_580_SITUATION_ID]?.status === "unknown") {
    retainSituationIds.add(INCOME_580_SITUATION_ID);
  }
  return {
    members: rosterFromAnswers(answers, { includeUnverified: true }),
    situations: applicableSituations(answers),
    retainMemberIds: answers[ROSTER_QUESTION_ID]?.status === "unknown" ? null : [],
    retainSituationIds: [...retainSituationIds],
  };
}

/** Loose draft entries for the editor: malformed rows are dropped, never repaired into data. */
export function draftAttribution(value: unknown, context?: AttributionContext): AttributionEntry[] {
  const parsed = parseAttribution(value);
  if (parsed) return context ? pruneAttribution(parsed, context) : parsed;
  if (!Array.isArray(value)) return [];
  const out: AttributionEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.memberId === "string" && typeof e.situationId === "string" && isMonths(e.months)) {
      out.push({ memberId: e.memberId, situationId: e.situationId, months: e.months });
    }
  }
  return context ? pruneAttribution(out, context) : out;
}

/** Drop entries naming a removed member or a no-longer-applicable situation. */
export function pruneAttribution(entries: readonly AttributionEntry[], context: AttributionContext): AttributionEntry[] {
  const memberIds = new Set(context.members.map((m) => m.id));
  const situationIds = new Set(context.situations.map((s) => s.id));
  const retainMembers = context.retainMemberIds;
  const retainSituations = new Set(context.retainSituationIds ?? []);
  return entries.filter((e) => {
    const memberKept = memberIds.has(e.memberId) || retainMembers === null || (retainMembers ?? []).includes(e.memberId);
    const situationKept = situationIds.has(e.situationId) || retainSituations.has(e.situationId);
    return memberKept && situationKept;
  });
}

export function setAttribution(entries: readonly AttributionEntry[], memberId: string, situationId: string, months: Months | null): AttributionEntry[] {
  const rest = entries.filter((e) => !(e.memberId === memberId && e.situationId === situationId));
  return months === null ? rest : [...rest, { memberId, situationId, months }];
}

/**
 * The stored attribution as it should be read today: parsed, then pruned
 * against the CURRENT roster and applicable situations from the same
 * answers. Review and form paths should read through this, so a removed
 * member or withdrawn situation never keeps an attribution.
 */
export function currentAttribution(answers: AnswerMap): AttributionEntry[] {
  const stored = answers[ATTRIBUTION_QUESTION_ID];
  if (!stored || stored.status === "unknown") return [];
  const parsed = parseAttribution(stored.value);
  if (!parsed) return [];
  return pruneAttribution(parsed, attributionContextFromAnswers(answers));
}

export function entriesForMember(entries: readonly AttributionEntry[], memberId: string): AttributionEntry[] {
  return entries.filter((e) => e.memberId === memberId);
}
