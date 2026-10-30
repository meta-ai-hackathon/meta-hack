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

const SRC = fileURLToPath(new URL("../..", import.meta.url));

const DEVICE_PATH_ENTRIES = [
  "app/intake/intake-wizard.tsx",
  "app/intake/question-view.tsx",
  "lib/intake/device-intake.ts",
];

const SERVER_ONLY = [
  "lib/db.ts",
  "lib/vault.ts",
  "lib/telemetry.ts",
  "lib/model.ts",
  "lib/conversation.ts",
  "lib/intake/store.ts",
  "lib/intake/serialize.ts",
];

/**
 * The modules a file imports at runtime, by path relative to src. Type-only
 * imports are erased by the compiler, so they never reach the bundle.
 */
function localImports(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8");
  const specifiers = [
    ...source.matchAll(/^\s*(?:import|export)\s(?!type\s)[^;]*?from\s+"([^"]+)"/gm),
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
      if (file === "app/intake/intake-wizard.tsx") {
        // The wizard's server mode (the conversation page) still fetches;
        // its device branch is proven request-free by device-intake.test.ts.
        continue;
      }
      const source = readFileSync(join(SRC, file), "utf8");
      expect(source, `${file} makes a request`).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket\(/);
    }
  });
});
