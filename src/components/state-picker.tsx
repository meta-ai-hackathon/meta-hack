"use client";

import { useEffect, useRef, useState } from "react";

export interface PickerOption {
  value: string;
  label: string;
}

export interface StatePickerProps {
  /**
   * DOM id prefix: the input gets `${id}-input`, the listbox `${id}-listbox`,
   * each option `${id}-opt-<value>`. The parent renders the visible label
   * with htmlFor={`${id}-input`}.
   */
  id: string;
  /** Every valid option (the spec's options, verbatim). */
  options: readonly PickerOption[];
  /** The draft/stored answer: the picked option's value (undefined = nothing picked). */
  value?: string;
  /** Reports the picked option value — the spec's own value, so the existing answer route and its validation are unchanged. */
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Help/error ids announced with the input (aria-describedby). */
  describedBy?: string;
}

/** The picker's filter: case-insensitive substring over the label or the code. */
export function matchesQuery(option: PickerOption, normalizedQuery: string): boolean {
  return (
    option.label.toLowerCase().includes(normalizedQuery) ||
    option.value.toLowerCase().includes(normalizedQuery)
  );
}

/**
 * The visible option list for a query: the empty (or whitespace) query
 * shows every option; otherwise a case-insensitive substring match on the
 * label or the value code. Order always follows the spec's option order.
 */
export function visibleOptions(options: readonly PickerOption[], query: string): PickerOption[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return [...options];
  return options.filter((option) => matchesQuery(option, normalized));
}

/**
 * The option a query commits to (HACK-164, VAL-UX-001), or undefined when
 * nothing should be picked: the exact (case-insensitive) match on the
 * LABEL, else the one option the query still filters to. The label is
 * what the person can see and type ("North Carolina" or "virginia", a
 * label that is also a prefix of another label); a value code counts only
 * through uniqueness ("nc" filters to just NC) — an ambiguous prefix
 * ("ma" exact-matches MA's code while MD and ME also match) commits
 * nothing, so a Continue press keeps its needed-to-continue gate instead
 * of silently saving the wrong state.
 */
export function commitCandidate(
  options: readonly PickerOption[],
  query: string,
): PickerOption | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") return undefined;
  const exactLabel = options.find(
    (option) => option.label.toLowerCase() === normalized,
  );
  if (exactLabel) return exactLabel;
  const matches = options.filter((option) => matchesQuery(option, normalized));
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Compact type-to-filter state picker (HACK-142, VAL-PICK-001): one input
 * row instead of a 50-radio page. WAI-ARIA combobox pattern — the input
 * keeps focus while arrow keys move aria-activedescendant through the
 * listbox; Enter, Escape, and click all behave per the pattern. Losing
 * focus commits the typed input (HACK-164, VAL-UX-001): the exact
 * (case-insensitive) match or the only remaining match is picked, so
 * typing a full state name and pressing Continue — whose press blurs the
 * input — works without the needed-to-continue error. Every
 * valid option stays in the DOM (the collapsed listbox is display-none,
 * not unmounted) so nothing is lost and the spec's options remain
 * enumerable. The current pick is always named in text next to the input,
 * so the saved draft is never a mystery. The reported value is the spec's
 * option value, so the existing tri-state answer route, its validation,
 * and the server-side provenance are untouched.
 *
 * The open listbox renders IN FLOW (HACK-164 follow-up, claude-review P2
 * on PR #154): it occupies its own space and pushes the "Picked" chip, a
 * visible needed-to-continue error, and the controls below down instead
 * of floating over them — an in-flow element can never overlay anything,
 * so a click aimed at a control below can never land on an option. The
 * cost of flow participation is that closing (or reshaping) the list
 * reflows the page, so the close lives entirely OUTSIDE pointer presses:
 * a press's blur commits but neither closes nor resets (that moved the
 * aimed control between mousedown and click — the bug PR #154 floated the
 * list to dodge), and the close-and-yield happens on the press's own
 * click, after it has landed. Clicks outside the picker close it, clicks
 * inside never do.
 */
