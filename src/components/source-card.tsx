// A source card (BN-27): where one fact comes from. It shows the source's
// title and official URL, the retrieval date, and the KB entry version, so
// a person can open the page and check the fact themselves. A fact from an
// entry that is not active carries a visible flag with the reason, never a
// silent citation (BN-29).

export interface SourceCardSource {
  readonly title: string;
  readonly url: string;
  /** YYYY-MM-DD retrieval date. */
  readonly retrievedAt: string;
  readonly entryVersion: number;
  readonly entryStatus: "active" | "stale" | "withdrawn";
  readonly statusReason?: string;
}

const NON_ACTIVE_COPY: Readonly<Record<"stale" | "withdrawn", string>> = {
  stale: "This may be out of date",
  withdrawn: "This was withdrawn",
};

export function SourceCard({ source }: { source: SourceCardSource }) {
  return (
    <p data-source-card className="text-sm text-muted">
      Source: {source.title},{" "}
      <a
        href={source.url}
        className="underline"
        rel="noreferrer"
        data-source-url={source.url}
      >
        {source.url}
      </a>{" "}
      (retrieved{" "}
      <span data-source-retrieved={source.retrievedAt}>{source.retrievedAt}</span>,
      entry version{" "}
      <span data-source-version={source.entryVersion}>{source.entryVersion}</span>)
      {source.entryStatus === "active" ? null : (
        <span
          data-source-status={source.entryStatus}
          className="block font-semibold text-amber-ink"
        >
          {NON_ACTIVE_COPY[source.entryStatus]}
          {source.statusReason ? `: ${source.statusReason}` : ""}. Check the
          source before you rely on it.
        </span>
      )}
    </p>
  );
}
