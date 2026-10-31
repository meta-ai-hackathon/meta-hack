// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PILOT_CONFIG } from "../../../lib/pilot";

// The review section's request (VAL-RFEX-001): the review/export surface
// fetches the PILOT seam's registered form — the real DHB-5200 — never a
// hardcoded form id. The sample stays registered for the walkthrough
// journeys and the sample-based tests; the product surface does not touch
// it.

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.replaceChildren();
});

describe("ReviewSection's review request", () => {
  it("requests review for the pilot seam's form id, not a hardcoded sample", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.reject(new Error("short-circuit: the request is the assertion")),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { ReviewSection } = await import("./review-section");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(ReviewSection, { refreshKey: 0 }));
      for (let i = 0; i < 10; i += 1) {
        await new Promise((done) => setTimeout(done, 0));
      }
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/forms/${PILOT_CONFIG.formRegistryId}/review`,
    );
    // The seam really carries the real form (pinned in pilot.test.ts too;
    // repeated here so a seam regression cannot sneak past this suite).
    expect(PILOT_CONFIG.formRegistryId).toBe("dhb-5200");
  });

  it("static backstop: no literal form id in the component's review URL", () => {
    // The seam-driven rule is structural: the URL must be built from the
    // pilot config (or a server-provided id), so no literal
    // /api/forms/<id>/review path may appear in the component source.
    const source = readFileSync(
      path.join(import.meta.dirname, "review-section.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/\/api\/forms\/[a-z0-9][a-z0-9-]*\/review/);
  });
});