export function StatePicker({
  id,
  options,
  value,
  onChange,
  disabled = false,
  describedBy,
}: StatePickerProps) {
  const selected = options.find((option) => option.value === value);
  const [query, setQuery] = useState(selected?.label ?? "");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Mirrors the value this picker last reported: when the value changes
  // from OUTSIDE (a stored answer loading into the form), the visible
  // label resyncs; typing inside the picker is never clobbered.
  const reportedRef = useRef(value);
  // True from a pointerdown until that press's click has been handled —
  // NOT until pointerup. The blur a press causes must not close the list
  // or reset the query (either reflows the page mid-press and the press
  // lands on whatever shifted under the pointer), and on touch the
  // compatibility mousedown that blurs the input fires AFTER pointerup,
  // so the flag has to survive pointerup for the blur to stay its hand
  // through the whole press (claude-review P2 on this PR). The deferred
  // close-and-yield runs on the press's own click, which also clears the
  // flag; pointercancel covers a press that never becomes a click.
  const pressingRef = useRef(false);
  // Whether the press that is in flight STARTED inside the picker: a
  // text-selection drag in the input that releases outside fires its
  // click on a common ancestor outside the root, and that release must
  // not close the list or discard the typed query (claude-review P3 on
  // this PR).
  const pressStartedInsideRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (value === reportedRef.current) return;
    reportedRef.current = value;
    setQuery(options.find((option) => option.value === value)?.label ?? "");
    // The option list is stable per question; only an external value
    // change needs to resync the display.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // While the list is open, the close lives outside pointer presses: a
  // click anywhere outside the picker closes it (and yields the typed
  // query to the last-reported pick's label, the same yield Escape
  // performs) only after that click's own handlers have run — the press
  // that aimed at a control below lands first, then the list closes. A
  // click inside the picker (the input, an option) never closes anything
  // here. The yield reads reportedRef, not the closure's `selected`: the
  // click that ends a press can land before React has re-rendered the
  // parent with the just-committed value, and a stale `selected` would
  // blank the input while the chip already names the pick.
  useEffect(() => {
    if (!open) return;
    const pressBeganInside = (event: PointerEvent | MouseEvent): boolean =>
      Boolean(
        rootRef.current &&
          event.target instanceof Node &&
          rootRef.current.contains(event.target),
      );
    const onDocPointerDown = (event: PointerEvent): void => {
      // Only a primary-button press can end in the click that lands the
      // aim. Right- and middle-clicks fire pointerdown but never a click,
      // so arming the flag for them would suppress a later keyboard
      // blur's close-and-yield until some unrelated click came along.
      if (event.button !== 0) return;
      pressingRef.current = true;
      pressStartedInsideRef.current = pressBeganInside(event);
    };
    const onDocPointerCancel = (): void => {
      pressingRef.current = false;
    };
    const onDocClick = (event: MouseEvent): void => {
      pressingRef.current = false;
      // A press that began inside the picker (picking an option; a
      // text-selection drag in the input that releases outside) never
      // aims at a control below: such a click's target is the picker or
      // a common ancestor, never a button, so it closes nothing.
      if (pressStartedInsideRef.current || pressBeganInside(event)) {
        return;
      }
      setOpen(false);
      setActiveIndex(null);
      const reported = reportedRef.current;
      setQuery(
        reported === undefined
          ? ""
          : options.find((option) => option.value === reported)?.label ?? "",
      );
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("pointercancel", onDocPointerCancel);
    document.addEventListener("click", onDocClick);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("pointercancel", onDocPointerCancel);
      document.removeEventListener("click", onDocClick);
    };
  }, [open, options]);

  const normalized = query.trim().toLowerCase();
  const matches = (option: PickerOption): boolean => matchesQuery(option, normalized);
  const visible = visibleOptions(options, query);
  const visibleCount = visible.length;

  /** Reports the pick to the parent without touching the listbox state. */
  function report(option: PickerOption): void {
    reportedRef.current = option.value;
    setQuery(option.label);
    onChange(option.value);
  }

  function pick(option: PickerOption): void {
    report(option);
    setOpen(false);
    setActiveIndex(null);
  }

  /** Index of the next visible option in the arrow-key direction. */
  function step(from: number | null, direction: 1 | -1): number {
    const indices = options
      .map((option, index) => (matches(option) ? index : -1))
      .filter((index) => index >= 0);
    if (indices.length === 0) return -1;
    if (from === null) {
      return direction === 1 ? indices[0]! : indices[indices.length - 1]!;
    }
    const position = indices.indexOf(from);
    if (position === -1) return indices[0]!;
    // Wraps at the ends, so Down from the last match returns to the first
    // (the listbox navigation convention).
    const nextPosition =
      direction === 1
        ? (position + 1) % indices.length
        : (position - 1 + indices.length) % indices.length;
    return indices[nextPosition]!;
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = step(activeIndex, event.key === "ArrowDown" ? 1 : -1);
      if (next < 0) return;
      setOpen(true);
      setActiveIndex(next);
    } else if (event.key === "Enter") {
      if (!open) return;
      event.preventDefault();
      const active = activeIndex !== null ? options[activeIndex] : undefined;
      const target =
        active && matches(active) ? active : visibleCount === 1 ? visible[0]! : undefined;
      if (target) pick(target);
    } else if (event.key === "Escape") {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
      setActiveIndex(null);
      setQuery(selected?.label ?? "");
    }
  }

  return (
    <div ref={rootRef} className="flex flex-col gap-1.5" data-state-picker={id}>
      <div className="relative">
        <input
          type="text"
          id={`${id}-input`}
          data-state-picker-input
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-listbox`}
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeIndex !== null
              ? `${id}-opt-${options[activeIndex]!.value}`
              : undefined
          }
          aria-describedby={describedBy}
          autoComplete="off"
          placeholder="Type to filter (for example, North)"
          value={query}
          disabled={disabled}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(null);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setActiveIndex(null);
            // HACK-164: losing focus commits the typed input — the blur a
            // Continue press causes included — so typing the full state
            // name and pressing Continue picks it instead of showing the
            // needed-to-continue error. Without a commit, the existing
            // blur reset still yields the input to the picked label.
            // While a POINTER press is in flight, though, neither the
            // close nor the reset may happen here: with an in-flow list,
            // both reflow the page between the press's mousedown and its
            // click and the press lands on whatever shifted under the
            // pointer. The press's own click closes the list and yields
            // the query after it has landed (the outside-click close).
            const candidate = commitCandidate(options, query);
            if (pressingRef.current) {
              if (candidate && candidate.value !== value) {
                report(candidate);
              } else if (candidate) {
                setQuery(candidate.label);
              }
              return;
            }
            setOpen(false);
            if (candidate) {
              if (candidate.value === value) {
                setQuery(candidate.label);
              } else {
                report(candidate);
              }
              return;
            }
            setQuery(selected?.label ?? "");
          }}
          className="min-h-11 w-full rounded-xl border border-surface-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted"
        />
        {/* All options stay mounted; non-matching ones display-none so the
          list stays compact while filtering and nothing is ever lost. The
          mousedown is prevented so a click keeps the input's focus (the
          combobox's own blur would close the list first). The list renders
          IN FLOW (HACK-164 follow-up): it pushes the chip, a visible
          error, and the controls below down instead of floating over them,
          so a click aimed at a covered control can never land on an
          option. The reflow that closing now causes is kept out of any
          press: the blur neither closes nor resets mid-press, and the
          close happens on a click after it has landed (see the effect and
          onBlur above). */}
        <ul
          id={`${id}-listbox`}
          role="listbox"
          aria-label="States"
          className={`max-h-60 overflow-y-auto rounded-xl border border-surface-border bg-surface shadow-lg ${open ? "" : "hidden"}`}
          onMouseDown={(event) => event.preventDefault()}
        >
          {options.map((option) => {
            const visibleOption = matches(option);
            return (
              <li
                key={option.value}
                id={`${id}-opt-${option.value}`}
                role="option"
                aria-selected={option.value === value}
                data-state-picker-option={option.value}
                className={`min-h-11 items-center px-3 py-2 text-base text-foreground hover:bg-teal-soft aria-selected:bg-teal-soft ${visibleOption ? "flex" : "hidden"}`}
                onClick={() => {
                  if (!disabled) pick(option);
                }}
              >
                {option.label}
              </li>
            );
          })}
        </ul>
      </div>
      <p data-state-picker-selected className="text-sm text-muted">
        {selected ? `Picked: ${selected.label}` : "No state picked yet"}
      </p>
      {open && visibleCount === 0 ? (
        <p data-state-picker-no-match className="text-sm text-muted">
          No states match that spelling — try fewer letters.
        </p>
      ) : null}
      <p data-state-picker-count aria-live="polite" className="sr-only">
        {open ? `${visibleCount} of ${options.length} states match` : ""}
      </p>
    </div>
  );
}
