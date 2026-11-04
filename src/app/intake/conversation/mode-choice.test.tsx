// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../../../lib/honesty";
import { EntryBegin, ModeChoice, type ConversationEntryMode } from "./mode-choice";

// The entry mode choice (HACK-106 natural conversation, VAL-NCF-002): a
// calm choice moment with EXACTLY TWO voice entry modes — (A) talk the
// whole way, (B) talk with typing available at any point. Rendered only
// for a voice-consented visitor (the parent gates it); this test pins the
// structure, the copy, and the honest-subtitles trust line.

describe("the conversation entry mode choice (VAL-NCF-002)", () => {
  it("offers exactly the two entry modes as a radio group", () => {
    const html = renderToStaticMarkup(
      <ModeChoice onBegin={() => undefined} />,
    );
    expect(html).toContain('data-mode-option="voice-only"');
    expect(html).toContain('data-mode-option="voice-plus-typing"');
    // Exactly two options, sharing one radio group name.
    const radios = html.match(/type="radio"/g) ?? [];
    expect(radios).toHaveLength(2);
    expect(html.match(/name="conversation-entry-mode"/g) ?? []).toHaveLength(2);
  });

  it("defaults to the mode that keeps typing available (the design frame's selection)", () => {
    const html = renderToStaticMarkup(
      <ModeChoice onBegin={() => undefined} />,
    );
    // The radio INPUT's checked attribute decides — the label's
    // has-[:checked] utility class contains the word "checked" too, so
    // match the input element itself.
    function radioFor(mode: string): string | undefined {
      const label = html.match(
        new RegExp(`<label[^>]*data-mode-option="${mode}"[^>]*>[\\s\\S]*?</label>`),
      );
      return label?.[0].match(/<input[^>]*>/)?.[0];
    }
    expect(radioFor("voice-plus-typing") ?? "").toContain("checked");
    expect(radioFor("voice-only") ?? "").not.toContain(" checked");
  });

  it("carries the calm-choice copy and the always-subtitles trust line", () => {
    const html = renderToStaticMarkup(
      <ModeChoice onBegin={() => undefined} />,
    );
    expect(html).toContain("How would you like to talk?");
    expect(html).toContain("Talk the whole way");
    expect(html).toContain("Talk, with typing anytime");
    expect(html).toContain("Live subtitles are always here.");
    expect(html).toContain("data-mode-begin");
  });

  it("carries the brand mark per the approved entry frame (VAL-VJS-001)", () => {
    const html = renderToStaticMarkup(
      <ModeChoice onBegin={() => undefined} />,
    );
    // The waveform brand mark is decorative: aria-hidden, never a heading,
    // states conveyed by the real copy around it.
    expect(html).toContain("data-brand-wave");
    expect(html).toContain('aria-hidden="true"');
  });

  it("keeps the entry copy banned-claim clean", () => {
    const html = renderToStaticMarkup(
      <ModeChoice onBegin={() => undefined} />,
    );
    expect(findBannedClaims(html)).toEqual([]);
  });
});

// The carried mode suggestion (VAL-FIX-003): the home shell's mode choice
// lands here as a PRESELECTION. It applies after paint (storage is
// client-only), so the preselection must update via effect — never a
// hydration mismatch on the radio.
describe("the carried mode suggestion", () => {
  it("preselects the suggested mode once mounted", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(
        React.createElement(ModeChoice, {
          onBegin: () => undefined,
          suggestedMode: "voice-only",
        }),
      );
    });
    await React.act(async () => undefined);
    function radioFor(mode: string): HTMLInputElement | null {
      const label = container.querySelector(
        `label[data-mode-option="${mode}"]`,
      );
      return label?.querySelector("input") ?? null;
    }
    // Controlled radios carry the selection as the DOM property (React
    // writes the property after mount, not the serialized attribute).
    expect(radioFor("voice-only")?.checked).toBe(true);
    expect(radioFor("voice-plus-typing")?.checked).toBe(false);
    root.unmount();
    container.remove();
  });
});

// The carried-mode begin surface (HACK-157, VAL-UX-002): when the home
// page already picked the mode, the conversation's entry stage shows ONE
// begin control — never the same mode question a second time — with a
// small link that brings the full choice back.
describe("the carried-mode begin surface (HACK-157)", () => {
  it("names the carried mode and shows one start control plus the change link", () => {
    const html = renderToStaticMarkup(
      <EntryBegin
        mode="voice-only"
        onBegin={() => undefined}
        onChangeMode={() => undefined}
      />,
    );
    expect(html).toContain("data-entry-begin");
    expect(html).toContain("You picked Talk the whole way on the home page.");
    expect(html).toContain("Start talking");
    expect(html).toContain("data-entry-begin-start");
    expect(html).toContain("data-entry-begin-change");
    expect(html).toContain("Change the mode");
    // It never re-asks the mode question.
    expect(html).not.toContain("How would you like to talk?");
    expect(html).not.toContain('name="conversation-entry-mode"');
  });

  it("names the typing-available mode the same way", () => {
    const html = renderToStaticMarkup(
      <EntryBegin
        mode="voice-plus-typing"
        onBegin={() => undefined}
        onChangeMode={() => undefined}
      />,
    );
    expect(html).toContain(
      "You picked Talk, with typing anytime on the home page.",
    );
  });

  it("keeps the begin copy banned-claim clean", () => {
    const html = renderToStaticMarkup(
      <EntryBegin
        mode="voice-only"
        onBegin={() => undefined}
        onChangeMode={() => undefined}
      />,
    );
    expect(findBannedClaims(html)).toEqual([]);
  });

  it("begins with the carried mode, and the change link hands over to the full choice", async () => {
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const begun: string[] = [];
    let changed = false;
    await React.act(async () => {
      root.render(
        React.createElement(EntryBegin, {
          mode: "voice-plus-typing",
          onBegin: (mode: ConversationEntryMode) => begun.push(mode),
          onChangeMode: () => {
            changed = true;
          },
        }),
      );
    });
    await React.act(async () => {
      container
        .querySelector("[data-entry-begin-start]")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(begun).toEqual(["voice-plus-typing"]);
    await React.act(async () => {
      container
        .querySelector("[data-entry-begin-change]")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(changed).toBe(true);
    root.unmount();
    container.remove();
  });
});
