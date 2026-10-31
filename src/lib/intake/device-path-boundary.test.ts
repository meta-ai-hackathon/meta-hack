import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
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
 * The modules a file imports at runtime, by path relative to src, loaded
 * up front or on demand with import(). Type-only imports are erased by the
 * compiler, so they never reach the bundle.
 */
function localImports(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8");
  const specifiers = [
    ...source.matchAll(/^\s*(?:import|export)\s(?!type\s)[^;]*?from\s+"([^"]+)"/gm),
    ...source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g),
  ].map((match) => match[1]);
  const local: string[] = [];
  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) {
      continue;
    }
    const base = join(dirname(join(SRC, file)), specifier);
    const resolved = [".ts", ".tsx", "/index.ts"].map((ext) => base + ext).find(existsSync);
    if (resolved) {
      local.push(relative(SRC, resolved));
    }
  }
  return local;
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
