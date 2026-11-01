import Link from "next/link";
import {
  OPEN_TRACKER_LINK,
  TRACKER_LINK_HEADING,
  TRACKER_LINK_TEXT,
} from "../lib/renewal/copy";

/**
 * The way into the renewal tracker (BN-22 / HACK-50) from the places a
 * person finishes: the wizard's review screen and the home page. The
 * heading level fits the host page's outline (BN-07: no skipped levels).
 */
export function RenewalTrackerLink({ headingLevel }: { headingLevel: 2 | 3 }) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      aria-labelledby="renewal-tracker-link-heading"
      data-renewal-tracker-link
      className="flex flex-col gap-2 rounded-md border border-zinc-200 p-4 dark:border-zinc-700"
    >
      <Heading id="renewal-tracker-link-heading" className="text-lg font-semibold">
        {TRACKER_LINK_HEADING}
      </Heading>
      <p className="text-zinc-600 dark:text-zinc-400">{TRACKER_LINK_TEXT}</p>
      <Link
        href="/renewal"
        className="self-start font-semibold underline hover:text-zinc-600 dark:hover:text-zinc-300"
      >
        {OPEN_TRACKER_LINK}
      </Link>
    </section>
  );
}
