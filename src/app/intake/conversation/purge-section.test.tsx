import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { findBannedClaims } from "../../../lib/honesty";
import {
  PURGE_DONE_NOTICE,
  PURGE_NO_SESSION_DEVICE_KEPT_NOTICE,
  PURGE_NO_SESSION_NOTICE,
  PURGE_REFUSED_NOTICE,
  PURGE_REMOVING_NOTICE,
  PURGE_UNKNOWN_NOTICE,
  PurgeConfirmation,
  PurgeSurface,
  createPurgeClickHandler,
  requestPurge,
} from "./purge-section";

// Purge section tests (HACK-80 / VAL-DEMOEXP-006/007 client surface): the
// destructive surface renders per the approved cleanup design (eyebrow,
// display heading, the erased/never-existed cards, the danger panel), the
// removing sequence carries the mandated phrase, the confirmation states
// EXACTLY what remains and what is gone, and everything is banned-claim
// clean. The two-step delete's decision wiring (first click confirms and
// sends NOTHING, explicit confirmation purges) is unit-tested via
// createPurgeClickHandler; the request wiring is unit-tested with an
// injectable fetch; the interactive surface is browser-verified
// (agent-browser).

function markupWithBannedClaims(html: string): string[] {
  return findBannedClaims(html).map(
    (match) => `/${match.patternSource}/ matched "${match.matchedText}"`,
  );
}

describe("PurgeSurface (the ready phase)", () => {
  it("renders the cleanup design: eyebrow, heading, both cards, danger panel", () => {
    const html = renderToStaticMarkup(
      <PurgeSurface
        busy={false}
        confirming={false}
        onDelete={() => undefined}
        onKeep={() => undefined}
      />,
    );
    expect(html).toContain("data-purge-section");
    expect(html).toContain("Your data, your call");
    expect(html).toContain("Delete my information");
    expect(html).toContain("This can&#x27;t be undone");
    // What gets erased: every answer, the chat history, the private
    // details — the same population the confirmation lists.
    expect(html).toContain("data-purge-erased");
    expect(html).toContain("What gets erased");
    expect(html).toContain("Your answers");
    expect(html).toContain("Your chat history");
    expect(html).toContain("The private details you told us");
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
      <PurgeSurface
        busy={false}
        confirming={false}
        onDelete={() => undefined}
        onKeep={() => undefined}
      />,
    );
    expect(ready).toContain('data-purge-button');
    expect(ready).not.toContain("disabled=");
    const busy = renderToStaticMarkup(
      <PurgeSurface
        busy
        confirming={false}
        onDelete={() => undefined}
        onKeep={() => undefined}
      />,
    );
    expect(busy).toContain("disabled=");
    // The deliberate on-screen beat reads while the purge runs.
    expect(busy).toContain("data-purge-removing");
    expect(busy).toContain(PURGE_REMOVING_NOTICE);
  });

  it("keeps a hierarchical heading outline (h2, then h3)", () => {
    const html = renderToStaticMarkup(
      <PurgeSurface
        busy={false}
        confirming={false}
        onDelete={() => undefined}
        onKeep={() => undefined}
      />,
    );
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(2);
    for (let index = 1; index < levels.length; index += 1) {
      expect(levels[index]!).toBeLessThanOrEqual(levels[index - 1]! + 1);
    }
  });

  it("carries zero banned claims", () => {
    const html = renderToStaticMarkup(
      <PurgeSurface
        busy={false}
        confirming={false}
        onDelete={() => undefined}
        onKeep={() => undefined}
      />,
    );
    expect(markupWithBannedClaims(html)).toEqual([]);
  });

  it("shows the approved confirm state: question and both choices, no delete button", () => {
    const html = renderToStaticMarkup(
      <PurgeSurface
        busy={false}
        confirming
        onDelete={() => undefined}
        onKeep={() => undefined}
      />,
    );
    // The two-step delete from the approved cleanup design: the question
    // and the explicit pair of choices replace the single button before
    // any request exists.
    expect(html).toContain("data-purge-confirm-question");
    expect(html).toContain("Are you sure? This erases everything for good.");
    expect(html).toContain("data-purge-confirm-button");
    expect(html).toContain("Yes, delete everything");
    expect(html).toContain("data-purge-keep-button");
    expect(html).toContain("Keep my information");
    // The download reassurance stays visible at the decision point, so
    // "erases everything" cannot be read against the kept download.
    expect(html).toContain("a download you&#x27;ve saved stays yours");
    // The single delete button is replaced, not accompanied, and the
    // removing beat has not started.
    expect(html).not.toContain("data-purge-button");
    expect(html).not.toContain("data-purge-removing");
    expect(markupWithBannedClaims(html)).toEqual([]);
  });
});

