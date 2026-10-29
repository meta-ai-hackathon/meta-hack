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
});
