import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

// The on-device intake's boundary (HACK-99), checked on the source: the
// step-by-step page's answer path runs in the browser, so nothing it
// imports may reach a server module (the database, the server vault, the
// server answer store, telemetry, the model client) or a Node built-in, and
// none of it may make a network request. A regression here would either
// break the page's bundle or open a path for answers to leave the device.
//
// The path includes the match, the form review, and the fill the page
// computes once the questions are done (HACK-115). The one request on it
// is the GET for the blank public form, in device-template.ts.

const SRC = fileURLToPath(new URL("../..", import.meta.url));

const DEVICE_PATH_ENTRIES = [
  "app/intake/intake-wizard.tsx",
  "app/intake/question-view.tsx",
  "app/intake/device-results.tsx",
  "lib/intake/device-intake.ts",
  "lib/intake/device-form.ts",
  "lib/intake/device-fill.ts",
  "lib/intake/device-template.ts",
];

const SERVER_ONLY = [
  "lib/db.ts",
  "lib/vault.ts",
  "lib/telemetry.ts",
  "lib/model.ts",
  "lib/conversation.ts",
  "lib/intake/store.ts",
  "lib/intake/serialize.ts",
  // The server halves of the match, the registry, and the fill, and the
  // forms modules that only the server runs.
  "lib/match.ts",
  "lib/forms/registry.ts",
  "lib/forms/fill.ts",
  "lib/forms/parse.ts",
  "lib/forms/packet.ts",
  "lib/forms/fax.ts",
  "lib/purge.ts",
];

/** The one module on the path allowed a request: the blank form's GET. */
const TEMPLATE_LOADER = "lib/intake/device-template.ts";

/** Any reference to a browser API that can send data off the device. */
const REQUEST_API = /\bfetch\b|XMLHttpRequest|sendBeacon|WebSocket|EventSource/;

/**
 * Every module a file loads at runtime: imports and re-exports, imports run
 * only for their side effects, and import() of a literal path, in either
 * quote style. Type-only imports are erased by the compiler, so they never
 * reach the bundle.
 */
function runtimeSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/^\s*(?:import|export)\s(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
}

/** A specifier for a file in this repo: a relative path, or one through tsconfig's "@/" alias for src. */
function isLocal(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("@/");
}

/** What a local specifier may leave off, as the bundler resolves it. */
const MODULE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

/** Source the bundler runs, as opposed to data or styles a module imports. */
const CODE_FILE = /\.[cm]?[jt]sx?$/;

/** The file a local specifier written in `file` names, by path relative to src, or null for none. */
function resolveLocal(file: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : join(dirname(join(SRC, file)), specifier);
  const found = MODULE_SUFFIXES.map((suffix) => base + suffix).find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  return found === undefined ? null : relative(SRC, found);
}

/**
 * The repo modules a file loads at runtime, by path relative to src, up
 * front or on demand with import(). A local import this check can't follow
 * could lead anywhere, so it fails the check instead of being skipped.
 */
function localImports(file: string, source = readFileSync(join(SRC, file), "utf8")): string[] {
  const local: string[] = [];
  for (const specifier of runtimeSpecifiers(source)) {
    if (!isLocal(specifier)) {
      continue;
    }
    const resolved = resolveLocal(file, specifier);
    if (resolved === null) {
      throw new Error(`${file} imports ${specifier}, which the boundary check can't resolve`);
    }
    if (CODE_FILE.test(resolved)) {
      local.push(resolved);
    }
  }
  return local;
}

/** The packages a file loads at runtime, by name. */
function packageImports(source: string): string[] {
  return runtimeSpecifiers(source).filter((specifier) => !isLocal(specifier));
}

/**
 * A package the browser can't run or that only the server may: Node's
 * built-ins, with or without "node:", and the database driver.
 */
function isServerPackage(specifier: string): boolean {
  return specifier === "postgres" || specifier.startsWith("node:") || builtinModules.includes(specifier);
}

function reachable(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    queue.push(...localImports(file));
  }
  return seen;
}

