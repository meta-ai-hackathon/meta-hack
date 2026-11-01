import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Import boundary for the tax-return parse path (VAL-INC-005; HACK-86/92).
// Mirrors src/lib/vault-boundary.test.ts: the 1040 parse module is
// deterministic ONLY. Every production module under src/lib/income/ must be
// free of model/LLM, conversation, and prompt imports; the parse module's
// transitive import graph must never leave the income folder (so no helper
// can smuggle the model client back in); and the module source itself must
// carry no network, logging, env, time, or randomness tokens — a pure
// function of its input bytes. A simulated violation fixture proves the
// scan bites.

const INCOME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** Static + dynamic import shapes, mirroring the vault boundary scan. */
const IMPORT_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** Specifiers that must NEVER appear in the income parse path. */
function isForbiddenSpecifier(specifier: string): boolean {
  // The repo's model/LLM clients and conversation/prompt modules, in any
  // relative-depth or alias spelling.
  if (/^(?:\.{1,2}\/)+(?:lib\/)?(?:model|conversation)(?:\.js)?$/.test(specifier)) {
    return true;
  }
  if (
    specifier === "@/lib/model" ||
    specifier === "#lib/model" ||
    specifier === "lib/model" ||
    specifier === "@/lib/conversation" ||
    specifier === "#lib/conversation" ||
    specifier === "lib/conversation"
  ) {
    return true;
  }
  // Prompt modules and LLM SDK packages, by name pattern.
  if (/(^|[/.])prompt/.test(specifier)) {
    return true;
  }
  if (/^(openai|anthropic|@anthropic-ai|@ai-sdk|ai|langchain|cohere|mistral|mistralai)(\/|$)/.test(specifier)) {
    return true;
  }
  return false;
}

function isExternal(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("#") && !specifier.startsWith("@/");
}

interface ScanResult {
  scanned: string[];
  violations: string[];
  externals: Set<string>;
}

/** Scan every non-test module under incomeRoot for forbidden imports. */
function scanIncomeImports(incomeRoot: string): ScanResult {
  const scanned: string[] = [];
  const violations: string[] = [];
  const externals = new Set<string>();
  for (const entry of readdirSync(incomeRoot, { recursive: true })) {
    const relative = String(entry).split(path.sep).join("/");
    if (!SOURCE_EXTENSIONS.some((ext) => relative.endsWith(ext))) {
      continue;
    }
    // Test files are not part of the runtime parse path; only production
    // modules are scanned (same convention as the vault boundary).
    if (relative.includes(".test.")) {
      continue;
    }
    scanned.push(relative);
    const source = readFileSync(path.join(incomeRoot, relative), "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      if (isForbiddenSpecifier(match[1])) {
        violations.push(`${relative}: ${match[1]}`);
      }
      if (isExternal(match[1])) {
        externals.add(match[1]);
      }
    }
  }
  return { scanned, violations, externals };
}

/** Resolve a relative specifier to a file under SRC_ROOT (best effort). */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    path.join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    try {
      if (readFileSync(candidate)) {
        return candidate;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Transitive closure of relative imports, starting from a module file. */
function importClosure(entryFile: string): string[] {
  const seen = new Set<string>([entryFile]);
  const queue = [entryFile];
  const closure: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    closure.push(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveRelative(file, specifier);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return closure;
}

const FIXTURE_DIR = path.join(INCOME_ROOT, "__boundary_fixture__");

function writeViolationFixture(): void {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(
    path.join(FIXTURE_DIR, "violator.ts"),
    [
      "// Simulated boundary violation: a module reaching for the model client.",
      'import { chatCompletion } from "../model";',
      "export const violate = chatCompletion;",
      "",
    ].join("\n"),
  );
}

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("tax-parse import boundary (VAL-INC-005)", () => {
  it("scans the income production modules and finds zero forbidden imports", () => {
    const result = scanIncomeImports(INCOME_ROOT);
    expect(result.scanned.length).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  it("admits only the two PDF libraries as external packages", () => {
    const result = scanIncomeImports(INCOME_ROOT);
    expect([...result.externals].sort()).toEqual(
      ["@cantoo/pdf-lib", "pdfjs-dist/legacy/build/pdf.mjs"],
    );
  });

  it("the parse module's transitive import graph never leaves the income folder", () => {
    const closure = importClosure(path.join(INCOME_ROOT, "tax-parse.ts"));
    expect(closure.length).toBeGreaterThan(0);
    for (const file of closure) {
      expect(file.startsWith(INCOME_ROOT)).toBe(true);
    }
  });

  it("the module source carries no network, logging, env, time, or randomness tokens", () => {
    const source = readFileSync(
      path.join(INCOME_ROOT, "tax-parse.ts"),
      "utf8",
    );
    for (const banned of [
      "console.",
      "fetch(",
      "XMLHttpRequest",
      "process.env",
      "Date.now",
      "new Date(",
      "Math.random",
    ]) {
      expect(source.includes(banned)).toBe(false);
    }
  });

  it("bites: a simulated model-client import is reported", () => {
    writeViolationFixture();
    const result = scanIncomeImports(INCOME_ROOT);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("__boundary_fixture__/violator.ts");
  });
});
