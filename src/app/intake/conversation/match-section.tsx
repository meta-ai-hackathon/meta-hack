"use client";

import { useEffect, useState } from "react";
import { AnswerStatusBadge } from "../../../components/answer-status-badge";
import { StatusRegion } from "../../../components/status-region";
import { attachConsentHeader } from "../../../lib/consent";

// The match section (Mission v2 M3): the ranked benefit match under the
// conversation, fetched from /api/match after turns change. Every claim on
// a card links to its official source with a retrieval date and the entry
// version; unknown answers surface as an explicit to-resolve list; the
// framing is a suggestion ("may be worth pursuing"), never a promise.
//
// Response shapes are defined locally, mirroring the route's payload: the
// server-only match module must not enter the client bundle (the same
// convention the chat uses for its own server types).

interface MatchSourceView {
  readonly entryId: string;
  readonly entryTitle: string;
  readonly entryVersion: number;
  readonly entryStatus: string;
  readonly sourceUrl: string;
  readonly retrievedAt: string;
}

interface MatchReasonView {
  readonly text: string;
  readonly questionId?: string;
  readonly answerLabel?: string;
  readonly source: MatchSourceView;
}

interface MatchRequirementView {
  readonly kind: "document" | "step" | "deadline" | "renewal";
  readonly text: string;
  readonly source: MatchSourceView;
}

interface MatchCardView {
  readonly entryId: string;
  readonly entryTitle: string;
  readonly entryVersion: number;
  readonly score: number;
  readonly framing: string;
  readonly reasons: readonly MatchReasonView[];
  readonly requirements: readonly MatchRequirementView[];
  readonly links: readonly { label: string; url: string; source: MatchSourceView }[];
  readonly explanation: { text: string; source: "model" | "facts" };
  readonly terms: readonly {
    id: string;
    term: string;
    definition: string;
    source: { title: string; url: string; retrievedAt: string };
  }[];
}

interface MatchDataView {
  readonly hasSession: boolean;
  readonly matches: readonly MatchCardView[];
  readonly toResolve: readonly {
    questionId: string;
    prompt: string;
    status: "known" | "unknown" | "unverified";
    statusLabel: string;
  }[];
}

const REQUIREMENT_KIND_LABELS: Readonly<Record<MatchRequirementView["kind"], string>> = {
  document: "Document you may need",
  step: "Step",
  deadline: "Deadline",
  renewal: "Renewal",
};

function SourceNote({ source }: { source: MatchSourceView }) {
  return (
    <span className="text-sm text-muted">
      Source:{" "}
      <a
        href={source.sourceUrl}
        className="underline"
        rel="noreferrer"
      >
        {source.sourceUrl}
      </a>{" "}
      (retrieved {source.retrievedAt}, entry version {source.entryVersion})
    </span>
  );
}

/**
 * The pure presentation for one match payload. Exported for tests: the
 * rendered-card detector scan runs over this markup for every fixture card.
 */
