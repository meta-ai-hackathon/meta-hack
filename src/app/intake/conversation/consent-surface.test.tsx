import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CONSENT_PATHS,
  CONSENT_PROVIDER_ID,
  parseConsentReceipt,
  type ConsentPathSpec,
  type ConsentReceipt,
} from "../../../lib/consent";
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

  it("names the providers: Meta (chat + speech-to-text) and ElevenLabs (text-to-speech)", () => {
    const html = panelMarkup();
    expect(html).toMatch(/Meta/);
    expect(html).toMatch(/ElevenLabs/);
    expect(html).toMatch(/speech-to-text/);
    expect(html).toMatch(/text-to-speech/);
  });

  it("renders the voice-path provider string EXACTLY as registered (VAL-TTS2-003 drift test)", () => {
    // The spoken-reply provider naming must match the CONSENT_PATHS
    // registry verbatim: if the surface copy drifts from the enforcement
    // registry (or the registry is edited without the surface), this
    // fails. The registered string names Meta (STT) and ElevenLabs (TTS) —
    // verified accurate against the shipped TTS client after the
    // owner-directed Gemini → ElevenLabs switch (HACK-116, 2026-10-31:
    // the Gemini free tier's 10-requests/day quota caused the silent OS-
    // voice fallback); terms verified live at elevenlabs.io/terms.
    const voicePath = CONSENT_PATHS.find((path) => path.id === "voice");
    expect(voicePath).toBeDefined();
    expect(panelMarkup()).toContain(voicePath!.provider);
    expect(voicePath!.provider).toContain("ElevenLabs");
    expect(voicePath!.provider).toContain("Meta");
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

  it("wraps each toggle row so the switch and its copy stack at 250% text (HACK-155)", () => {
    // At 375 px and 250% the one-line switch+copy row is wider than the
    // panel; without wrapping, both consent rows spilled past the
    // viewport. Each row wraps so the copy drops under its switch.
    const html = panelMarkup();
    const rows = html.match(/class="flex flex-wrap items-start gap-x-2[^"]*"/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("offers the zero-send alternative: the step-by-step form reaches no AI provider", () => {
    const html = panelMarkup();
    expect(html).toContain("data-consent-decline");
    expect(html).toMatch(/step-by-step form/);
    // Honest about the two planes: no AI provider receives anything, and
    // answers still save on the app's own server (never claimed otherwise).
    expect(html).toMatch(/no AI provider receives anything/i);
    expect(html).toMatch(/answers save on the app's server/i);
  });

  it("is honest about the one call that sees raw words before redaction", () => {
    const html = panelMarkup();
    // The extraction step reads the typed sentence BEFORE anything is
    // hidden — the gate discloses that send rather than denying it.
    expect(html).toMatch(/sees your words before anything is hidden/);
  });

  it("keeps both providers' retention postures disclosed inline (review P2 pin)", () => {
    // The Meta note states the no-training commitment AND the retention
    // honesty; the ElevenLabs note states the improve-services use and the
    // account opt-out. Neither may silently drop to link-only.
    const html = panelMarkup();
    expect(html).toMatch(/not used to train its models/);
    expect(html).toMatch(/not a promise that nothing is kept/);
    expect(html).toMatch(/may use it to improve its services/);
    expect(html).toMatch(/training opt-out in your account/);
  });

  it("says the choice is per device and revocable", () => {
    const html = panelMarkup();
    expect(html).toMatch(/on this device/);
    expect(html).toMatch(/change (this )?at any time/i);
  });
});

describe("ConsentPanel verbosity (HACK-127, VAL-UX-013)", () => {
  /** Visible words of the rendered panel: tags stripped, entities decoded. */
  function wordCount(html: string): number {
    return textOf(html)
      .replace(/<[^>]+>/g, " ")
      .split(/\s+/)
      .filter(Boolean).length;
  }

  it("is noticeably shorter while every informed-consent element stays (word budget)", () => {
    // HACK-127: the consent request's copy around the two toggles was
    // long enough to read as a wall of text (412 words); it must read
    // noticeably shorter while still naming provider, purpose, and what is
    // shared. The budget is a hard pin so verbosity cannot creep back —
    // sized to hold every reviewer-mandated disclosure with margin; the
    // other tests in this file keep each informed-consent element pinned.
    expect(wordCount(panelMarkup())).toBeLessThanOrEqual(290);
  });

  it("stays within the budget and names the providers in EVERY toggle state (property)", () => {
    // Property (repo property-based-testing skill): the verbosity pin is
    // not an artifact of one render state — for both toggles checked or
    // unchecked in any combination, the panel stays within the budget and
    // still names both providers, every purpose and rendered send from the
    // registry (the consent copy renders FROM CONSENT_PATHS), and the
    // refusal control (refusal never blocks).
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (aiChecked, voiceChecked) => {
        const html = panelMarkup({ aiChecked, voiceChecked });
        expect(wordCount(html)).toBeLessThanOrEqual(290);
        expect(html).toMatch(/Meta/);
        expect(html).toMatch(/ElevenLabs/);
        expect(html).toContain("data-consent-ai-toggle");
        expect(html).toContain("data-consent-decline");
        for (const path of CONSENT_PATHS) {
          if (path.id === "fax") continue; // post-submission path — not this surface's toggle
          expect(html).toContain(path.purpose);
          for (const send of path.sends) {
            expect(html).toContain(send);
          }
        }
      }),
    );
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

describe("ConsentPanel layers its fine print (HACK-165)", () => {
  // Kurt flagged on Nov 4 that the consent copy still took most of the
  // screen on /intake/conversation (1.7 phone screens before Continue).
  // The panel is now a layered notice: what makes the choice informed
  // shows without a tap, and each path's terms and retention or data-use
  // line sit in that path's closed disclosure on the same panel.

  /** The first layer: the panel as it shows before any tap, each disclosure reduced to its summary. */
  function firstLayer(html: string): string {
    return html.replace(
      /<details[^>]*>([\s\S]*?)<\/details>/g,
      (_block, inner: string) => inner.match(/<summary[^>]*>[\s\S]*?<\/summary>/)?.[0] ?? "",
    );
  }

  /** One path's closed disclosure, whole. */
  function finePrint(html: string, id: string): string {
    return html.match(new RegExp(`<details data-consent-details="${id}"[^>]*>[\\s\\S]*?</details>`))?.[0] ?? "";
  }

  /** The text of a disclosure's summary. */
  function summaryOf(details: string): string | undefined {
    return details.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)?.[1];
  }

  function visibleWords(html: string): number {
    return html.replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).length;
  }

  /**
   * What shows before any tap. The panel showed 289 words at once before
   * the layering. With both providers' data-use caveats kept in short form,
   * the first layer is 222 words on a first visit (208 with typed sharing
   * on), so this pins the cut with only 3 words of headroom. The whole
   * panel is 289 against the 290 budget above.
   */
  const FIRST_LAYER_BUDGET = 225;

  const everyToggleState: [boolean, boolean][] = [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ];

  it("keeps the informed choice visible and each path's fine print one tap away, in every toggle state (property)", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (aiChecked, voiceChecked) => {
        const html = panelMarkup({ aiChecked, voiceChecked });
        const visible = firstLayer(html);
        for (const path of CONSENT_PATHS) {
          if (path.id === "fax") continue; // post-submission path, not this surface's toggle
          // What is sent, to whom and for what: visible without a tap.
          expect(visible).toContain(path.provider);
          expect(visible).toContain(path.purpose);
          for (const send of path.sends) {
            expect(visible).toContain(send);
          }
          // The path's fine print: on the panel, closed, with every verified terms link.
          const details = finePrint(html, path.id);
          expect(details).not.toBe("");
          expect(details).not.toMatch(/^<details[^>]*\sopen/);
          // A verified path's summary says the terms are inside, because they are.
          expect(summaryOf(details)).toMatch(/terms/);
          for (const terms of path.terms) {
            expect(details).toContain(terms.url);
            expect(visible).not.toContain(terms.url);
          }
        }
        // The lines that change what someone agrees to stay in the first layer.
        expect(visible).toMatch(/sees your words before anything is hidden/);
        // Each provider's data-use caveat keeps a short form in the first
        // layer; the rest of its wording is in the fine print.
        expect(visible).toMatch(/Meta may keep them per its terms/);
        expect(visible).toMatch(/Only reply text goes to ElevenLabs, which may use it to improve its services/);
        expect(visible).toMatch(/the microphone never starts and no audio is ever sent/);
        expect(visible).toMatch(/answers save on the app's server/i);
        expect(visible).toContain("data-consent-continue");
        expect(visible).toContain("data-consent-decline");
        // Retention and data use: in the fine print, still on the panel.
        expect(finePrint(html, "ai-conversation")).toMatch(/not used to train its models/);
        expect(finePrint(html, "ai-conversation")).toMatch(/not a promise that nothing is kept/);
        expect(finePrint(html, "voice")).toMatch(/training opt-out in your account/);
        expect(finePrint(html, "voice")).toMatch(/never gets anything you said or typed/);
        expect(visibleWords(visible)).toBeLessThanOrEqual(FIRST_LAYER_BUDGET);
      }),
      { examples: everyToggleState },
    );
  });

  it("keeps an unverified path's notice in the first layer, never behind the disclosure", () => {
    for (const unverifiedId of ["ai-conversation", "voice"] as const) {
      const paths: ConsentPathSpec[] = CONSENT_PATHS.map((path) =>
        path.id === unverifiedId ? { ...path, termsVerified: false } : path,
      );
      const html = panelMarkup({ paths, aiChecked: true, voiceChecked: false });
      expect(firstLayer(html)).toMatch(/haven't verified this provider's data-handling terms/);
      expect(finePrint(html, unverifiedId)).not.toMatch(/haven't verified/);
      // With no verified terms inside, the summary doesn't promise any.
      expect(summaryOf(finePrint(html, unverifiedId))).not.toMatch(/terms/);
    }
  });
});

