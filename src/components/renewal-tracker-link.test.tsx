import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../lib/honesty";
import { TRACKER_LINK_HEADING } from "../lib/renewal/copy";
import { RenewalTrackerLink } from "./renewal-tracker-link";

// The way into the renewal tracker from the finish points (HACK-50): it
// takes the heading level its host needs, so no outline skips a level.

describe("RenewalTrackerLink", () => {
  it("fits the host outline and links to the tracker", () => {
    const asSection = renderToStaticMarkup(<RenewalTrackerLink headingLevel={2} />);
    const asSubsection = renderToStaticMarkup(<RenewalTrackerLink headingLevel={3} />);
    expect(asSection).toContain(
      `<h2 id="renewal-tracker-link-heading" class="text-lg font-semibold">${TRACKER_LINK_HEADING}</h2>`,
    );
    expect(asSubsection).toContain("<h3 ");
    expect(asSubsection).not.toContain("<h2");
    expect(asSection).toContain('href="/renewal"');
    expect(findBannedClaims(asSection)).toEqual([]);
  });

  it("asks before assuming coverage, since people who only applied see it too (review fix)", () => {
    expect(TRACKER_LINK_HEADING).toBe("Already have coverage? Keep track of your renewal");
  });
});
