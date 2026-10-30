import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../../../lib/honesty";
import {
  PURGE_DONE_NOTICE,
  PURGE_FAILED_NOTICE,
  PURGE_REMOVING_NOTICE,
  PurgeConfirmation,
  PurgeSurface,
  requestPurge,
} from "./purge-section";

// Purge section tests (HACK-80 / VAL-DEMOEXP-006/007 client surface): the
// destructive surface renders per the approved cleanup design (eyebrow,
// display heading, the erased/never-existed cards, the danger panel), the
// removing sequence carries the mandated phrase, the confirmation states
// EXACTLY what remains and what is gone, and everything is banned-claim
// clean. The click sequencing itself is thin wiring over requestPurge +
// removeStoredAnswers and is browser-verified (agent-browser); the wiring
// pieces are unit-tested here with an injectable fetch.

function markupWithBannedClaims(html: string): string[] {
  return findBannedClaims(html).map(
    (match) => `/${match.patternSource}/ matched "${match.matchedText}"`,
  );
}

describe("PurgeSurface (the ready phase)", () => {
  it("renders the cleanup design: eyebrow, heading, both cards, danger panel", () => {
    const html = renderToStaticMarkup(
      <PurgeSurface busy={false} onDelete={() => undefined} />,
    );
    expect(html).toContain("data-purge-section");
    expect(html).toContain("Your data, your call");
    expect(html).toContain("Delete my information");
    expect(html).toContain("This can&#x27;t be undone");
    // What gets erased: every answer, the filled PDF, the chat history.
    expect(html).toContain("data-purge-erased");
    expect(html).toContain("What gets erased");
    expect(html).toContain("Your answers");
    expect(html).toContain("The filled PDF");
    expect(html).toContain("Your chat history");
    // What never existed: the PDF was never stored server-side.
    expect(html).toContain("data-purge-never-existed");
    expect(html).toContain("What never existed");
    expect(html).toContain("We never saved your PDF on our servers");
    // The destructive panel and its button.
    expect(html).toContain("data-purge-panel");
    expect(html).toContain("data-purge-button");
    expect(html).toContain("a download you&#x27;ve saved stays yours");
  });

  it("renders a real button (keyboard operable), disabled while busy", () => {
    const ready = renderToStaticMarkup(
      <PurgeSurface busy={false} onDelete={() => undefined} />,
    );
    expect(ready).toContain('data-purge-button');
    expect(ready).not.toContain("disabled=");
    const busy = renderToStaticMarkup(
      <PurgeSurface busy onDelete={() => undefined} />,
    );
    expect(busy).toContain("disabled=");
    // The deliberate on-screen beat reads while the purge runs.
    expect(busy).toContain("data-purge-removing");
    expect(busy).toContain(PURGE_REMOVING_NOTICE);
  });

  it("keeps a hierarchical heading outline (h2, then h3)", () => {
    const html = renderToStaticMarkup(
      <PurgeSurface busy={false} onDelete={() => undefined} />,
    );
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(2);
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]!).toBeLessThanOrEqual(levels[index - 1]! + 1);
    }
  });

  it("carries zero banned claims", () => {
    const html = renderToStaticMarkup(
      <PurgeSurface busy={false} onDelete={() => undefined} />,
    );
    expect(markupWithBannedClaims(html)).toEqual([]);
  });
});

describe("PurgeConfirmation (the done phase)", () => {
  it("states exactly what is gone: every answer, statement, transcript", () => {
    const html = renderToStaticMarkup(<PurgeConfirmation />);
    expect(html).toContain("data-purge-confirmation");
    expect(html).toContain("data-purge-gone");
    expect(html).toContain("Every answer you gave");
    expect(html).toContain("Every statement you made");
    expect(html).toContain("The whole conversation transcript");
  });

  it("states exactly what remains: the user-kept artifact and the bare receipt", () => {
    const html = renderToStaticMarkup(<PurgeConfirmation />);
    expect(html).toContain("data-purge-remains");
    expect(html).toContain("Any filled application you downloaded");
    expect(html).toContain("The app never kept a copy");
    expect(html).toContain("only a bare receipt that this session happened");
    expect(html).toContain("no form data beyond what that receipt needs");
  });

  it("offers no further destructive action and carries zero banned claims", () => {
    const html = renderToStaticMarkup(<PurgeConfirmation />);
    expect(html).not.toContain("data-purge-button");
    expect(markupWithBannedClaims(html)).toEqual([]);
  });
});

describe("purge notices", () => {
  it("carries the mandated removing phrase for the StatusRegion", () => {
    expect(PURGE_REMOVING_NOTICE).toBe(
      "Removing your answers from this device…",
    );
    expect(PURGE_DONE_NOTICE).not.toBe("");
    expect(PURGE_FAILED_NOTICE).not.toBe("");
  });
});

describe("requestPurge wiring", () => {
  it("POSTs the explicit confirmation to the purge route", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ purged: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await requestPurge(fetchImpl);
    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("/api/session/purge");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      confirmed: true,
    });
  });

  it("reports failure without throwing on a refusal or a network error", async () => {
    const refusing = (async () =>
      new Response("no", { status: 400 })) as unknown as typeof fetch;
    expect(await requestPurge(refusing)).toBe(false);
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await requestPurge(failing)).toBe(false);
  });
});
