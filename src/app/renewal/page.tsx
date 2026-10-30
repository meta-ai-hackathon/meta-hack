import type { Metadata } from "next";
import { PAGE_TITLE, pageIntro } from "../../lib/renewal/copy";
import { PILOT_RENEWAL_FACTS } from "../../lib/renewal/renewal-facts";
import { RenewalTracker } from "./renewal-tracker";
import { RenewalFactsSection } from "./renewal-view";

export const metadata: Metadata = {
  title: "Your renewal — Benefits Navigator",
  description:
    "Official renewal facts with their sources, and a private reminder for the date on your own letter. Your date stays on this device.",
};

// The renewal tracker page (BN-22 / HACK-50). The knowledge-base facts
// render on the server, each labeled and sourced; the person's own date is
// handled entirely in the browser by RenewalTracker.
export default function RenewalPage() {
  const facts = PILOT_RENEWAL_FACTS;
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-10 px-6 py-12">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{PAGE_TITLE}</h1>
        <p className="max-w-xl text-lg text-zinc-600 dark:text-zinc-400">
          {pageIntro(facts.programName)}
        </p>
      </div>
      <RenewalTracker facts={facts} />
      <RenewalFactsSection facts={facts} />
    </div>
  );
}
