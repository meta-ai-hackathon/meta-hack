import type { IntakeClientState } from "../../../lib/intake/serialize";

// The "Coming Together" sidebar (VAL-VJS2-001, owner master spec
// adjudicated): the talk stage's second column. The theme checklist is
// DERIVED FROM REAL ENGINE STATE — a theme's "You told us" check appears
// only when every question in that theme that the deterministic engine
// still asks (skip logic applied) carries a stored answer; everything else
// shows the "Coming up" outline dot. Nothing here is fabricated: the
// badges, the counts, and the wording all read the state the engine built.
//
// The four themes are the owner spec's list (living situation / who's with
// you / mailing address / work & income), mapped to the question spec's
// ids. The mapping carries ids ONLY — prompts, options, and skip logic
// stay in the spec, consumed read-only by the engine. Theme membership is
// intersected with the state's visible questions, so a spec change or a
// skip can never make the sidebar claim an answer the engine does not hold.

export interface SidebarTheme {
  readonly id: string;
  readonly label: string;
  readonly questionIds: readonly string[];
}

export const SIDEBAR_THEMES: readonly SidebarTheme[] = [
  {
    id: "living",
    label: "Living situation",
    questionIds: ["housing_status", "housing_cost", "utilities_cost"],
  },
  {
    id: "household",
    label: "Who's with you",
    questionIds: ["household_size", "household_children", "household_seniors"],
  },
  {
    id: "mailing",
    label: "Mailing address",
    questionIds: ["mailing_situation", "shelter_mail_consent"],
  },
  {
    id: "income",
    label: "Work & income",
    questionIds: [
      "income_sources",
      "income_kind",
      "job_income_amount",
      "job_income_frequency",
      "benefits_income_amount",
      "benefits_income_frequency",
      "other_income_amount",
    ],
  },
];

export interface SidebarThemeProgress {
  readonly id: string;
  readonly label: string;
  /** Every question of this theme the engine still asks is answered. */
  readonly told: boolean;
  /** How many of the theme's visible questions carry answers. */
  readonly answeredCount: number;
  /** How many of the theme's questions the engine currently asks. */
  readonly visibleCount: number;
}

/**
 * Derive the sidebar checklist from the engine's client state. Pure and
 * exported for tests: the derivation is the honesty guarantee — a check
 * exists only because `state.answers` holds an answer for every visible
 * question of the theme. A theme whose questions are all skipped shows
 * "Coming up" (the engine never asked it here — no check is claimed).
 */
export function deriveThemeProgress(
  state: IntakeClientState | null,
): readonly SidebarThemeProgress[] {
  const visibleIds = new Set(state?.questions.map((question) => question.id) ?? []);
  const answeredIds = new Set(Object.keys(state?.answers ?? {}));
  return SIDEBAR_THEMES.map((theme) => {
    const visibleCount = theme.questionIds.filter((id) => visibleIds.has(id))
      .length;
    const answeredCount = theme.questionIds.filter((id) => answeredIds.has(id))
      .length;
    return {
      id: theme.id,
      label: theme.label,
      visibleCount,
      answeredCount,
      told: visibleCount > 0 && answeredCount === visibleCount,
    };
  });
}

/**
 * Map the questions a turn just answered to the sidebar themes they
 * advanced (the [✓ theme] chips on finalized user bubbles, VAL-VJS2-001).
 * Pure: the caller diffs the engine state before and after the turn; this
 * maps the newly answered ids to theme ids in spec order. Questions
 * outside the sidebar themes (greetings, ids the spec dropped) map to
 * nothing — no chip is invented.
 */
export function themesForQuestionIds(
  questionIds: readonly string[],
): readonly string[] {
  const ids = new Set(questionIds);
  return SIDEBAR_THEMES.filter((theme) =>
    theme.questionIds.some((id) => ids.has(id)),
  ).map((theme) => theme.id);
}

/** A theme's display label, for the finalized-bubble chips. */
export function themeLabelFor(themeId: string): string {
  return SIDEBAR_THEMES.find((theme) => theme.id === themeId)?.label ?? themeId;
}

/**
 * The talk stage's sidebar. An <aside> so the transcript remains the
 * page's primary content; the checklist is real text (badge labels are
 * words, the ✓/○ glyphs are decorative), the counters are mono per the
 * spec's counter style.
 */
export function ComingTogether(props: { state: IntakeClientState | null }) {
  const themes = deriveThemeProgress(props.state);
  return (
    <aside
      data-coming-together
      data-journey-stage="talk"
      aria-labelledby="coming-together-heading"
      className="flex flex-col gap-4 rounded-2xl border border-surface-border bg-surface p-6"
    >
      <h2 id="coming-together-heading" className="font-display text-2xl font-bold">
        Coming Together
      </h2>
      <ul className="flex flex-col gap-3" data-sidebar-themes>
        {themes.map((theme) => (
          <li key={theme.id} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              {theme.told ? (
                <span
                  data-sidebar-theme-told={theme.id}
                  className="flex items-center gap-1.5 text-sm font-medium text-teal"
                >
                  <span aria-hidden="true" className="text-base leading-none">✓</span>
                  You told us
                </span>
              ) : (
                <span
                  data-sidebar-theme-upcoming={theme.id}
                  className="flex items-center gap-1.5 text-sm text-muted"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 rounded-full border border-muted"
                  />
                  Coming up
                </span>
              )}
              <span className="font-medium">{theme.label}</span>
            </span>
            <span
              data-sidebar-theme-count={theme.id}
              className="font-mono text-xs text-muted"
            >
              {theme.answeredCount} of {theme.visibleCount}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted">A clearer picture, little by little.</p>
      <p className="border-t border-surface-border pt-3 text-sm text-muted">
        One conversation. Your own words.
      </p>
    </aside>
  );
}
