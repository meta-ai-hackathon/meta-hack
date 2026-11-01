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
const SRC_ROOT = path.resolve(INCOME_ROOT, "..", "..");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** Static + dynamic import shapes, mirroring the vault boundary scan. */
const IMPORT_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** Specifiers that must NEVER appear in the income parse path. */
function isForbiddenSpecifier(specifier: string): boolean {
  // The repo's model/LLM clients and conversation/prompt modules, in any
  // relative-depth or alias spelling — including subpaths (a wrapper that
  // re-exports the client is still the model client).
  if (
    /^(?:\.{1,2}\/)+(?:lib\/)?(?:model|conversation)(?:\.js)?(?:\/|$)/.test(
      specifier,
    ) ||
    /^(?:@|#\/)lib\/(?:model|conversation)(?:\.js)?(?:\/|$)/.test(specifier)
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

/**
 * True when a specifier reaches OUTSIDE the income folder via the repo's
 * path alias (`@/*` → `src/*`, `#lib/*` → `src/lib/*`): the parse graph
 * must stay inside src/lib/income, so any other alias target is an escape
 * the scan reports (it could resolve to the model client transitively).
 */
function isAliasEscape(specifier: string): boolean {
  if (!specifier.startsWith("@/") && !specifier.startsWith("#/")) {
    return false;
  }
  const target = specifier.replace(/^@\/?|^#\/?/, "").replace(/\.js$/, "");
  return !(target === "lib/income" || target.startsWith("lib/income/"));
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
        violations.push(`${relative}: forbidden import ${match[1]}`);
      }
      if (isAliasEscape(match[1])) {
        violations.push(`${relative}: alias escape ${match[1]}`);
      }
      if (isExternal(match[1])) {
        externals.add(match[1]);
      }
    }
  }
  return { scanned, violations, externals };
}

/** Resolve a relative or income-alias specifier to a file (best effort). */
function resolveRelative(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/") || specifier.startsWith("#/")) {
    const target = specifier.replace(/^@\/?|^#\/?/, "");
    base = path.resolve(SRC_ROOT, target);
  } else {
    base = path.resolve(path.dirname(fromFile), specifier);
  }
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

interface Closure {
  files: string[];
  /** Alias specifiers that leave the income folder. */
  escapes: string[];
}

/** Transitive closure of in-folder imports, starting from a module file. */
function importClosure(entryFile: string): Closure {
  const seen = new Set<string>([entryFile]);
  const queue = [entryFile];
  const files: string[] = [];
  const escapes: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    files.push(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (isAliasEscape(specifier)) {
        escapes.push(specifier);
        continue;
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("@/") && !specifier.startsWith("#/")) {
        continue;
      }
      const resolved = resolveRelative(file, specifier);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return { files, escapes };
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
  writeFileSync(
    path.join(FIXTURE_DIR, "alias-escaper.ts"),
    [
      "// Simulated alias escape: the alias leaves the income folder (the",
      "// target itself imports the model client transitively).",
      'import { parseFormPdf } from "@/lib/forms/parse";',
      "export const violate = parseFormPdf;",
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
    expect(closure.files.length).toBeGreaterThan(0);
    for (const file of closure.files) {
      expect(file.startsWith(INCOME_ROOT)).toBe(true);
    }
    expect(closure.escapes).toEqual([]);
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
    expect(result.violations).toHaveLength(2);
    expect(result.violations).toContainEqual(
      expect.stringContaining(
        "__boundary_fixture__/violator.ts: forbidden import ../model",
      ),
    );
    expect(result.violations).toContainEqual(
      expect.stringContaining(
        "__boundary_fixture__/alias-escaper.ts: alias escape @/lib/forms/parse",
      ),
    );
  });
});
