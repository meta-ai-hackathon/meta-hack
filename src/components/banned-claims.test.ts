import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findBannedClaims } from "../lib/honesty";

// CI gate for the honest-answers contract (BN-05): every non-test source file
// under src/ is scanned for banned promise language, so a violation fails the
// test run, not just a review (VAL-HON-002).

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    const isSource = /\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\./.test(entry);
    return isSource ? [full] : [];
  });
}

describe("UI string banned-claims scan", () => {
  it("finds zero banned claims across app source", () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const content = readFileSync(file, "utf8");
      for (const match of findBannedClaims(content)) {
        violations.push(
          `${file}: /${match.patternSource}/ matched "${match.matchedText}" at index ${match.index}`,
        );
      }
    }
    expect(violations.join("\n"), violations.length ? "banned claims found" : "").toEqual(
      "",
    );
  });

  it("scans the surfaces that carry UI copy (non-vacuous)", () => {
    const files = sourceFiles(SRC_ROOT);
    for (const expected of [
      "app/page.tsx",
      "app/layout.tsx",
      "components/answer-status-badge.tsx",
      "lib/honesty.ts",
    ]) {
      expect(files.some((f) => f.endsWith(expected)), expected).toBe(true);
    }
  });

  it("names the step-by-step path once — the retired names appear nowhere in app source (HACK-161, VAL-UX-009)", () => {
    // The path's ONE name is "the step-by-step form". The ticket found it
    // named three ways ("Use the form instead" on home, "Use the wizard
    // instead" on the conversation page, "use the step-by-step form" on
    // the sharing screen) plus a fourth on the error fallback ("Open the
    // wizard") and a misdirected "the wizard below". None may return, and
    // the intake intro never promises "a few" questions beside its honest
    // counter. Raw-content scan: these exact phrases cannot occur in
    // identifiers, so a hit is always a copy (or comment) regression on a
    // user-facing surface.
    const retired: readonly (readonly [RegExp, string])[] = [
      [/Use the wizard instead/i, 'the conversation link "Use the wizard instead"'],
      [/Open the wizard/i, 'the error fallback "Open the wizard"'],
      [/the wizard below/i, 'the shield notice "the wizard below"'],
      [/Use the form instead/i, 'the home link "Use the form instead"'],
      [/the step-by-step questions/i, 'the path named "the step-by-step questions"'],
      [/a few plain-language/i, 'the "a few" question-count promise'],
    ];
    const violations: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const content = readFileSync(file, "utf8");
      for (const [pattern, what] of retired) {
        if (pattern.test(content)) violations.push(`${file}: ${what}`);
      }
    }
    expect(
      violations.join("\n"),
      violations.length ? "retired path names found" : "",
    ).toEqual("");
  });
});