describe("the two-step delete", () => {
  it("the first click shows the confirm state and sends no purge request", () => {
    let confirmRequests = 0;
    let purgeRequests = 0;
    const firstClick = createPurgeClickHandler(false, {
      requestConfirm: () => {
        confirmRequests += 1;
      },
      runPurge: () => {
        purgeRequests += 1;
      },
    });
    firstClick();
    expect(confirmRequests).toBe(1); // the confirm state shows
    expect(purgeRequests).toBe(0); // NO purge request was sent
  });

  it("only the explicit confirmation runs the purge", () => {
    let confirmRequests = 0;
    let purgeRequests = 0;
    const confirmClick = createPurgeClickHandler(true, {
      requestConfirm: () => {
        confirmRequests += 1;
      },
      runPurge: () => {
        purgeRequests += 1;
      },
    });
    confirmClick();
    expect(confirmRequests).toBe(0);
    expect(purgeRequests).toBe(1); // exactly one purge request
  });

  it("property: any number of clicks from the ready state sends zero purge requests", () => {
    fc.assert(
      fc.property(fc.nat(25), (readyClicks) => {
        let confirmRequests = 0;
        let purgeRequests = 0;
        // The handler the component builds while the confirm question is
        // NOT showing: every click is a first click.
        const click = createPurgeClickHandler(false, {
          requestConfirm: () => {
            confirmRequests += 1;
          },
          runPurge: () => {
            purgeRequests += 1;
          },
        });
        for (let index = 0; index < readyClicks; index += 1) {
          click();
        }
        expect(purgeRequests).toBe(0);
        expect(confirmRequests).toBe(readyClicks);
      }),
    );
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
  });

  it("keeps the done and unknown notices word-identical", () => {
    expect(PURGE_DONE_NOTICE).toBe(
      "Your answers are gone. This screen lists exactly what remains.",
    );
    expect(PURGE_UNKNOWN_NOTICE).toBe(
      "We couldn't reach the app to finish the delete, so we can't say " +
        "whether it went through. Reload the page to see where things stand " +
        "— nothing more is lost by checking.",
    );
  });

  it("states what happened per refusal outcome, without false promises", () => {
    // A 404 found no session: nothing was removed and nothing was there,
    // so the copy must not claim the answers are "still saved" — the
    // person's confirmed intent is honored by erasing the on-device
    // copies, and the notice says so.
    expect(PURGE_NO_SESSION_NOTICE).toBe(
      "There was no active session on the server to delete, so nothing " +
        "was removed there. Any answers kept on this device are erased too.",
    );
    expect(PURGE_NO_SESSION_NOTICE).not.toContain("still saved");
    expect(PURGE_NO_SESSION_NOTICE).not.toContain("Try again");
    // If the device erase could not be verified, the notice must not
    // claim the on-device copies are gone either.
    expect(PURGE_NO_SESSION_DEVICE_KEPT_NOTICE).toBe(
      "There was no active session on the server to delete, so nothing " +
        "was removed there — and this device's saved copy couldn't be " +
        "erased just now.",
    );
    expect(PURGE_NO_SESSION_DEVICE_KEPT_NOTICE).not.toContain(
      "are erased",
    );
    // A refused delete (the validation or cross-site gate) removed nothing
    // — but a cross-site retry can never succeed, so none is suggested.
    expect(PURGE_REFUSED_NOTICE).toBe(
      "The delete was refused — nothing was removed, and your answers are " +
        "still saved.",
    );
    expect(PURGE_REFUSED_NOTICE).not.toContain("Try again");
  });
});

describe("requestPurge wiring", () => {
  it("POSTs the explicit confirmation to the purge route", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ purged: true }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await requestPurge(fetchImpl)).toBe("purged");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("/api/session/purge");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      confirmed: true,
    });
  });

  it("separates a definite refusal from an unknown outcome", async () => {
    // A 4xx refusal is definite: the server's purge deletes nothing on
    // those paths, so the notice may say "nothing was removed".
    const refusing = (async () =>
      new Response("no", { status: 400 })) as unknown as typeof fetch;
    expect(await requestPurge(refusing)).toBe("refused");
    // A 5xx is UNKNOWN, not refused: this route's own 500s roll the
    // transaction back, but a proxy or platform timeout can arrive after
    // a commit — the copy must not claim either way.
    const serverError = (async () =>
      new Response("boom", { status: 502 })) as unknown as typeof fetch;
    expect(await requestPurge(serverError)).toBe("unknown");
    // No answer at all is unknown for the same reason.
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await requestPurge(failing)).toBe("unknown");
  });

  it("separates a missing session (404) from a refusal", async () => {
    // A 404 means no active session was found: its own outcome, so the
    // client can say exactly that instead of claiming the answers are
    // "still saved".
    const missing = (async () =>
      new Response(
        JSON.stringify({ error: { code: "not_found" } }),
        { status: 404 },
      )) as unknown as typeof fetch;
    expect(await requestPurge(missing)).toBe("no_session");
  });

  it("property: every status maps to the one honest outcome", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 200, max: 599 }), async (status) => {
        const outcome = await requestPurge((async () =>
          new Response(null, { status: status })) as unknown as typeof fetch);
        const expected =
          status < 300
            ? "purged"
            : status === 404
              ? "no_session"
              : status < 500
                ? "refused"
                : "unknown";
        return outcome === expected;
      }),
    );
  });
});
