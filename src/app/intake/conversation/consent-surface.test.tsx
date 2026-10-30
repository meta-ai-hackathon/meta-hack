import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CONSENT_PATHS, type ConsentPathSpec } from "../../../lib/consent";
import { ConsentPanel, ConsentReceiptPanel } from "./consent-surface";

// Consent surface tests (Mission v2.1 M5, VAL-CONSENT-002/004): the copy
// names what leaves the device, to which provider, for what purpose, offers
// the zero-send alternative, links the verified vendor terms, and a path
// whose terms are NOT verified renders its toggle disabled with honest copy.

/** React escapes text entities in static markup; decode for copy matching. */
function textOf(html: string): string {
  return html
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

function panelMarkup(overrides: Partial<Parameters<typeof ConsentPanel>[0]> = {}) {
  return textOf(
    renderToStaticMarkup(
      <ConsentPanel
        aiChecked={false}
        voiceChecked={false}
        paths={CONSENT_PATHS}
        onToggleAi={() => undefined}
        onToggleVoice={() => undefined}
        onDecide={() => undefined}
        onDecline={() => undefined}
        {...overrides}
      />,
    ),
  );
}

describe("ConsentPanel copy (VAL-CONSENT-002)", () => {
  it("is shown before anything is sent, in plain language", () => {
    const html = panelMarkup();
    expect(html).toContain("data-consent-surface");
    expect(html).toMatch(/Before anything is sent/);
  });

  it("names the providers: Meta (chat + speech-to-text) and Gemini (text-to-speech)", () => {
    const html = panelMarkup();
    expect(html).toMatch(/Meta/);
    expect(html).toMatch(/Gemini/);
    expect(html).toMatch(/speech-to-text/);
    expect(html).toMatch(/text-to-speech/);
  });

  it("names what each send is for", () => {
    const html = panelMarkup();
    expect(html).toMatch(/understand your answer/);
    expect(html).toMatch(/turn your speech into text/);
    expect(html).toMatch(/read the assistant's replies aloud/);
  });

  it("links the verified vendor terms on every consented path", () => {
    const html = panelMarkup();
    for (const terms of CONSENT_PATHS.flatMap((path) => path.terms)) {
      expect(html).toContain(`href="${terms.url}"`);
      expect(html).toContain(terms.label);
    }
  });

  it("offers the zero-send alternative: the step-by-step form sends nothing", () => {
    const html = panelMarkup();
    expect(html).toContain("data-consent-decline");
    expect(html).toMatch(/step-by-step form/);
    expect(html).toMatch(/nothing is sent anywhere/i);
  });

  it("is honest about the one call that sees raw words before redaction", () => {
    const html = panelMarkup();
    // The extraction step reads the typed sentence BEFORE anything is
    // hidden — the gate discloses that send rather than denying it.
    expect(html).toMatch(/sees your words before anything is hidden/);
  });

  it("says the choice is per device and revocable", () => {
    const html = panelMarkup();
    expect(html).toMatch(/on this device/);
    expect(html).toMatch(/change (this )?at any time/i);
  });
});

describe("ConsentPanel disabled toggles (VAL-CONSENT-004)", () => {
  it("keeps voice disabled until AI sharing is on (its own additional toggle)", () => {
    const html = panelMarkup({ aiChecked: false });
    expect(html).toContain("data-consent-voice-toggle");
    expect(html).toMatch(/disabled/);
    expect(html).toMatch(/Turn on sharing of typed answers first/);
  });

  it("renders an unverified path disabled with honest copy — the fixture", () => {
    const unverifiedVoice: ConsentPathSpec[] = CONSENT_PATHS.map((path) =>
      path.id === "voice" ? { ...path, termsVerified: false } : path,
    );
    const html = panelMarkup({
      paths: unverifiedVoice,
      aiChecked: true,
      voiceChecked: false,
    });
    expect(html).toMatch(/data-consent-voice-toggle[^>]*disabled/);
    expect(html).toMatch(/data-honest-unverified-copy/);
    expect(html).toMatch(/haven't verified/);
    expect(html).toMatch(/stays off/);
  });

  it("never pre-checks a toggle for the user", () => {
    const html = panelMarkup();
    expect(html).not.toMatch(/data-consent-ai-toggle[^>]*checked/);
    expect(html).not.toMatch(/data-consent-voice-toggle[^>]*checked/);
  });
});

describe("ConsentReceiptPanel — inspectable and revocable", () => {
  it("shows the recorded decision and how to take it back", () => {
    const html = textOf(
      renderToStaticMarkup(
        <ConsentReceiptPanel
          receipt={{ v: 1, ai: true, voice: false, at: "2026-10-30T12:00:00.000Z" }}
          onRevoke={() => undefined}
          onReopen={() => undefined}
        />,
      ),
    );
    expect(html).toContain("data-consent-receipt");
    expect(html).toMatch(/Sharing what you type with the assistant is: on/);
    expect(html).toMatch(/Voice sharing is: off/);
    expect(html).toContain("data-consent-revoke");
    expect(html).toContain("data-consent-reopen");
    // Inspectable: the raw receipt is readable, and it carries no answer
    // data of any kind — only the sharing decision itself.
    expect(html).toContain("data-consent-receipt-json");
    expect(html).toContain('"ai":true');
    expect(html.toLowerCase()).not.toContain("answer");
  });
});