export function MatchSectionContent({ data }: { data: MatchDataView }) {
  return (
    <div data-match-section className="flex flex-col gap-6">
      <section aria-labelledby="match-heading" className="flex flex-col gap-3">
        <h2 id="match-heading" className="font-display text-2xl font-bold">
          Benefits that may be worth pursuing
        </h2>
        {data.matches.length === 0 ? (
          <p className="text-muted">
            As you answer questions, the programs that may fit your situation
            show up here with their official sources.
          </p>
        ) : null}
        {data.matches.map((card) => (
          <article
            key={card.entryId}
            data-match-card={card.entryId}
            className="flex flex-col gap-3 rounded-2xl border border-surface-border bg-surface p-6"
          >
            <h3 className="font-display text-2xl font-bold">{card.entryTitle}</h3>
            <p className="text-sm text-muted">
              {card.framing} Facts from entry version {card.entryVersion}.
            </p>
            {card.reasons.length > 0 ? (
              <div className="flex flex-col gap-1">
                <h4 className="font-medium">Why this may fit</h4>
                <ul className="list-disc pl-5 marker:text-teal">
                  {card.reasons.map((reason, index) => (
                    <li key={`${reason.questionId ?? "reason"}-${index}`}>
                      {reason.text}
                      {reason.answerLabel ? (
                        <> — your answer: {reason.answerLabel}</>
                      ) : null}
                      <br />
                      <SourceNote source={reason.source} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <h4 className="font-medium">What you would need</h4>
              <ul className="list-disc pl-5 marker:text-teal" data-match-requirements={card.entryId}>
                {card.requirements.map((requirement, index) => (
                  <li key={`${requirement.kind}-${index}`}>
                    <span className="font-medium">
                      {REQUIREMENT_KIND_LABELS[requirement.kind]}:
                    </span>{" "}
                    {requirement.text}
                    <br />
                    <SourceNote source={requirement.source} />
                  </li>
                ))}
              </ul>
            </div>
            {card.links.length > 0 ? (
              <div className="flex flex-col gap-1">
                <h4 className="font-medium">Official application links</h4>
                <ul className="list-disc pl-5 marker:text-teal">
                  {card.links.map((link, index) => (
                    <li key={`${link.url}-${index}`}>
                      <a href={link.url} className="text-teal underline hover:opacity-80" rel="noreferrer">
                        {link.label}
                      </a>
                      <br />
                      <SourceNote source={link.source} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <h4 className="font-medium">In plain language</h4>
              <p data-match-explanation={card.entryId}>
                {card.explanation.text}
              </p>
              <p className="text-sm text-muted">
                {card.explanation.source === "model"
                  ? "This explanation was generated from the sourced facts above and checked against them."
                  : "This explanation quotes the sourced facts above directly."}
              </p>
            </div>
            {card.terms.length > 0 ? (
              <div className="flex flex-col gap-1">
                <h4 className="font-medium">Terms on this card</h4>
                <dl className="flex flex-col gap-1">
                  {card.terms.map((term) => (
                    <div key={term.id} data-match-term={term.id}>
                      <dt className="font-medium">{term.term}</dt>
                      <dd>
                        {term.definition}{" "}
                        <a href={term.source.url} className="underline" rel="noreferrer">
                          {term.source.title}
                        </a>{" "}
                        (retrieved {term.source.retrievedAt})
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
          </article>
        ))}
      </section>
      {data.toResolve.length > 0 ? (
        <section
          aria-labelledby="to-resolve-heading"
          data-to-resolve
          className="flex flex-col gap-2 rounded-2xl border border-dashed border-amber-line bg-amber-soft p-5"
        >
          <h2 id="to-resolve-heading" className="font-display text-xl font-bold text-amber-ink">
            To resolve
          </h2>
          <p className="text-amber-ink">
            These answers are missing or not verified yet. Nothing below is
            assumed — the programs are only suggested, and the official rules
            decide.
          </p>
          <ul className="flex flex-col gap-2">
            {data.toResolve.map((item) => (
              <li
                key={item.questionId}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <span>{item.prompt}</span>
                <AnswerStatusBadge status={item.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** The fetch-failure copy, announced through the StatusRegion convention. */
export const MATCH_UNAVAILABLE_NOTICE =
  "The match list is unavailable right now. Your answers are safe; try " +
  "again after your next message.";

/**
 * The live section: fetches the match for the session and re-fetches when
 * the conversation moves (refreshKey = turn count). A fetch failure stays
 * quiet and honest — the cards are not the conversation's core path — and
 * its notice is announced through the StatusRegion convention: the region
 * is mounted for the section's whole life and the failure message CHANGES
 * into it, so screen readers announce the update (a region inserted with
 * its text already present may stay silent).
 */
export function MatchSection({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<MatchDataView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadMatch() {
      try {
        // The consent receipt rides along: with sharing declined the route
        // spends zero model calls and explains from the entry facts
        // (Mission v2.1 M5, VAL-CONSENT-001).
        const response = await fetch("/api/match", {
          headers: attachConsentHeader(new Headers()),
        });
        if (!response.ok) {
          throw new Error("match unavailable");
        }
        const payload = (await response.json()) as MatchDataView;
        if (!cancelled) {
          setData(payload);
          setFailed(false);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
        }
      }
    }
    void loadMatch();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return (
    <>
      {data && !failed ? <MatchSectionContent data={data} /> : null}
      <StatusRegion
        message={failed ? MATCH_UNAVAILABLE_NOTICE : ""}
        className="text-sm text-muted"
      />
    </>
  );
}
