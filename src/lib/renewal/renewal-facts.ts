import pilotRenewalEntryJson from "../../../kb/pilot/nc-medicaid-renewal.json";
import {
  KbValidationError,
  citeCadenceSchedule,
  citeFactGroup,
  parseKbEntry,
  type KbCitation,
  type KbEntry,
  type KbEntryStatus,
  type KbFactGroupName,
  type OptionalKbFactGroupName,
} from "../kb";
import { parseIsoDate } from "./calendar-date";
import type { RenewalSchedule } from "./estimate";
import { isPlainHttpsUrl } from "./ics";

/**
 * The knowledge-base side of the renewal tracker (BN-22 / HACK-50).
 *
 * Builds a plain, serializable view of one renewal entry's facts on the
 * server, where the KB module lives, so client components receive only
 * data. Every item carries its source (title, URL, retrieval date, entry
 * version) through the citation API, so nothing renders without its
 * provenance. Stale entries are cited only with explicit acknowledgment
 * and keep their status for the UI to flag (BN-29); a withdrawn entry
 * yields no facts at all, only its status and reason.
 *
 * The decided pilot's entry is the one module-level import of a kb/pilot
 * file; routing it through PILOT_CONFIG belongs to the HACK-16 flip.
 */

export interface RenewalSourceView {
  readonly sourceTitle: string;
  readonly sourceUrl: string;
  /** YYYY-MM-DD the group's facts were read from the source. */
  readonly retrievedAt: string;
  readonly entryVersion: number;
}

export interface RenewalFactItem {
  readonly text: string;
  readonly source: RenewalSourceView;
}

export interface RenewalScheduleView extends RenewalSchedule {
  readonly source: RenewalSourceView;
}

/** A deadline the source dates exactly (its `due` is YYYY-MM-DD). */
export interface RenewalKeyDate {
  readonly date: string;
  readonly label: string;
  readonly source: RenewalSourceView;
}

/** A deadline the source states in words rather than as a date. */
export interface RenewalDeadlineNote {
  readonly label: string;
  readonly due: string;
  readonly source: RenewalSourceView;
}

export interface RenewalLinkView {
  readonly label: string;
  readonly url: string;
  readonly source: RenewalSourceView;
}

export interface RenewalFactsView {
  readonly entryId: string;
  /** The program name, from the entry title (for example "NC Medicaid"). */
  readonly programName: string;
  readonly entryVersion: number;
  readonly entryStatus: KbEntryStatus;
  readonly statusReason?: string;
  readonly schedules: readonly RenewalScheduleView[];
  readonly keyDates: readonly RenewalKeyDate[];
  readonly deadlineNotes: readonly RenewalDeadlineNote[];
  readonly rules: readonly RenewalFactItem[];
  readonly documents: readonly RenewalFactItem[];
  readonly steps: readonly RenewalFactItem[];
  /** What happens and where to get help if coverage ends: shown once a date has passed. */
  readonly ifCoverageEnds: readonly RenewalFactItem[];
  readonly links: readonly RenewalLinkView[];
}

/**
 * What the reminder banner needs: no prose facts, just the schedules. No
 * program name either, since the banner never names the program (third
 * review: anyone who uses the device sees it).
 */
export type RenewalBannerFacts = Pick<RenewalFactsView, "entryId" | "entryStatus" | "schedules">;

function sourceView(entry: KbEntry, citation: KbCitation): RenewalSourceView {
  const source = entry.sources.find((candidate) => candidate.id === citation.sourceId);
  return {
    sourceTitle: source?.title ?? citation.sourceUrl,
    sourceUrl: citation.sourceUrl,
    retrievedAt: citation.retrievedAt,
    entryVersion: citation.entryVersion,
  };
}

