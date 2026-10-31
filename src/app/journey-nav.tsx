"use client";

import Link from "next/link";
import { useEffect, useState, type JSX } from "react";
import type { IntakeClientState } from "../lib/intake/serialize";

// The journey sidebar (VAL-FIX-003, the round-2 entry/home shell): the
// three journey stages — mode choice -> talk -> results — as a clickable
// rail beside the framed content card. REACHED stages navigate;
// not-yet-reached stages are visibly locked. The nav never bypasses the
// journey's gating: reachability derives from the REAL engine state the
// app already serves (GET /api/conversation/history — read-only, no
// session created, no provider send), and navigating opens the
// conversation surface, whose stages the engine still governs. A load
// failure keeps the honest fresh-visitor defaults — nothing unlocks by
// guesswork.

export type JourneyStageId = "mode-choice" | "talk" | "results";

export interface JourneyStageView {
  readonly id: JourneyStageId;
  readonly label: string;
  readonly href: string;
  readonly reached: boolean;
  readonly current: boolean;
}

export interface JourneyProgress {
  /** The conversation has begun: turns or answers exist for this session. */
  readonly begun: boolean;
  /** The deterministic engine reports no unanswered question left. */
  readonly complete: boolean;
}

/**
 * Derive the stage list from real progress. Pure and exported for tests.
 * The engine's own rules are the ONLY source: talk is reached once the
 * journey has begun (a turn was sent or an answer saved), results only
 * when the engine reports the question set complete.
 */
export function deriveJourneyStages(
  progress: JourneyProgress,
  currentId: JourneyStageId = "mode-choice",
): readonly JourneyStageView[] {
  return [
    {
      id: "mode-choice",
      label: "Mode choice",
      href: "/",
      reached: true,
      current: currentId === "mode-choice",
    },
    {
      id: "talk",
      label: "Talk",
      href: "/intake/conversation",
      reached: progress.begun,
      current: currentId === "talk",
    },
    {
      id: "results",
      label: "Results",
      href: "/intake/conversation",
      reached: progress.complete,
      current: currentId === "results",
    },
  ];
}

interface HistoryResponse {
  turns: readonly { id: string }[];
  state: IntakeClientState;
}

/**
 * The journey's real progress from the history payload: begun = the
 * session holds turns or answers; complete = the engine's own flag.
 */
export function journeyProgressFromHistory(
  data: HistoryResponse,
): JourneyProgress {
  return {
    begun:
      data.turns.length > 0 || Object.keys(data.state.answers).length > 0,
    complete: data.state.complete,
  };
}

function LockGlyph(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/**
 * The entry/home surface's journey sidebar. Renders the honest
 * fresh-visitor state on the server paint (only stage 1 reached) and
 * updates from the real engine state after the history loads.
 */
export function JourneyNav(): JSX.Element {
  const [progress, setProgress] = useState<JourneyProgress>({
    begun: false,
    complete: false,
  });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/conversation/history")
      .then(async (response) => {
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as HistoryResponse;
        if (!cancelled) {
          setProgress(journeyProgressFromHistory(data));
        }
      })
      .catch(() => {
        // A load failure keeps the fresh-visitor defaults: nothing
        // unlocks by guesswork.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const stages = deriveJourneyStages(progress);
  return (
    <nav
      data-journey-nav
      aria-label="Your journey"
      className="flex flex-col gap-2"
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-teal">
        Your journey
      </p>
      <ol className="flex flex-col gap-1">
        {stages.map((stage, index) => (
          <li key={stage.id}>
            {stage.reached ? (
              <Link
                href={stage.href}
                aria-current={stage.current ? "step" : undefined}
                data-journey-stage-link={stage.id}
                className="flex min-h-11 items-center gap-3 rounded-xl border border-transparent px-3 py-2 hover:border-surface-border hover:bg-surface"
              >
                <span
                  aria-hidden="true"
                  className="font-mono text-xs text-muted"
                >
                  0{index + 1}
                </span>
                <span className="font-medium">
                  {stage.label}
                  {stage.current ? (
                    <span className="sr-only"> (you are here)</span>
                  ) : null}
                </span>
              </Link>
            ) : (
              <span
                data-journey-stage-locked={stage.id}
                aria-disabled="true"
                className="flex min-h-11 items-center gap-3 rounded-xl px-3 py-2 text-muted"
              >
                <span
                  aria-hidden="true"
                  className="font-mono text-xs"
                >
                  0{index + 1}
                </span>
                <span>{stage.label}</span>
                <LockGlyph />
                <span className="sr-only">
                  (locked — it opens as the journey reaches it)
                </span>
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
