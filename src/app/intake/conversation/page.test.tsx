import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ConversationPage from "./page";

// The conversational page shell (Mission v2 M2; rebuilt for the HACK-106
// natural-conversation milestone). The honest FIRST paint is the consent
// surface alone — nothing sendable is even mounted before the sharing
// decision (VAL-CONSENT-002). After the decision, the two-mode entry
// (VAL-NCF-002) mounts the voice session; the typed path mounts for the
// typing-available mode, the ai-only path, and mic fallbacks — it no
// longer rides disabled on the consent paint, because the entry mode
// choice supersedes the always-mounted controls (VAL-VOICE-005 as
// deepened by VAL-NCF-002).

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
}

describe("Conversation page shell", () => {
  it("renders exactly one h1 and mounts the chat shell", () => {
    const html = renderToStaticMarkup(<ConversationPage />);
    expect((html.match(/<h1[\s>]/g) ?? []).length).toBe(1);
    expect(html).toContain("data-conversation-chat");
  });

  it("links to the step-by-step page that keeps answers only on this device (HACK-99)", () => {
    const html = renderToStaticMarkup(<ConversationPage />);
    const link = html.match(/<a[^>]*href="([^"]*)"[^>]*>Use the wizard instead<\/a>/);
    expect(link?.[1]).toBe("/intake");
    // The sentence after the link describes that page; intake/page.test.tsx
    // pins that /intake runs the wizard in device mode.
    expect(html).toContain("It keeps answers only on this device");
  });

  it("shows the consent surface before any send, mounting nothing sendable before the decision (VAL-CONSENT-002)", () => {
    const html = renderToStaticMarkup(<ConversationPage />);
    expect(html).toContain("data-consent-surface");
    // Stronger than the old disabled-controls paint: before the sharing
    // decision there is no input to send from at all.
    expect(html).not.toMatch(/<textarea/);
    expect(html).not.toMatch(/data-mode-choice/);
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
