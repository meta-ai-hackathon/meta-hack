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
  // The intake answer store (BN-09/BN-13) is the one authorized vault
  // consumer, and only through the vault module's validated API: it writes
  // pii values with vaultPut, removes disavowed values with vaultDelete
  // (BN-13 delete-on-disavow), and reads them back with vaultFlowValues —
  // the server-side read that exists solely so the flow engine can evaluate
  // skip conditions on pii answers. Those values never cross to a client:
  // the serialization boundary (lib/intake/serialize.ts) strips every pii
  // value before anything reaches a page, payload, or log.
  "lib/intake/store.ts",
  // The forms pipeline (Mission v2 M4) is the SECOND sanctioned vault
  // accessor (VAL-PDF-006): the fill reads pii values ONLY via
  // readVaultFieldsForFill, whose permit is derived in vault.ts from the
  // committed form-registry entry's per-form fill allowlist — a form may
  // read exactly the vault fields its reviewed registry entry names, and no
  // caller can hand-read an arbitrary list. Filled values flow into the
  // returned PDF bytes only: never into prompts, logs, or any client payload
  // other than the person's own downloaded application. Only the fill module
  // is admitted — every other forms file (parse/flow/registry/display) stays
  // outside the boundary exactly like the rest of src/.
  "lib/forms/fill.ts",
  // The session purge (Mission v2.1 M7, HACK-80) is the THIRD sanctioned
  // vault accessor: the person's delete-my-answers control must empty the
  // vault for their session, which only the vault module may do — via
  // purgeSessionVault, a session-scoped DELETE that removes every stored
  // value for THAT session (no field lists cross; nothing is read). The
  // purge runs inside one transaction, and the vault half deletes on the
  // caller's transaction connection so a half-finished purge can never
  // happen. Nothing the purge removes is ever logged (counts only).
  "lib/purge.ts",
]);

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** True when a module specifier resolves to the vault module. */
function isVaultSpecifier(specifier: string): boolean {
  return (
    // Relative specifiers at any depth, with or without the lib/ segment:
    // "./vault" from src/lib, "../lib/vault" from src/app/*, "../../lib/vault"
    // from deeper nests.
    /^(?:\.{1,2}\/)+(?:lib\/)?vault$/.test(specifier) ||
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
      'import { vaultPut } from "../vault";',
      "export const violate = vaultPut;",
      "",
    ].join("\n"),
  );
}

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

describe("import boundary (VAL-PII-001)", () => {
  it("recognizes every specifier form that resolves to the vault module", () => {
    const resolving = [
      "./vault",
      "../vault",
      "./lib/vault",
      "../lib/vault",
      "../../lib/vault",
      "@/lib/vault",
      "lib/vault",
    ];
    for (const specifier of resolving) {
      expect(isVaultSpecifier(specifier)).toBe(true);
    }
    const notResolving = [
      "./vault-boundary",
      "../lib/vault.test",
      "./vaultr",
      "react",
      "",
    ];
    for (const specifier of notResolving) {
      expect(isVaultSpecifier(specifier)).toBe(false);
    }
  });

  it("finds no vault imports outside vault.ts and the vault's own tests", () => {
    const { scanned, violations } = scanForVaultImports(SRC_ROOT);
    // Non-vacuous: the scan must have covered the vault module and its own
    // test files (exempted deliberately), not walked an empty tree.
    for (const exempt of EXEMPT_FILES) {
      expect(scanned).toContain(exempt);
    }
    expect(violations).toEqual([]);
  });

  it("admits only the fill module among the forms files, and scanned them", () => {
    // The forms admission is scoped: exactly one forms file is exempt, and
    // the scan provably walked every other forms module so a stray vault
    // import in parse/flow/registry/answers cannot slip through unscanned.
    const { scanned } = scanForVaultImports(SRC_ROOT);
    expect(EXEMPT_FILES.has("lib/forms/fill.ts")).toBe(true);
    // The fill module itself exists in the tree and was scanned.
    expect(scanned).toContain("lib/forms/fill.ts");
    for (const relative of scanned) {
      if (
        relative.startsWith("lib/forms/") &&
        relative !== "lib/forms/fill.ts" &&
        !relative.endsWith(".test.ts")
      ) {
        expect(EXEMPT_FILES.has(relative)).toBe(false);
      }
    }
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
