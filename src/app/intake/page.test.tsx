import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IntakeWizard } from "./intake-wizard";
import IntakePage, { metadata } from "./page";
import { ServerAnswersNotice } from "./server-answers-notice";

/** Every element in a tree returned by a component, without rendering children components. */
function elements(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) {
    return Array.isArray(node) ? node.flatMap(elements) : [];
  }
  const children = (node.props as { children?: ReactNode }).children;
  return [node, ...elements(children)];
}

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

  it("runs the wizard in device mode, under the notice for answers saved on the server before (HACK-99)", () => {
    const tree = elements(IntakePage());
    const wizard = tree.find((element) => element.type === IntakeWizard);
    expect((wizard?.props as { persistence?: string } | undefined)?.persistence).toBe("device");
    const notice = tree.findIndex((element) => element.type === ServerAnswersNotice);
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(notice).toBeLessThan(tree.findIndex((element) => element.type === IntakeWizard));
  });

  it("carries a meta description with no a-few promise (HACK-161, VAL-UX-009)", () => {
    // The page opens with the honest "Answered 0 of 61 questions" counter,
    // so its description never promises "a few" questions either — same
    // over-claim, same page, dropped in the same PR.
    expect(metadata.description).not.toMatch(/a few/i);
    expect(metadata.description).toMatch(/Plain-language questions, one at a time/);
    expect(metadata.description).toMatch(/Nothing you enter on this page is sent to us/);
  });
});