export function buildRenewalFactsView(entry: KbEntry): RenewalFactsView {
  const base = {
    entryId: entry.id,
    programName: entry.title,
    entryVersion: entry.version,
    entryStatus: entry.status,
    ...(entry.statusReason !== undefined ? { statusReason: entry.statusReason } : {}),
  };
  if (entry.status === "withdrawn") {
    return {
      ...base,
      schedules: [],
      keyDates: [],
      deadlineNotes: [],
      rules: [],
      documents: [],
      steps: [],
      ifCoverageEnds: [],
      links: [],
    };
  }
  // Stale entries are shown flagged, never silently: the acknowledgment
  // only lets the citation through; the status rides along to the UI.
  const cite = (group: KbFactGroupName | OptionalKbFactGroupName) =>
    sourceView(entry, citeFactGroup(entry, group, { acknowledgeNonActive: true }));

  const textItems = (
    group: "rules" | "required_documents" | "steps" | "if_coverage_ends",
  ): readonly RenewalFactItem[] => {
    const facts = entry.facts[group];
    if (!facts) {
      return [];
    }
    const source = cite(group);
    return facts.items.map((text) => ({ text, source }));
  };

  const cadence = entry.facts.renewal_cadence;
  const schedules: RenewalScheduleView[] = [];
  if (cadence) {
    for (const item of cadence.items) {
      // Each schedule carries the page that states it (second review: the
      // 6 month schedule's age scope is stated on a different page than
      // the once-a-year line).
      const source = sourceView(
        entry,
        citeCadenceSchedule(entry, item.id, { acknowledgeNonActive: true }),
      );
      schedules.push({
        id: item.id,
        intervalMonths: item.intervalMonths,
        label: item.label,
        appliesTo: item.appliesTo,
        ...(item.startsOn !== undefined ? { startsOn: item.startsOn } : {}),
        ...(item.ages !== undefined ? { ages: { min: item.ages.min, max: item.ages.max } } : {}),
        source,
      });
    }
  }

  const deadlineSource = cite("deadlines");
  const keyDates: RenewalKeyDate[] = [];
  const deadlineNotes: RenewalDeadlineNote[] = [];
  for (const item of entry.facts.deadlines.items) {
    if (parseIsoDate(item.due) !== null) {
      keyDates.push({ date: item.due, label: item.label, source: deadlineSource });
    } else {
      deadlineNotes.push({ label: item.label, due: item.due, source: deadlineSource });
    }
  }
  keyDates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const linkSource = cite("official_links");
  const view: RenewalFactsView = {
    ...base,
    schedules,
    keyDates,
    deadlineNotes,
    rules: textItems("rules"),
    documents: textItems("required_documents"),
    steps: textItems("steps"),
    ifCoverageEnds: textItems("if_coverage_ends"),
    links: entry.facts.official_links.items.map((link) => ({
      label: link.label,
      url: link.url,
      source: linkSource,
    })),
  };
  assertPlainUrls(view);
  return view;
}

/**
 * Every source and link URL the view shows must be a plain https URL, by
 * the rule the calendar builder holds an event URL to (isPlainHttpsUrl in
 * ics.ts). The KB checks only look at the https:// prefix, so a URL with a
 * space or a quote used to load and then throw inside the download click
 * (third review). Checked here instead, so bad knowledge-base data fails
 * when this module loads, which for the pilot entry is the build.
 */
function assertPlainUrls(view: RenewalFactsView): void {
  const sourced = [
    ...view.schedules,
    ...view.keyDates,
    ...view.deadlineNotes,
    ...view.rules,
    ...view.documents,
    ...view.steps,
    ...view.ifCoverageEnds,
    ...view.links,
  ];
  const urls = new Set([...sourced.map((item) => item.source.sourceUrl), ...view.links.map((link) => link.url)]);
  const problems = [...urls]
    .filter((url) => !isPlainHttpsUrl(url))
    .map((url) => `url "${url}" is not a plain https URL (no spaces, quotes, angle brackets, or the like)`);
  if (problems.length > 0) {
    throw new KbValidationError(problems);
  }
}

/** The banner's slice of a facts view. */
export function bannerFacts(view: RenewalFactsView): RenewalBannerFacts {
  return {
    entryId: view.entryId,
    entryStatus: view.entryStatus,
    schedules: view.schedules,
  };
}

/** The decided pilot's renewal entry, validated at module load. */
export const PILOT_RENEWAL_ENTRY: KbEntry = parseKbEntry(pilotRenewalEntryJson as unknown);

/** The facts view the renewal page and the banner render. */
export const PILOT_RENEWAL_FACTS: RenewalFactsView = buildRenewalFactsView(PILOT_RENEWAL_ENTRY);
