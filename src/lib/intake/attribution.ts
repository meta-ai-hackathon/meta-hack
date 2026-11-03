// Per-person exemption attribution (HACK-135, Civilla): for each
// situation the household has told us about, WHO it applies to (a
// household-roster member) and WHICH MONTHS (this month / last month /
// both / not sure). Pure and browser-safe; records answers only - the
// state decides whether anyone is exempt. Never sums or decides.

import { QUESTION_BY_ID } from "./spec";
import { rosterFromAnswers, type HouseholdMember } from "./roster";
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
  if (exempt?.status === "known" && Array.isArray(exempt.value)) {
    const options = QUESTION_BY_ID["wr_exempt_situations"]?.options ?? [];
    for (const option of options) {
      if (option.value !== "none" && exempt.value.map(String).includes(option.value)) {
        out.push({ id: option.value, label: option.label });
      }
    }
  }
  for (const id of EXEMPTION_QUESTION_IDS) {
    const stored = answers[id];
    if (stored?.status === "known" && stored.value === "yes") {
      out.push({ id, label: labelFor(id) });
    }
  }
  const income = answers[INCOME_580_SITUATION_ID];
  if (income?.status === "known" && income.value === "yes") {
    out.push({ id: INCOME_580_SITUATION_ID, label: "Household makes at least $580 a month" });
  }
  return out;
}

export interface AttributionContext {
  readonly members: readonly HouseholdMember[];
  readonly situations: readonly AttributionSituation[];
}

export function attributionContextFromAnswers(answers: AnswerMap): AttributionContext {
  return { members: rosterFromAnswers(answers), situations: applicableSituations(answers) };
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
  return out;
}

/** Drop entries naming a removed member or a no-longer-applicable situation. */
export function pruneAttribution(entries: readonly AttributionEntry[], context: AttributionContext): AttributionEntry[] {
  const memberIds = new Set(context.members.map((m) => m.id));
  const situationIds = new Set(context.situations.map((s) => s.id));
  return entries.filter((e) => memberIds.has(e.memberId) && situationIds.has(e.situationId));
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
