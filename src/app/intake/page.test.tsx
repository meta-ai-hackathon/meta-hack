import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IntakePage from "./page";

function headingLevels(html: string): number[] {
  return [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
}

describe("Intake page shell", () => {
  it("renders exactly one h1 and mounts the wizard", () => {
    const html = renderToStaticMarkup(<IntakePage />);
    const h1Count = (html.match(/<h1[\s>]/g) ?? []).length;
    expect(h1Count).toBe(1);
    expect(html).toContain("data-intake-wizard");
  });

  it("keeps a hierarchical heading outline", () => {
    const levels = headingLevels(renderToStaticMarkup(<IntakePage />));
    expect(levels.length).toBeGreaterThan(0);
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i], `heading ${i + 1} skips a level`).toBeLessThanOrEqual(
        levels[i - 1] + 1,
      );
    }
  });
});