describe("the on-device intake path", () => {
  const files = reachable(DEVICE_PATH_ENTRIES);

  it("reaches the modules it is meant to (non-vacuous)", () => {
    for (const expected of [
      "lib/intake/device-answer-store.ts",
      "lib/intake/client-store.ts",
      "lib/intake/client-state.ts",
      "lib/intake/answer-input.ts",
      "lib/device-kv.ts",
      "app/intake/device-results.tsx",
      "lib/intake/device-form.ts",
      "lib/intake/device-fill.ts",
      "lib/intake/device-template.ts",
      "lib/match-core.ts",
      "lib/kb.ts",
      "lib/glossary.ts",
      "lib/forms/fill-core.ts",
      "lib/forms/registry-core.ts",
      "lib/forms/flow.ts",
      "lib/forms/display.ts",
      "lib/forms/disposition.ts",
    ]) {
      expect(files.has(expected), expected).toBe(true);
    }
  });

  it("imports no server module and no Node built-in", () => {
    for (const file of files) {
      expect(SERVER_ONLY.includes(file), `${file} is server-only`).toBe(false);
      const source = readFileSync(join(SRC, file), "utf8");
      expect(source, `${file} imports a Node built-in`).not.toMatch(/from\s+"node:/);
      expect(source, `${file} imports postgres`).not.toMatch(/from\s+"postgres"/);
      for (const specifier of packageImports(source)) {
        expect(isServerPackage(specifier), `${file} loads ${specifier}`).toBe(false);
      }
    }
  });

  it("makes no network request below the wizard", () => {
    for (const file of files) {
      if (file === "app/intake/intake-wizard.tsx" || file === TEMPLATE_LOADER) {
        // The wizard's server mode (the conversation page) still fetches.
        // Its device mode is driven through the DOM with fetch failing the
        // run in app/intake/intake-wizard.device.test.tsx. The template
        // loader is checked on its own below.
        continue;
      }
      const source = readFileSync(join(SRC, file), "utf8");
      expect(source, `${file} makes a request`).not.toMatch(REQUEST_API);
    }
  });

  it("loads pdf-lib only with the fill, which the page imports on demand", () => {
    // The questions never wait on the PDF library: it reaches the browser
    // only when the person downloads their filled form.
    for (const file of files) {
      const source = readFileSync(join(SRC, file), "utf8");
      const loadsPdfLib = /^\s*import\s(?!type\s)[^;]*?from\s+"@cantoo\/pdf-lib"/m.test(source);
      expect(loadsPdfLib, `${file} loads pdf-lib`).toBe(file === "lib/intake/device-fill.ts");
      expect(source, `${file} loads the fill up front`).not.toMatch(
        /^\s*(?:import|export)\s(?!type\s)[^;]*?from\s+"[^"]*\/device-fill"/m,
      );
    }
  });

  it("asks only for the blank form, with nothing in the request", () => {
    // Its exact request (one bodiless GET, no cookies, no referrer) is
    // pinned in device-template.test.ts; the page-level DOM test shows no
    // request URL or body carries an answer.
    const source = readFileSync(join(SRC, TEMPLATE_LOADER), "utf8");
    expect(source).toMatch(/fetchImpl\(deviceTemplateUrl\(entry\), \{/);
    expect(source.match(/fetchImpl\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\bbody\s*:|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
    expect(source).toMatch(/method: "GET"/);
    expect(source).toMatch(/credentials: "omit"/);
  });
});

describe("the boundary check's reading of imports", () => {
  // The checks above are only as good as this reading: an import spelled a
  // way it skipped would bring a server module onto the path unseen. So
  // however a device module writes an import of a server module, the check
  // must follow it there.
  const files = [...reachable(DEVICE_PATH_ENTRIES)];

  /** A specifier for `target` as written in `file`, without its extension. */
  function specifierFor(file: string, target: string, alias: boolean): string {
    const bare = target.replace(/\.tsx?$/, "");
    if (alias) {
      return `@/${bare}`;
    }
    const path = relative(dirname(join(SRC, file)), join(SRC, bare));
    return path.startsWith(".") ? path : `./${path}`;
  }

  const STATEMENTS: readonly ((specifier: string) => string)[] = [
    (specifier) => `import { loaded } from ${specifier};`,
    (specifier) => `import * as loaded from ${specifier};`,
    (specifier) => `import loaded, {\n  other,\n  type Shape,\n} from ${specifier};`,
    (specifier) => `export { loaded } from ${specifier};`,
    (specifier) => `export * from ${specifier};`,
    (specifier) => `import ${specifier};`,
    (specifier) => `const loaded = await import(${specifier});`,
  ];

  const importOfServerModule = fc.record({
    file: fc.constantFrom(...files),
    target: fc.constantFrom(...SERVER_ONLY),
    alias: fc.boolean(),
    quote: fc.constantFrom('"', "'"),
    statement: fc.constantFrom(...STATEMENTS),
  });

  it("follows an import of a server module however it is written", () => {
    fc.assert(
      fc.property(importOfServerModule, ({ file, target, alias, quote, statement }) => {
        const source = statement(`${quote}${specifierFor(file, target, alias)}${quote}`);
        expect(localImports(file, source)).toContain(target);
      }),
    );
  });

  it("fails on a local import it can't resolve instead of skipping it", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...files),
        fc.stringMatching(/^[a-z]{4,10}$/),
        fc.boolean(),
        (file, name, alias) => {
          const missing = alias ? `@/lib/no-such-module-${name}` : `./no-such-module-${name}`;
          expect(() => localImports(file, `import { loaded } from "${missing}";`)).toThrow(
            /can't resolve/,
          );
        },
      ),
    );
  });

  it("names every Node built-in a server package, with or without the node: prefix", () => {
    const builtins = builtinModules.filter((name) => !name.startsWith("node:") && !name.startsWith("_"));
    fc.assert(
      fc.property(fc.constantFrom(...builtins), fc.boolean(), (name, prefixed) => {
        const specifier = prefixed ? `node:${name}` : name;
        expect(packageImports(`import loaded from "${specifier}";`)).toEqual([specifier]);
        expect(isServerPackage(specifier)).toBe(true);
      }),
    );
    // The packages the path does load stay allowed.
    for (const specifier of ["react", "@cantoo/pdf-lib"]) {
      expect(isServerPackage(specifier)).toBe(false);
    }
  });
});
