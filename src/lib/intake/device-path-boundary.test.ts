import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The on-device intake's boundary (HACK-99), checked on the source: the
// step-by-step page's answer path runs in the browser, so nothing it
// imports may reach a server module (the database, the server vault, the
// server answer store, telemetry, the model client) or a Node built-in, and
// none of it may make a network request. A regression here would either
// break the page's bundle or open a path for answers to leave the device.
//
// The path includes the match, the form review, the fill, and the print
// preview the page computes once the questions are done (HACK-115). The one
// request on it is the GET for the blank public form, in
// device-template.ts. The filled form itself is never saved to the device:
// the modules that hold it are checked for every way to save it below.

const SRC = fileURLToPath(new URL("../..", import.meta.url));

const DEVICE_PATH_ENTRIES = [
  "app/intake/intake-wizard.tsx",
  "app/intake/question-view.tsx",
  "app/intake/device-results.tsx",
  "lib/intake/device-intake.ts",
  "lib/intake/device-form.ts",
  "lib/intake/device-fill.ts",
  "lib/intake/device-print.ts",
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

/**
 * Any reference to a browser API that can send data off the device: the
 * request APIs, an image or a new window pointed at a URL, a page
 * navigation, a worker (whose own requests this check can't see), and
 * import() of anything but a literal path, which could be any URL.
 */
const REQUEST_API = new RegExp(
  [
    String.raw`\bfetch(?:Later)?\b`,
    "XMLHttpRequest",
    "sendBeacon",
    "WebSocket",
    "EventSource",
    "WebTransport",
    "RTCPeerConnection",
    String.raw`\bnew\s+(?:Image|Worker|SharedWorker)\b`,
    String.raw`\bwindow\.open\b`,
    String.raw`\blocation\.(?:assign|replace)\b`,
    String.raw`\bimport\(\s*(?!["'])`,
  ].join("|"),
);

/**
 * The modules a file loads up front, with the page: imports and re-exports,
 * and imports run only for their side effects, in either quote style.
 * Type-only imports are erased by the compiler, so they never reach the
 * bundle.
 */
function upFrontSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/^\s*(?:import|export)\s(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm),
    ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
  ].map((match) => match[1]);
}

/** Every module a file loads at runtime: the up front ones, plus import() of a literal path. */
function runtimeSpecifiers(source: string): string[] {
  return [
    ...upFrontSpecifiers(source),
    ...[...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]),
  ];
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

/** The one module on the path allowed to load pdf-lib, and only on demand. */
const FILL_MODULE = "lib/intake/device-fill.ts";

/** Whether a file loads pdf-lib at all, up front or with import(). */
function loadsPdfLib(source: string): boolean {
  return packageImports(source).some(
    (specifier) => specifier === "@cantoo/pdf-lib" || specifier.startsWith("@cantoo/pdf-lib/"),
  );
}

/** Whether a file loads the PDF fill with the page instead of on demand. */
function loadsFillUpFront(file: string, source: string): boolean {
  return upFrontSpecifiers(source)
    .filter(isLocal)
    .some((specifier) => resolveLocal(file, specifier) === FILL_MODULE);
}

/** The one module on the path allowed to load pdf.js, and only on demand. */
const PRINT_MODULE = "lib/intake/device-print.ts";

/** A specifier for pdf.js or one of its files. */
function isPdfJs(specifier: string): boolean {
  return specifier === "pdfjs-dist" || specifier.startsWith("pdfjs-dist/");
}

/** Whether a file loads pdf.js at all, up front or with import(). */
function loadsPdfJs(source: string): boolean {
  return packageImports(source).some(isPdfJs);
}

/** Whether a file loads pdf.js with the page instead of on demand. */
function loadsPdfJsUpFront(source: string): boolean {
  return upFrontSpecifiers(source).some(isPdfJs);
}

/** Whether a file loads the print preview with the page instead of on demand. */
function loadsPrintUpFront(file: string, source: string): boolean {
  return upFrontSpecifiers(source)
    .filter(isLocal)
    .some((specifier) => resolveLocal(file, specifier) === PRINT_MODULE);
}

/**
 * The modules that hold the filled form (HACK-115): the fill that makes it,
 * the print preview that draws it, and the page that shows it. The owner
 * decided on HACK-115 (Nov 3) that the filled form leaves the page only on
 * paper, so none of them may save it to the device.
 */
