import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CROSSING_ALLOWLIST, VAULT_FIELDS } from "./vault";

// Static import-boundary check for the PII vault (VAL-PII-001): no module
// under src/ may import vault accessors except vault.ts itself and the
// vault's own test files. A simulated violation fixture proves the check
// actually fails when the boundary is violated.

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SPEC_PATH = new URL(
  "../../specs/question-spec/generic-questions.json",
  import.meta.url,
);
const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
  questions: { id: string; pii: boolean }[];
};
const SPEC_PII_FIELDS: readonly string[] = spec.questions
  .filter((question) => question.pii)
  .map((question) => question.id);

/** Files allowed to reference the vault module: the module and its own tests. */
const EXEMPT_FILES = new Set([
  "lib/vault.ts",
  "lib/vault.test.ts",
  "lib/vault-boundary.test.ts",
]);

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** True when a module specifier resolves to the vault module. */
function isVaultSpecifier(specifier: string): boolean {
  return (
    /^(\.{1,2}\/)+vault$/.test(specifier) ||
    specifier === "@/lib/vault" ||
    specifier === "#lib/vault" ||
    specifier === "lib/vault"
  );
}

const IMPORT_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

interface ScanResult {
  scanned: string[];
  violations: string[];
}

function scanForVaultImports(rootDir: string): ScanResult {
  const scanned: string[] = [];
  const violations: string[] = [];
  for (const entry of readdirSync(rootDir, { recursive: true })) {
    const relative = String(entry).split(path.sep).join("/");
    if (!SOURCE_EXTENSIONS.some((extension) => relative.endsWith(extension))) {
      continue;
    }
    scanned.push(relative);
    if (EXEMPT_FILES.has(relative)) {
      continue;
    }
    const source = readFileSync(path.join(rootDir, relative), "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      if (isVaultSpecifier(match[1])) {
        violations.push(relative);
        break;
      }
    }
  }
  return { scanned, violations };
}

const FIXTURE_DIR = path.join(SRC_ROOT, "lib", "__vault_boundary_fixture__");

function writeViolationFixture(): void {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(
    path.join(FIXTURE_DIR, "violator.ts"),
    [
      "// Simulated boundary violation: a module reaching for a vault accessor.",
      'import { vaultPut } from "../../vault";',
      "export const violate = vaultPut;",
      "",
    ].join("\n"),
  );
}

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("import boundary (VAL-PII-001)", () => {
  it("finds no vault imports outside vault.ts and the vault's own tests", () => {
    const { scanned, violations } = scanForVaultImports(SRC_ROOT);
    // Non-vacuous: the scan must have covered the vault module and its own
    // test files (exempted deliberately), not walked an empty tree.
    for (const exempt of EXEMPT_FILES) {
      expect(scanned).toContain(exempt);
    }
    expect(violations).toEqual([]);
  });

  it("fails when violated: a fixture importing vaultPut is reported", () => {
    writeViolationFixture();
    try {
      const { violations } = scanForVaultImports(SRC_ROOT);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("__vault_boundary_fixture__");
    } finally {
      rmSync(FIXTURE_DIR, { recursive: true, force: true });
    }
  });
});

describe("vault field classification derives from the question spec", () => {
  it("VAULT_FIELDS is exactly the spec's pii:true set", () => {
    expect([...VAULT_FIELDS].sort()).toEqual([...SPEC_PII_FIELDS].sort());
  });

  it("CROSSING_ALLOWLIST never contains a pii:true field (they are vault-only)", () => {
    for (const field of CROSSING_ALLOWLIST) {
      expect(SPEC_PII_FIELDS).not.toContain(field);
      expect(VAULT_FIELDS).not.toContain(field);
    }
  });
});
