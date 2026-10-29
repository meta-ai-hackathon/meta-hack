import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ANSWER_STATUS_LABELS, ANSWER_STATUSES } from "../lib/honesty";
import { AnswerStatusBadge } from "./answer-status-badge";

describe("AnswerStatusBadge", () => {
  it("renders every status with its plain-language label and aria-label", () => {
    for (const status of ANSWER_STATUSES) {
      // React escapes quotes/apostrophes in markup; decode before matching.
      const html = renderToStaticMarkup(<AnswerStatusBadge status={status} />)
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&amp;/g, "&");
      expect(html, status).toContain(`data-status="${status}"`);
      expect(html, status).toContain(`aria-label="${ANSWER_STATUS_LABELS[status]}"`);
      expect(html, status).toContain(ANSWER_STATUS_LABELS[status]);
    }
  });
});
