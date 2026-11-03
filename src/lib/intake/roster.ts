// Household roster (HACK-134, Civilla): the named members later
// per-person attribution (HACK-135) and work reporting (HACK-128)
// attach to. Pure and browser-safe: no storage, no network, no
// eligibility logic â€” the state decides eligibility; this module
// only records who the user says is in the household.

export const ROSTER_QUESTION_ID = "household_roster";

/** Longest display name (first name or nickname) the roster accepts. */
export const MAX_MEMBER_NAME_LENGTH = 60;
/** Safety cap well above any household the counts question accepts in practice. */
export const MAX_ROSTER_MEMBERS = 20;

export const RELATIONSHIP_VALUES = [
  "self",
  "spouse_or_partner",
  "child",
  "parent",
  "sibling",
  "other_family",
  "unrelated",
] as const;
export type Relationship = (typeof RELATIONSHIP_VALUES)[number];

// Band edges align to the thresholds later attribution must not guess
// across: under 14 (caregiver), 18 (adult), 55, and 60 (senior counts).
export const AGE_BAND_VALUES = [
  "under_14",
  "14_to_17",
  "18_to_54",
  "55_to_59",
  "60_plus",
] as const;
export type AgeBand = (typeof AGE_BAND_VALUES)[number];

export const RELATIONSHIP_LABELS: Readonly<Record<Relationship, string>> = {
  self: "Me",
  spouse_or_partner: "Spouse or partner",
  child: "Child",
  parent: "Parent",
  sibling: "Brother or sister",
  other_family: "Other family member",
  unrelated: "Someone else who lives with us",
};

export const AGE_BAND_LABELS: Readonly<Record<AgeBand, string>> = {
  under_14: "Under 14",
  "14_to_17": "14 to 17",
  "18_to_54": "18 to 54",
  "55_to_59": "55 to 59",
  "60_plus": "60 or older",
};

export interface HouseholdMember {
  readonly id: string;
  readonly displayName: string;
  readonly relationship: Relationship;
  readonly ageBand: AgeBand;
}

function isRelationship(v: unknown): v is Relationship {
  return typeof v === "string" && (RELATIONSHIP_VALUES as readonly string[]).includes(v);
}
function isAgeBand(v: unknown): v is AgeBand {
  return typeof v === "string" && (AGE_BAND_VALUES as readonly string[]).includes(v);
}

/**
 * Canonical roster parsed from an unknown answer value, or null when
 * invalid: a non-empty array of members with unique non-blank ids,
 * trimmed non-empty display names, and known relationship/age-band
 * values. Duplicate ids or any malformed member invalidates the whole
 * value (never repair into invented data).
 */
export function parseRoster(value: unknown): HouseholdMember[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROSTER_MEMBERS) return null;
  const seen = new Set<string>();
  const out: HouseholdMember[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(m.id) || seen.has(m.id)) return null;
    if (typeof m.displayName !== "string") return null;
    const name = m.displayName.trim();
    if (name === "" || name.length > MAX_MEMBER_NAME_LENGTH) return null;
    if (!isRelationship(m.relationship) || !isAgeBand(m.ageBand)) return null;
    seen.add(m.id);
    out.push({ id: m.id, displayName: name, relationship: m.relationship, ageBand: m.ageBand });
    if (out.filter((x) => x.relationship === "self").length > 1) return null;
  }
  return out;
}

export function nextMemberId(roster: readonly HouseholdMember[]): string {
  const used = new Set(roster.map((m) => m.id));
  let n = roster.length + 1;
  while (used.has(`member-${n}`)) n += 1;
  return `member-${n}`;
}

export function emptyMember(id: string, relationship: Relationship = "other_family"): HouseholdMember {
  return { id, displayName: "", relationship, ageBand: "18_to_54" };
}

/**
 * Loose draft view for the editor: blank and untrimmed names survive,
 * so typing is never mangled mid-edit. parseRoster stays the strict
 * canonical check and runs only at the store boundary on submit.
 * At most one member may be "self": a second one invalidates the value.
 */
export function draftMembers(value: unknown): HouseholdMember[] {
  if (!Array.isArray(value) || value.length === 0) return [emptyMember("member-1", "self")];
  const out: HouseholdMember[] = [];
  value.forEach((raw, i) => {
    const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    out.push({
      id: typeof m.id === "string" && m.id !== "" ? m.id : `member-${i + 1}`,
      displayName: typeof m.displayName === "string" ? m.displayName : "",
      relationship: isRelationship(m.relationship) ? m.relationship : i === 0 ? "self" : "other_family",
      ageBand: isAgeBand(m.ageBand) ? m.ageBand : "18_to_54",
    });
  });
  return out;
}

export function addMember(roster: readonly HouseholdMember[], member: HouseholdMember): HouseholdMember[] {
  if (roster.length >= MAX_ROSTER_MEMBERS) return [...roster];
  if (roster.some((m) => m.id === member.id)) return [...roster];
  return [...roster, member];
}

export function updateMember(roster: readonly HouseholdMember[], id: string, patch: Partial<Omit<HouseholdMember, "id">>): HouseholdMember[] {
  return roster.map((m) => (m.id === id ? { ...m, ...patch } : m));
}

export function removeMember(roster: readonly HouseholdMember[], id: string): HouseholdMember[] {
  return roster.filter((m) => m.id !== id);
}

/** Roster stored under the roster question in an answer map, or []. */
export function rosterFromAnswers(answers: Readonly<Record<string, { readonly status?: string; readonly value?: unknown } | undefined>>): HouseholdMember[] {
  const stored = answers[ROSTER_QUESTION_ID];
  if (!stored || stored.status !== "known") return [];
  return parseRoster(stored.value) ?? [];
}

/** Pick-list options later attribution steps render (id value, name label). */
export function memberOptions(roster: readonly HouseholdMember[]): { value: string; label: string }[] {
  return roster.map((m) => ({ value: m.id, label: m.displayName }));
}
