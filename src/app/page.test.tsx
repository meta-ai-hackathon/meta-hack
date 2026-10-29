import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ANSWER_STATUSES } from "../lib/honesty";
import Home from "./page";

describe("Home page", () => {
  it("renders the app title as a single h1", () => {
    const html = renderToStaticMarkup(<Home />);
    const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
    expect(h1Count).toBe(1);
    expect(html).toContain("Benefits Navigator");
  });

  it("demonstrates every honest answer status with its badge", () => {
    const html = renderToStaticMarkup(<Home />);
    for (const status of ANSWER_STATUSES) {
      expect(html, status).toContain(`data-status="${status}"`);
    }
  });
});
