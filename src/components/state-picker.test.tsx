// @vitest-environment jsdom
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StatePicker,
  commitCandidate,
  matchesQuery,
  visibleOptions,
  type PickerOption,
} from "./state-picker";

// Interaction tests for the compact state picker (HACK-142, VAL-PICK-001):
// one type-to-filter combobox replaces the 50-radio page. The contract:
// WAI-ARIA combobox semantics, full keyboard operation, every valid option
// stays available (collapsed or filtered), and the reported value is the
// spec's own option value so the existing tri-state answer route and its
// validation are untouched.

const STATES: PickerOption[] = [
  { value: "AL", label: "Alabama" },
  { value: "NC", label: "North Carolina" },
  { value: "ND", label: "North Dakota" },
  { value: "SC", label: "South Carolina" },
];

type PickerProps = Parameters<typeof StatePicker>[0];

describe("StatePicker (HACK-142)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    onChange = vi.fn();
  });

  afterEach(() => {
    if (root) {
      root.unmount();
      root = null;
    }
    document.body.replaceChildren();
  });

  async function renderPicker(
    props?: Partial<PickerProps>,
  ): Promise<{
    rerender: (next: Partial<PickerProps>) => Promise<void>;
    act: (fn: () => void) => Promise<void>;
  }> {
    const rootInstance = createRoot(container);
    root = rootInstance;
    const act = async (fn: () => void) => {
      await React.act(async () => {
        fn();
        for (let i = 0; i < 4; i += 1) {
          await new Promise((done) => setTimeout(done, 0));
        }
      });
    };
    await act(() => {
      rootInstance.render(
        <StatePicker
          id="state-picker"
          options={STATES}
          onChange={onChange}
          {...props}
        />,
      );
    });
    return {
      act,
      rerender: async (next: Partial<PickerProps>) => {
        await act(() => {
          rootInstance.render(
            <StatePicker
              id="state-picker"
              options={STATES}
              onChange={onChange}
              {...props}
              {...next}
            />,
          );
        });
      },
    };
  }

  const input = (): HTMLInputElement =>
    container.querySelector('[role="combobox"]') as HTMLInputElement;
  const listbox = (): HTMLUListElement =>
    container.querySelector('[role="listbox"]') as HTMLUListElement;
  const options = (): NodeListOf<Element> =>
    container.querySelectorAll('[role="option"]');
  const visibleOptions = (): Element[] =>
    [...options()].filter(
      (option) => !(option as HTMLElement).className.includes("hidden"),
    );
  const chip = (): string =>
    container.querySelector("[data-state-picker-selected]")?.textContent ?? "";
  const type = (text: string): void => {
    const target = input();
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(target, text);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const key = (key: string): void => {
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true }),
    );
  };
  /** Key press wrapped in act, so the re-render flushes before asserting. */
  const pressKey = async (keyName: string): Promise<void> => {
    await React.act(async () => {
      key(keyName);
      await new Promise((done) => setTimeout(done, 0));
    });
  };

  it("collapses to one input by default while every valid option stays in the DOM", async () => {
    await renderPicker();
    expect(input()).not.toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    // Collapsed: the listbox is display-none, yet all four options remain
    // present (so "keeps every valid option" holds and the SSR option scan
    // sees every label).
    expect(listbox().className).toContain("hidden");
    expect(options()).toHaveLength(STATES.length);
    // The selection is announced in text, not implied by a long list.
    expect(chip()).toContain("No state picked yet");
  });

  it("opens and filters as the person types (type-to-filter)", async () => {
    await renderPicker();
    type("caro");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(visibleOptions().map((option) => option.textContent)).toEqual([
      "North Carolina",
      "South Carolina",
    ]);
    expect(listbox().className).not.toContain("hidden");
  });

  it("picks the active option with ArrowDown + Enter and reports the spec's option value", async () => {
    const { act, rerender } = await renderPicker();
    await act(() => type("caro"));
    await pressKey("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(
      "state-picker-opt-NC",
    );
    await pressKey("Enter");
    expect(onChange).toHaveBeenCalledWith("NC");
    // Picked: the list closes, the input shows the label. The parent
    // stores the draft, so it re-renders with the picked value (the chip
    // reads the value prop — the controlled-parent update).
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().value).toBe("North Carolina");
    await rerender({ value: "NC" });
    expect(chip()).toContain("Picked: North Carolina");
  });

  it("moves the active option with the arrows (up from the start lands on the last match)", async () => {
    const { act } = await renderPicker();
    await act(() => type("caro"));
    await pressKey("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).toBe(
      "state-picker-opt-SC",
    );
    await pressKey("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(
      "state-picker-opt-NC",
    );
  });

  it("picks a unique filter match with Enter alone", async () => {
    const { act } = await renderPicker();
    await act(() => type("alabam"));
    expect(visibleOptions()).toHaveLength(1);
    await pressKey("Enter");
    expect(onChange).toHaveBeenCalledWith("AL");
  });

  it("closes on Escape and restores the picked label", async () => {
    const { act } = await renderPicker({ value: "NC" });
    await act(() => type("caro"));
    await pressKey("Escape");
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().value).toBe("North Carolina");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("picks with a click and keeps all options reachable afterwards", async () => {
    const { act, rerender } = await renderPicker();
    await act(() => type("caro"));
    await act(() => {
      (visibleOptions()[1] as HTMLElement).click();
    });
    expect(onChange).toHaveBeenCalledWith("SC");
    await rerender({ value: "SC" });
    expect(chip()).toContain("Picked: South Carolina");
    // Clearing the filter brings every option back (nothing was lost).
    await act(() => type(""));
    expect(visibleOptions()).toHaveLength(STATES.length);
  });

  it("shows the stored answer's label and marks it selected", async () => {
    await renderPicker({ value: "SC" });
    expect(input().value).toBe("South Carolina");
    expect(chip()).toContain("Picked: South Carolina");
    const picked = container.querySelector('[role="option"][aria-selected="true"]');
    expect(picked?.getAttribute("data-state-picker-option")).toBe("SC");
  });

  it("syncs the visible label when the value changes from outside", async () => {
    const { rerender } = await renderPicker();
    expect(chip()).toContain("No state picked yet");
    await rerender({ value: "ND" });
    expect(chip()).toContain("Picked: North Dakota");
    expect(input().value).toBe("North Dakota");
  });

  it("says when nothing matches instead of leaving a silent empty list", async () => {
    const { act } = await renderPicker();
    await act(() => type("zzz"));
    expect(container.querySelector("[data-state-picker-no-match]")).not.toBeNull();
    expect(container.querySelector("[data-state-picker-count]")?.textContent).toContain(
      "0 of 4",
    );
    // Enter with no match never invents a pick.
    key("Enter");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("announces the match count to screen readers while filtering", async () => {
    const { act } = await renderPicker();
    await act(() => type("caro"));
    const count = container.querySelector("[data-state-picker-count]");
    expect(count?.getAttribute("aria-live")).toBe("polite");
    expect(count?.textContent).toContain("2 of 4");
  });

  it("carries the help/error wiring on the input", async () => {
    await renderPicker({ describedBy: "state-help state-error" });
    expect(input().getAttribute("aria-describedby")).toBe("state-help state-error");
  });

  it("disables the input when the parent is busy", async () => {
    await renderPicker({ disabled: true });
    expect(input().disabled).toBe(true);
  });

  // HACK-164 (VAL-UX-001): typing the full state name and pressing
  // Continue used to show the needed-to-continue error, because typing
  // only filtered. The blur a Continue press causes now commits the
  // typed input: the exact (case-insensitive) match, or the only match
  // left. The Enter and click pick paths above stay untouched.
  describe("typed-input commit on blur (HACK-164)", () => {
    /** Blur wrapped in act, so the commit's re-render flushes before asserting. */
    const blurInput = async (): Promise<void> => {
      await React.act(async () => {
        input().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
        await new Promise((done) => setTimeout(done, 0));
      });
    };

    it("commits the typed full name on blur — the blur a Continue press causes picks it", async () => {
      const { act, rerender } = await renderPicker();
      await act(() => type("north carolina"));
      await blurInput();
      expect(onChange).toHaveBeenCalledWith("NC");
      expect(input().value).toBe("North Carolina");
      await rerender({ value: "NC" });
      expect(chip()).toContain("Picked: North Carolina");
    });

    it("commits the only remaining match on blur, even though nothing was typed exactly", async () => {
      const { act } = await renderPicker();
      await act(() => type("alabam"));
      await blurInput();
      expect(onChange).toHaveBeenCalledWith("AL");
    });

    it("prefers the exact case-insensitive match when several options filter-match", async () => {
      const { act } = await renderPicker();
      await act(() => type("SOUTH CAROLINA"));
      await blurInput();
      expect(onChange).toHaveBeenCalledWith("SC");
      expect(input().value).toBe("South Carolina");
    });

    it("commits the value code typed exactly", async () => {
      const { act } = await renderPicker();
      await act(() => type("nc"));
      await blurInput();
      expect(onChange).toHaveBeenCalledWith("NC");
    });

    it("leaves an ambiguous query unpicked on blur and keeps the reset behavior", async () => {
      const { act } = await renderPicker();
      await act(() => type("north"));
      await blurInput();
      expect(onChange).not.toHaveBeenCalled();
      expect(chip()).toContain("No state picked yet");
      // The existing blur reset (the query yields to the picked label)
      // still holds when nothing committed.
      expect(input().value).toBe("");
    });

    it("leaves a zero-match query unpicked on blur", async () => {
      const { act } = await renderPicker();
      await act(() => type("zzz"));
      await blurInput();
      expect(onChange).not.toHaveBeenCalled();
      expect(chip()).toContain("No state picked yet");
    });

    it("does not re-report an already-picked value on blur", async () => {
      const { act } = await renderPicker({ value: "NC" });
      await act(() => type("north carolina"));
      await blurInput();
      expect(onChange).not.toHaveBeenCalled();
      expect(input().value).toBe("North Carolina");
      expect(chip()).toContain("Picked: North Carolina");
    });
  });
});

describe("StatePicker filter properties (fast-check)", () => {
  // Arbitrary option lists: a short code plus a label, in a stable order.
  const optionLists = fc
    .array(
      fc.tuple(
        fc.string({ minLength: 2, maxLength: 3 }).filter((value) => value.toLowerCase() !== value.toUpperCase()),
        fc.string({ minLength: 2, maxLength: 20 }).filter((label) => !label.includes("\u0000")),
      ),
      { maxLength: 25 },
    )
    .map((tuples) =>
      tuples.map(([value, label], index) => ({
        value: `${value}${index}`,
        label: `${label} ${index}`,
      })),
    );
  const queries = fc.string({ maxLength: 12 }).filter(
    (query) => !query.includes("\u0000"),
  );

  it("filtering never invents an option and never reorders the spec's list (only real options are pickable)", () => {
    fc.assert(
      fc.property(optionLists, queries, (options, query) => {
        const visible = visibleOptions(options, query);
        // Every visible option IS one of the spec's options — the picker
        // can never offer, pick, or save a value outside the spec (so the
        // answer route's option validation always holds).
        expect(visible.every((option) => options.includes(option))).toBe(true);
        // The visible list is a subsequence in spec order — the listbox
        // never jumps around as the person filters.
        let cursor = 0;
        for (const option of visible) {
          const found = options.findIndex(
            (candidate, index) => index >= cursor && candidate.value === option.value,
          );
          expect(found).toBeGreaterThanOrEqual(0);
          cursor = found + 1;
        }
      }),
    );
  });

  it("the empty query shows every option, and any option stays pickable via its own label in any case", () => {
    fc.assert(
      fc.property(optionLists, (options) => {
        // Whitespace-only queries show the whole list.
        expect(visibleOptions(options, " \t ")).toEqual(options);
        expect(visibleOptions(options, "")).toEqual(options);
        // Filtering by an option's own label (upper- or lower-cased)
        // always keeps that option pickable — a person who types the full
        // state name can always select it.
        for (const option of options) {
          expect(visibleOptions(options, option.label.toUpperCase())).toContain(option);
          expect(visibleOptions(options, option.label.toLowerCase())).toContain(option);
        }
      }),
    );
  });
});

describe("StatePicker commit properties (fast-check, HACK-164)", () => {
  // The same option-list arbitrary as the filter properties above.
  const optionLists = fc
    .array(
      fc.tuple(
        fc.string({ minLength: 2, maxLength: 3 }).filter((value) => value.toLowerCase() !== value.toUpperCase()),
        fc.string({ minLength: 2, maxLength: 20 }).filter((label) => !label.includes("\u0000")),
      ),
      { maxLength: 25 },
    )
    .map((tuples) =>
      tuples.map(([value, label], index) => ({
        value: `${value}${index}`,
        label: `${label} ${index}`,
      })),
    );
  const queries = fc.string({ maxLength: 12 }).filter(
    (query) => !query.includes("\u0000"),
  );

  it("the commit never invents an option: it is a real option, and only an exact or unique match", () => {
    fc.assert(
      fc.property(optionLists, queries, (options, query) => {
        const candidate = commitCandidate(options, query);
        if (candidate === undefined) {
          return;
        }
        // The committed value is one of the spec's own options — the
        // answer route's option validation always holds.
        expect(options.includes(candidate)).toBe(true);
        const normalized = query.trim().toLowerCase();
        const exact = options.filter(
          (option) =>
            option.label.toLowerCase() === normalized ||
            option.value.toLowerCase() === normalized,
        );
        if (exact.length > 0) {
          // An exact match wins, and only when one really exists.
          expect(
            exact.some((option) => option.value === candidate.value),
          ).toBe(true);
        } else {
          // Without an exact match, the commit is the ONLY filter match.
          const matches = options.filter((option) =>
            matchesQuery(option, normalized),
          );
          expect(matches).toHaveLength(1);
          expect(matches[0]!.value).toBe(candidate.value);
        }
      }),
    );
  });

  it("an option's own name, typed in any case, always commits to it — Continue never dead-ends on a correctly typed name", () => {
    fc.assert(
      fc.property(optionLists, fc.constantFrom("lower", "upper"), (options, casing) => {
        for (const option of options) {
          const typed =
            casing === "lower"
              ? option.label.toLowerCase()
              : option.label.toUpperCase();
          expect(commitCandidate(options, typed)?.value).toBe(option.value);
        }
      }),
    );
  });

  it("an ambiguous query with no exact match never commits (typing cannot sneak a pick past the person)", () => {
    fc.assert(
      fc.property(optionLists, queries, (options, query) => {
        const normalized = query.trim().toLowerCase();
        const exact = options.some(
          (option) =>
            option.label.toLowerCase() === normalized ||
            option.value.toLowerCase() === normalized,
        );
        if (exact || normalized === "") {
          return;
        }
        const matches = options.filter((option) =>
          matchesQuery(option, normalized),
        );
        if (matches.length !== 1) {
          expect(commitCandidate(options, query)).toBeUndefined();
        }
      }),
    );
  });
});