const FILLED_FORM_HOLDERS = ["lib/intake/device-fill.ts", PRINT_MODULE, "app/intake/device-results.tsx"];

/**
 * Names in code that save something to the device or hand the browser a
 * file to save: an object URL and the Blob behind it, a download attribute,
 * the save file picker, a canvas turned into an image file, the browser's
 * storage, and a service worker, which can keep what passes through it.
 */
const SAVING_NAMES = new Set([
  "createObjectURL",
  "Blob",
  "download",
  "showSaveFilePicker",
  "toBlob",
  "toDataURL",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "serviceWorker",
]);

/**
 * Elements that show a document inside the page. A browser may start a
 * download of a PDF one shows (Android Chrome does) or offer one (desktop
 * PDF viewers do).
 */
const EMBEDDING_ELEMENTS = new Set(["iframe", "frame", "embed", "object"]);

/**
 * What in a file's code could save the filled form, each by what it is.
 * The file is parsed, so comments and copy that talk about downloads or
 * storage don't count: only code does.
 */
function savingConstructs(file: string, source = readFileSync(join(SRC, file), "utf8")): string[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isTag =
        (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === node;
      if (SAVING_NAMES.has(node.text) || (isTag && EMBEDDING_ELEMENTS.has(node.text.toLowerCase()))) {
        found.push(isTag ? `<${node.text}>` : node.text);
      }
    }
    if (ts.isStringLiteralLike(node) && node.text.toLowerCase() === "download") {
      // setAttribute("download", ...), element["download"], a JSX value.
      found.push(JSON.stringify(node.text));
    }
    if (ts.isCallExpression(node)) {
      // document.createElement("iframe"), createElementNS(ns, "object").
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : "";
      if (/^createElement(?:NS)?$/.test(name)) {
        for (const argument of node.arguments) {
          if (ts.isStringLiteralLike(argument) && EMBEDDING_ELEMENTS.has(argument.text.toLowerCase())) {
            found.push(`${name}(${JSON.stringify(argument.text)})`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

/**
 * Names in the print preview's code that would send pdf.js to the network
 * or into a Worker: a document URL, a worker or its script, and the
 * locations pdf.js would request font, CMap, ICC, or wasm files from.
 */
const PDFJS_REQUEST_OPTIONS = new Set([
  "url",
  "worker",
  "PDFWorker",
  "workerSrc",
  "workerPort",
  "standardFontDataUrl",
  "cMapUrl",
  "iccUrl",
  "wasmUrl",
  "docBaseUrl",
]);

/** Every identifier in a file's code. */
function identifiersIn(file: string, source = readFileSync(join(SRC, file), "utf8")): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      names.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return names;
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
      "lib/intake/device-print.ts",
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
    // only when the person asks to see their filled form.
    for (const file of files) {
      const source = readFileSync(join(SRC, file), "utf8");
      expect(loadsPdfLib(source), `${file} loads pdf-lib`).toBe(file === FILL_MODULE);
      expect(loadsFillUpFront(file, source), `${file} loads the fill up front`).toBe(false);
    }
  });

  it("loads pdf.js only in the print preview, with import(), and the page loads the preview on demand", () => {
    // pdf.js reaches the browser only when the person asks to see their
    // filled form, never with the questions.
    for (const file of files) {
      const source = readFileSync(join(SRC, file), "utf8");
      expect(loadsPdfJs(source), `${file} loads pdf.js`).toBe(file === PRINT_MODULE);
      expect(loadsPdfJsUpFront(source), `${file} loads pdf.js up front`).toBe(false);
      expect(loadsPrintUpFront(file, source), `${file} loads the print preview up front`).toBe(false);
    }
  });

  it("never saves the filled form to the device", () => {
    // No object URL, Blob, or download attribute, nothing that embeds the
    // PDF in the page, no image file made from a page, and none of the
    // browser's storage. Printing to paper is the one way out.
    for (const file of FILLED_FORM_HOLDERS) {
      expect(files.has(file), `${file} is on the path`).toBe(true);
      expect(savingConstructs(file), `${file} could save the filled form`).toEqual([]);
    }
  });

  it("gives pdf.js nothing that would send it to the network or into a Worker", () => {
    // The print preview hands pdf.js the filled bytes and nothing else; the
    // worker hook keeps it on the page's thread (device-print.test.ts).
    const names = identifiersIn(PRINT_MODULE);
    expect(names, "the print preview opens its document with getDocument").toContain("getDocument");
    for (const name of names) {
      expect(PDFJS_REQUEST_OPTIONS.has(name), `the print preview uses ${name}`).toBe(false);
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

  /** Ways to write an import, and whether each loads its module with the page. */
  const STATEMENTS: readonly { readonly write: (specifier: string) => string; readonly upFront: boolean }[] = [
    { write: (specifier) => `import { loaded } from ${specifier};`, upFront: true },
    { write: (specifier) => `import * as loaded from ${specifier};`, upFront: true },
    { write: (specifier) => `import loaded, {\n  other,\n  type Shape,\n} from ${specifier};`, upFront: true },
    { write: (specifier) => `export { loaded } from ${specifier};`, upFront: true },
    { write: (specifier) => `export * from ${specifier};`, upFront: true },
    { write: (specifier) => `import ${specifier};`, upFront: true },
    { write: (specifier) => `const loaded = await import(${specifier});`, upFront: false },
  ];

  const spelling = fc.record({
    file: fc.constantFrom(...files),
    alias: fc.boolean(),
    quote: fc.constantFrom('"', "'"),
    statement: fc.constantFrom(...STATEMENTS),
  });

  it("follows an import of a server module however it is written", () => {
    fc.assert(
      fc.property(spelling, fc.constantFrom(...SERVER_ONLY), ({ file, alias, quote, statement }, target) => {
        const source = statement.write(`${quote}${specifierFor(file, target, alias)}${quote}`);
        expect(localImports(file, source)).toContain(target);
      }),
    );
  });

  it("sees pdf-lib, and the fill loaded with the page, however they are written", () => {
    fc.assert(
      fc.property(spelling, ({ file, alias, quote, statement }) => {
        expect(loadsPdfLib(statement.write(`${quote}@cantoo/pdf-lib${quote}`))).toBe(true);
        const fill = statement.write(`${quote}${specifierFor(file, FILL_MODULE, alias)}${quote}`);
        // Only import() leaves the fill out of the page's first load.
        expect(loadsFillUpFront(file, fill)).toBe(statement.upFront);
      }),
    );
  });

  it("sees pdf.js, and the print preview loaded with the page, however they are written", () => {
    const pdfJs = fc.constantFrom(
      "pdfjs-dist",
      "pdfjs-dist/legacy/build/pdf.mjs",
      "pdfjs-dist/legacy/build/pdf.worker.mjs",
      "pdfjs-dist/build/pdf.mjs",
    );
    fc.assert(
      fc.property(spelling, pdfJs, ({ file, alias, quote, statement }, specifier) => {
        const engine = statement.write(`${quote}${specifier}${quote}`);
        expect(loadsPdfJs(engine)).toBe(true);
        // Only import() leaves pdf.js, and the preview, out of the page's first load.
        expect(loadsPdfJsUpFront(engine)).toBe(statement.upFront);
        const preview = statement.write(`${quote}${specifierFor(file, PRINT_MODULE, alias)}${quote}`);
        expect(loadsPrintUpFront(file, preview)).toBe(statement.upFront);
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
    for (const specifier of [
      "react",
      "@cantoo/pdf-lib",
      "pdfjs-dist/legacy/build/pdf.mjs",
      "pdfjs-dist/legacy/build/pdf.worker.mjs",
    ]) {
      expect(isServerPackage(specifier)).toBe(false);
    }
  });
});

describe("the boundary check's reading of what saves to the device", () => {
  // The save check reads code, so it must catch each way the filled form
  // could reach the device wherever it sits among ordinary statements, and
  // never mistake a comment or a sentence of copy for code.
  const statement = fc.constantFrom(
    "const pages = 21;",
    "function label(page) { return `Page ${page}`; }",
    "if (pages > 0) { release(); }",
    "// Nothing here keeps a download, a Blob, or localStorage.",
    "/* An iframe or an object URL would save the form. */",
    'const note = "Nothing is saved to this device, and there is no download.";',
    "const frame = <div role=\"img\" aria-label={label(1)} />;",
  );
  const surrounding = fc.array(statement, { maxLength: 4 });

  it("flags every way to save the filled form, wherever it sits in the code", () => {
    const saves = fc.constantFrom(
      "const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))",
      "const file = new Blob([bytes])",
      "anchor.download = name",
      "anchor.setAttribute('download', name)",
      'anchor["download"] = name',
      "const link = <a href={url} download={name}>Save</a>",
      "const link = <a href={url} download>Save</a>",
      "const frame = <iframe src={url} />",
      "const frame = <IFRAME src={url}></IFRAME>",
      "const frame = <embed src={url} type=\"application/pdf\" />",
      "const frame = <object data={url} />",
      "const frame = document.createElement('iframe')",
      'const frame = document.createElement("embed")',
      "const frame = document.createElementNS(ns, `object`)",
      "await window.showSaveFilePicker()",
      "canvas.toBlob((image) => keep(image))",
      "const image = canvas.toDataURL()",
      "localStorage.setItem('form', text)",
      "window.sessionStorage.setItem('form', text)",
      "const request = indexedDB.open('forms')",
      "const cache = await caches.open('forms')",
      "await navigator.serviceWorker.register('/sw.js')",
    );
    fc.assert(
      fc.property(surrounding, saves, surrounding, (before, save, after) => {
        const source = [...before, `${save};`, ...after].join("\n");
        expect(savingConstructs("app/intake/probe.tsx", source).length, source).toBeGreaterThan(0);
      }),
    );
  });

  it("reads comments and copy as what they are, not as code", () => {
    fc.assert(
      fc.property(surrounding, (statements) => {
        expect(savingConstructs("app/intake/probe.tsx", statements.join("\n"))).toEqual([]);
      }),
    );
  });

  it("would have caught the download this page used to make", () => {
    // PR #80's saveToDevice, the review bot's P1 on HACK-115.
    const download = [
      "function saveToDevice(bytes: Uint8Array, fileName: string): void {",
      '  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));',
      '  const anchor = document.createElement("a");',
      "  anchor.href = url;",
      "  anchor.download = fileName;",
      "  document.body.appendChild(anchor);",
      "  anchor.click();",
      "  anchor.remove();",
      "}",
    ].join("\n");
    expect(savingConstructs("app/intake/device-results.tsx", download)).toEqual([
      "createObjectURL",
      "Blob",
      "download",
    ]);
  });

  it("sees each option that would send pdf.js to the network, however the options are written", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PDFJS_REQUEST_OPTIONS),
        fc.constantFrom(
          (name: string) => `engine.getDocument({ data, ${name}: value });`,
          (name: string) => `const options = { data }; options.${name} = value;`,
          (name: string) => `engine.GlobalWorkerOptions.${name} = value;`,
          (name: string) => `const { ${name} } = settings;`,
        ),
        (name, write) => {
          expect(identifiersIn(PRINT_MODULE, write(name))).toContain(name);
        },
      ),
    );
  });
});

describe("the boundary check's reading of requests", () => {
  // Likewise for requests: any API a module could use to send an answer
  // off the device must trip the request check, however the code around it
  // reads.
  it("flags every way a module can send data off the device, wherever it sits in the code", () => {
    const sends = fc.constantFrom(
      "fetch(url)",
      "await fetchLater(url, { activateAfter: 0 })",
      "new XMLHttpRequest()",
      "navigator.sendBeacon(url, body)",
      "new WebSocket(url)",
      "new EventSource(url)",
      "new WebTransport(url)",
      "new RTCPeerConnection()",
      "new Image().src = url",
      "new Worker(url)",
      "new SharedWorker(url)",
      "window.open(url)",
      "location.assign(url)",
      "location.replace(url)",
      "await import(url)",
      "await import(`${base}/${answer}`)",
    );
    const code = fc.stringMatching(/^[a-z ;=(){}\n]{0,40}$/);
    fc.assert(
      fc.property(code, sends, code, (before, send, after) => {
        expect(`${before}\n${send};\n${after}`).toMatch(REQUEST_API);
      }),
    );
    // A literal path stays an ordinary import, as the page's lazy fill is.
    expect('const fill = await import("../../lib/intake/device-fill");').not.toMatch(REQUEST_API);
  });
});
