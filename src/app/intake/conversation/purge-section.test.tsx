import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { findBannedClaims } from "../../../lib/honesty";
import {
  PURGE_DONE_NOTICE,
  PURGE_NO_SESSION_DEVICE_KEPT_NOTICE,
  PURGE_NO_SESSION_NOTICE,
  PURGE_PURGED_DEVICE_KEPT_NOTICE,
  PURGE_REFUSED_NOTICE,
  PURGE_REMOVING_NOTICE,
  PURGE_UNKNOWN_NOTICE,
  PurgeConfirmation,
  PurgeSurface,
  createPurgeClickHandler,
  requestPurge,
  resolvePurgeOutcome,
} from "./purge-section";
import type { PurgeRequestOutcome } from "./purge-section";

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

  it("property: click sequences follow the two-state machine — a purge runs only on a confirming-state click", () => {
    fc.assert(
      fc.property(fc.nat(40), (clicks) => {
        // The component's real wiring, modeled: `confirming` is state
        // between clicks, and the click decision is rebuilt from the
        // CURRENT state every click (the surface re-renders between
        // clicks), so requestConfirm feeds back into the next click —
        // the transition the previous fixed-confirming property could
        // not model (claude-review P3, PR #68's adjudication).
        let confirming = false;
        let confirmRequests = 0;
        let purgeRuns = 0;
        for (let index = 0; index < clicks; index += 1) {
          const click = createPurgeClickHandler(confirming, {
            requestConfirm: () => {
              confirming = true;
              confirmRequests += 1;
            },
            runPurge: () => {
              confirming = false;
              purgeRuns += 1;
            },
          });
          click();
        }
        // The two-state machine's invariant: every purge consumed an
        // earlier confirm (nothing purges from the ready state), and
        // the confirm question stands exactly when an opened confirm
        // has not yet been consumed by a purge.
        expect(purgeRuns).toBeLessThanOrEqual(confirmRequests);
        expect(confirmRequests - purgeRuns).toBe(confirming ? 1 : 0);
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
    // The server erase IS verified on the purged outcome; only the
    // device copy's erase is unverifiable. The hedge must say the first
    // exactly and must not carry the verified case's announcement.
    expect(PURGE_PURGED_DEVICE_KEPT_NOTICE).toBe(
      "The erase went through on the server — but this device's saved " +
        "copy couldn't be erased just now. Trying the delete again may " +
        "clear it.",
    );
    expect(PURGE_PURGED_DEVICE_KEPT_NOTICE).not.toBe(PURGE_DONE_NOTICE);
    expect(PURGE_PURGED_DEVICE_KEPT_NOTICE).not.toContain("are gone");
  });
});

describe("resolvePurgeOutcome (the completion decision)", () => {
  it("shows the done screen with the done notice only when the device erase is verified", () => {
    const verified = resolvePurgeOutcome("purged", true);
    expect(verified.done).toBe(true);
    expect(verified.notice).toBe(PURGE_DONE_NOTICE);
    // An unverifiable device erase may not announce "Your answers are
    // gone" (droid-review carried from PR #66): the surface stays up —
    // the delete can be retried — and the notice hedges.
    const unverifiable = resolvePurgeOutcome("purged", false);
    expect(unverifiable.done).toBe(false);
    expect(unverifiable.notice).toBe(PURGE_PURGED_DEVICE_KEPT_NOTICE);
  });

  it("keeps the no-session pair honest on both sides of the device signal", () => {
    const verified = resolvePurgeOutcome("no_session", true);
    expect(verified.done).toBe(false);
    expect(verified.notice).toBe(PURGE_NO_SESSION_NOTICE);
    const unverifiable = resolvePurgeOutcome("no_session", false);
    expect(unverifiable.done).toBe(false);
    expect(unverifiable.notice).toBe(PURGE_NO_SESSION_DEVICE_KEPT_NOTICE);
  });

  it("refused and unknown never show the done screen whatever the device signal", () => {
    const refused = resolvePurgeOutcome("refused", true);
    expect(refused.done).toBe(false);
    expect(refused.notice).toBe(PURGE_REFUSED_NOTICE);
    const unknown = resolvePurgeOutcome("unknown", false);
    expect(unknown.done).toBe(false);
    expect(unknown.notice).toBe(PURGE_UNKNOWN_NOTICE);
  });

  it("property: the done announcement fires only for a verified purge", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<PurgeRequestOutcome>(
          "purged",
          "refused",
          "no_session",
          "unknown",
        ),
        fc.boolean(),
        (outcome, deviceCleared) => {
          const resolution = resolvePurgeOutcome(outcome, deviceCleared);
          if (outcome === "purged" && deviceCleared) {
            return (
              resolution.done && resolution.notice === PURGE_DONE_NOTICE
            );
          }
          // Every other pairing must neither show the done screen nor
          // carry the "answers are gone" announcement.
          return !resolution.done && resolution.notice !== PURGE_DONE_NOTICE;
        },
      ),
    );
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
    // A 404 carrying THIS route's own error-code body (the errorResponse
    // shape, error.code "not_found") means no active session was found:
    // its own outcome, so the client can say exactly that instead of
    // claiming the answers are "still saved".
    const missing = (async () =>
      new Response(
        JSON.stringify({ error: { code: "not_found" } }),
        { status: 404 },
      )) as unknown as typeof fetch;
    expect(await requestPurge(missing)).toBe("no_session");
  });

  it("maps a 404 WITHOUT the route's error-code body to unknown, never no_session", async () => {
    // A proxy/platform/rewrite 404 — an HTML error page, an empty body,
    // or some other API's error shape — is not this route's answer: it
    // says nothing about whether the session's rows exist, so erasing
    // the device copies on it could destroy answers the server still
    // holds (claude-review P2, PR #68 adjudication). The honest outcome
    // is unknown.
    const proxy404 = (async () =>
      new Response(
        "<html>Not Found</html>",
        { status: 404 },
      )) as unknown as typeof fetch;
    expect(await requestPurge(proxy404)).toBe("unknown");
    const empty404 = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await requestPurge(empty404)).toBe("unknown");
    const otherCode404 = (async () =>
      new Response(
        JSON.stringify({ error: { code: "gone" } }),
        { status: 404 },
      )) as unknown as typeof fetch;
    expect(await requestPurge(otherCode404)).toBe("unknown");
  });

  it("property: every non-404 status maps to the one honest outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Direct construction, not a filtered range (the property skill's
        // shape rule): 404 is excluded here because its mapping depends
        // on the BODY, not the status alone — it gets its own property
        // below, which samples it on every run instead of by the ~20%
        // chance a 400-value range offers.
        fc.oneof(
          fc.integer({ min: 200, max: 403 }),
          fc.integer({ min: 405, max: 599 }),
        ),
        async (status) => {
          const outcome = await requestPurge((async () =>
            new Response(null, { status: status })) as unknown as typeof fetch);
          const expected =
            status < 300
              ? "purged"
              : status < 500
                ? "refused"
                : "unknown";
          return outcome === expected;
        },
      ),
    );
  });

  it("property: a 404 maps to no_session only when the body carries the route's own code", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Foreign-body variants: an empty body, a proxy's HTML error
        // page, another API's error shape, and an object without the
        // error envelope — none is this route's answer. (The route's
        // own shape is pinned deterministically above; here every
        // foreign variant must land on unknown. Concrete shapes, not
        // random JSON: the discriminator is one specific deep field,
        // and a random value could collide with it.)
        fc.constantFrom(
          null,
          "<html>Not Found</html>",
          JSON.stringify({ error: { code: "gone" } }),
          JSON.stringify({ purged: false }),
        ),
        async (body) => {
          const outcome = await requestPurge((async () =>
            new Response(body, {
              status: 404,
            })) as unknown as typeof fetch);
          return outcome === "unknown";
        },
      ),
    );
  });
});
