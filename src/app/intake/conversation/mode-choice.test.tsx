import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../../../lib/honesty";
import { ModeChoice } from "./mode-choice";

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