describe("ConsentReceiptPanel — compact, friendly, honest (VAL-UX-010, HACK-150)", () => {
  const baseReceipt: ConsentReceipt = {
    v: 2,
    providerId: "meta-model-api",
    ai: true,
    voice: false,
    at: "2026-10-30T12:00:00.000Z",
  };

  function receiptMarkup(receipt: ConsentReceipt): string {
    return textOf(
      renderToStaticMarkup(
        <ConsentReceiptPanel
          receipt={receipt}
          onRevoke={() => undefined}
          onReopen={() => undefined}
        />,
      ),
    );
  }

  /** Every decision the storage layer can hand the panel: both toggles, any decision time. */
  const receiptArbitrary = fc
    .record({
      ai: fc.boolean(),
      voice: fc.boolean(),
      // Bounded realistic valid dates: unbounded fc.date() spans
      // extended-year ranges (and version-dependent Invalid Dates) that can
      // break toISOString/parseConsentReceipt for reasons unrelated to the
      // panel (claude-review P3, PR #164).
      at: fc
        .date({ min: new Date("2020-01-01"), max: new Date("2100-01-01"), noInvalidDate: true })
        .map((date) => date.toISOString()),
    })
    .map((parts): ConsentReceipt => ({ v: 2, providerId: CONSENT_PROVIDER_ID, ...parts }));

  const onState = (on: boolean) => (on ? "on" : "off");

  it("renders a short, friendly reassurance naming what was allowed and when — for EVERY stored decision (property)", () => {
    fc.assert(
      fc.property(receiptArbitrary, (receipt) => {
        const html = receiptMarkup(receipt);
        expect(html).toContain("data-consent-receipt");
        expect(html).toMatch(/You're in control of your information/);
        expect(html).toMatch(
          new RegExp(
            `sharing what you type with the AI assistant \\(Meta\\) is ${onState(receipt.ai)}`,
            "i",
          ),
        );
        expect(html).toMatch(new RegExp(`voice sharing is ${onState(receipt.voice)}`, "i"));
        expect(html).toContain(new Date(receipt.at).toLocaleString());
        // The storage claim is scoped to THE CHOICE, never to the user's
        // information (claude-review P2, PR #164): typed words go to the AI
        // provider when sharing is on, and pii answers live in the server
        // vault — only the decision itself lives on this device.
        expect(html).toMatch(/This choice was saved on this device on /);
        expect(html).not.toMatch(/information[^\n]*stored|only on this device/i);
        // Still revocable and changeable, and it carries no answer data.
        expect(html).toContain("data-consent-revoke");
        expect(html).toContain("data-consent-reopen");
        expect(html.toLowerCase()).not.toContain("answer");
      }),
    );
  });

  it("shows NO raw JSON on screen — for every receipt (property)", () => {
    fc.assert(
      fc.property(receiptArbitrary, (receipt) => {
        const html = receiptMarkup(receipt);
        expect(html).not.toContain(JSON.stringify(receipt));
        expect(html).not.toContain("data-consent-receipt-json");
        expect(html).not.toContain('"providerId"');
        expect(html).not.toMatch(/<pre[ >]/);
        expect(html).not.toMatch(/<details[ >]/);
      }),
    );
  });

  it("is presentation only: the stored record is consumed exactly as stored", () => {
    // HACK-150 changes the presentation, never the record: the receipt's
    // wire format parses back identically, serializes to the same bytes
    // again, and the panel renders from those same fields — the per-device
    // store keeps its exact format (parseConsentReceipt unchanged).
    fc.assert(
      fc.property(receiptArbitrary, (receipt) => {
        const stored = JSON.stringify(receipt);
        const parsed = parseConsentReceipt(stored);
        expect(parsed).not.toBeNull();
        expect(JSON.stringify(parsed)).toBe(stored);
        const html = receiptMarkup(parsed!);
        expect(html).toContain("data-consent-receipt");
        expect(html).not.toContain(stored);
      }),
    );
  });

  it("names the AI provider from the enforcement registry (drift test)", () => {
    // The receipt line's provider naming derives from the same registry the
    // consent gate enforces against, with the parenthetical technical
    // detail stripped (the full naming lives on the consent panel).
    const aiPath = CONSENT_PATHS.find((path) => path.id === "ai-conversation");
    expect(aiPath).toBeDefined();
    const shortName = aiPath!.provider.replace(/\s*\(.*\)$/, "");
    expect(receiptMarkup(baseReceipt)).toContain(`the AI assistant (${shortName})`);
    expect(shortName).toBe("Meta");
  });
});
