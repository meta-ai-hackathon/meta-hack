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
 * label — then the value code — else the one option the query still
 * filters to. An ambiguous or zero-match query commits nothing, so
 * Continue keeps its needed-to-continue gate for genuinely missing
 * answers.
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
  const exactValue = options.find(
    (option) => option.value.toLowerCase() === normalized,
  );
  if (exactValue) return exactValue;
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

  useEffect(() => {
    if (value === reportedRef.current) return;
    reportedRef.current = value;
    setQuery(options.find((option) => option.value === value)?.label ?? "");
    // The option list is stable per question; only an external value
    // change needs to resync the display.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const normalized = query.trim().toLowerCase();
  const matches = (option: PickerOption): boolean => matchesQuery(option, normalized);
  const visible = visibleOptions(options, query);
  const visibleCount = visible.length;

  function pick(option: PickerOption): void {
    reportedRef.current = option.value;
    setQuery(option.label);
    setOpen(false);
    setActiveIndex(null);
    onChange(option.value);
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
    <div className="flex flex-col gap-1.5" data-state-picker={id}>
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
            setOpen(false);
            setActiveIndex(null);
            // HACK-164: losing focus commits the typed input — the blur a
            // Continue press causes included — so typing the full state
            // name and pressing Continue picks it instead of showing the
            // needed-to-continue error. Without a commit, the existing
            // blur reset still yields the input to the picked label.
            const candidate = commitCandidate(options, query);
            if (candidate) {
              if (candidate.value === value) {
                setQuery(candidate.label);
              } else {
                pick(candidate);
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
          combobox's own blur would close the list first). The list floats
          over what is below instead of pushing it down (HACK-164): an
          inline list reflows the page when the blur-commit closes it, and
          that reflow moves the Continue button between the press's
          mousedown and its click — the click lands on nothing. Floating,
          the controls below never move, so the press both picks and
          advances. */}
        <ul
          id={`${id}-listbox`}
          role="listbox"
          aria-label="States"
          className={`absolute inset-x-0 top-full z-10 max-h-60 overflow-y-auto rounded-xl border border-surface-border bg-surface shadow-lg ${open ? "" : "hidden"}`}
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
