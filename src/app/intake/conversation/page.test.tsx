import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ConversationPage from "./page";

// The conversational page shell (Mission v2 M2): voice controls and the
// typed fallback mount together in the same view (VAL-VOICE-005), with the
// accessibility baseline intact.

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
}

describe("Conversation page shell", () => {
  it("renders exactly one h1 and mounts the voice + typed controls", () => {
    const html = renderToStaticMarkup(<ConversationPage />);
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    expect(html).toContain("data-conversation-chat");
    // The mic toggle and the typed textarea share the same view.
    expect(html).toContain("data-voice-toggle");
    expect(html).toContain('id="conversation-input"');
  });

  it("links to the step-by-step page that keeps answers only on this device (HACK-99)", () => {
    const html = renderToStaticMarkup(<ConversationPage />);
    const link = html.match(/<a[^>]*href="([^"]*)"[^>]*>Use the wizard instead<\/a>/);
    expect(link?.[1]).toBe("/intake");
    // The sentence after the link describes that page; intake/page.test.tsx
    // pins that /intake runs the wizard in device mode.
    expect(html).toContain("It keeps answers only on this device");
  });

  it("shows the consent surface before any send, sends disabled until decided (VAL-CONSENT-002)", () => {
    const html = renderToStaticMarkup(<ConversationPage />);
    expect(html).toContain("data-consent-surface");
    // The honest first paint: nothing can be sent before a choice exists.
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toMatch(/data-voice-toggle[^>]*disabled/);
    expect(html).not.toMatch(/data-mic-blocked-guidance/);
  });

  it("keeps a hierarchical heading outline", () => {
    const levels = headingLevels(renderToStaticMarkup(<ConversationPage />));
    expect(levels.length).toBeGreaterThan(0);
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i], `heading ${i + 1} skips a level`).toBeLessThanOrEqual(
        levels[i - 1] + 1,
      );
    }
  });

  it("does not show mic-denied guidance before an actual failure", () => {
    const html = renderToStaticMarkup(<ConversationPage />);
    expect(html).not.toContain("data-mic-blocked-guidance");
  });
});
