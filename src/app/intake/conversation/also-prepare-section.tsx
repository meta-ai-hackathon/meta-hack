"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PILOT_CONFIG } from "../../../lib/pilot";
import { StatusRegion } from "../../../components/status-region";
import { ReviewSection } from "./review-section";

// The ask-once reuse entry point (snap-form milestone, VAL-SNAP-005): the
// results/review surface offers the session's OTHER applications ("also
// prepare"), so one session's answers prepare both applications from the
// same answers. The copy comes from the pilot seam and promises nothing:
// the program is decided solely by the agency; the app prepares, the
// person reviews, signs, and submits themselves. Choosing the control
// reveals the additional application's review below (the same
// form-agnostic review surface), moves focus to it — the disclosure is the
// navigation for keyboard and screen-reader users — and announces the
// change through the StatusRegion convention.

/**
 * The additional applications' entry points + their review surfaces.
 * Renders nothing when the pilot seam lists no additional applications.
 */
export function AlsoPrepareSection({
  refreshKey,
  stagger = false,
}: {
  refreshKey: number;
  stagger?: boolean;
}) {
  const applications = PILOT_CONFIG.additionalApplications;
  const [revealedIds, setRevealedIds] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState("");
  const focusTarget = useRef<HTMLDivElement | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current) {
        clearTimeout(noticeTimer.current);
      }
    },
    [],
  );

  const announce = useCallback((message: string) => {
    setNotice("");
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current);
    }
    // The StatusRegion must CHANGE its text to announce: clear, then set
    // on the next tick (the sections' shared convention).
    noticeTimer.current = setTimeout(() => setNotice(message), 30);
  }, []);

  if (applications.length === 0) {
    return null;
  }

  function reveal(formRegistryId: string, programName: string): void {
    setRevealedIds((previous) =>
      previous.includes(formRegistryId)
        ? previous
        : [...previous, formRegistryId],
    );
    announce(
      `Your ${programName} application review is below. Nothing is ` +
        "submitted — you review it, sign it, and submit it yourself.",
    );
    // Focus moves to the revealed review region (requestAnimationFrame:
    // the region mounts with this render).
    requestAnimationFrame(() => {
      focusTarget.current?.focus();
    });
  }

  return (
    <div data-also-prepare-section className="flex flex-col gap-6">
      {applications.map((application) => {
        const revealed = revealedIds.includes(application.formRegistryId);
        return (
          <div
            key={application.formRegistryId}
            data-also-prepare={application.formRegistryId}
            className="flex flex-col gap-4"
          >
            {!revealed ? (
              <section
                data-also-prepare-entry
                aria-labelledby={`also-prepare-heading-${application.formRegistryId}`}
                className="flex flex-col gap-3 rounded-2xl border border-surface-border bg-surface p-6"
              >
                <h2
                  id={`also-prepare-heading-${application.formRegistryId}`}
                  className="font-display text-2xl font-bold"
                >
                  {application.entryPoint.headline}
                </h2>
                <p className="text-sm text-muted">
                  {application.entryPoint.detail}
                </p>
                <button
                  type="button"
                  data-also-prepare-button={application.formRegistryId}
                  aria-expanded="false"
                  aria-controls={`also-prepare-review-${application.formRegistryId}`}
                  onClick={() =>
                    reveal(application.formRegistryId, application.programName)
                  }
                  className="rounded-full bg-teal-deep px-4 py-2 text-sm font-semibold text-teal-contrast hover:bg-teal"
                >
                  {application.entryPoint.action}
                </button>
              </section>
            ) : (
              <div
                id={`also-prepare-review-${application.formRegistryId}`}
                ref={focusTarget}
                tabIndex={-1}
                className="flex flex-col gap-4 focus:outline-none"
              >
                <ReviewSection
                  formId={application.formRegistryId}
                  refreshKey={refreshKey}
                  stagger={stagger}
                  idPrefix={application.formRegistryId}
                />
              </div>
            )}
          </div>
        );
      })}
      <div data-also-prepare-status>
        <StatusRegion message={notice} className="text-sm text-muted" />
      </div>
    </div>
  );
}
