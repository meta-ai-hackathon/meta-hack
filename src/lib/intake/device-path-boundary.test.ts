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
// The path includes the match, the form review, the fill, the print
// preview, and the download the page offers once the questions are done
// (HACK-115). The one request on it is the GET for the blank public form, in
// device-template.ts. The filled form reaches the device only as the
// person's own downloaded copy, which the owner sanctioned on HACK-115
// (.github/claude-review/rules.md): every module on the path is checked
// below for the ways this check knows to save something, the one download
// module may use only the object URL, Blob, and download link a download
// needs, the page may call it only from its download button's click
// handler, and only the two sealed answer stores may touch the browser's
// storage, each only its own.

const SRC = fileURLToPath(new URL("../..", import.meta.url));

const DEVICE_PATH_ENTRIES = [
  "app/intake/intake-wizard.tsx",
  "app/intake/question-view.tsx",
  "app/intake/device-results.tsx",
  "lib/intake/device-intake.ts",
  "lib/intake/device-form.ts",
  "lib/intake/device-fill.ts",
  "lib/intake/device-print.ts",
  "lib/intake/device-download.ts",
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
 * the print preview that draws it, and the page that shows it. None of them
 * may save it to the device themselves: the person's downloaded copy goes
 * only through the download module below.
 */
const FILLED_FORM_HOLDERS = ["lib/intake/device-fill.ts", PRINT_MODULE, "app/intake/device-results.tsx"];

/**
 * The one module on the path allowed to hand the browser a file: the
 * person's own downloaded copy of the filled form, which the owner decided
 * on HACK-115 is a vital part of the journey (.github/claude-review/rules.md,
 * Real data rules).
 */
const DOWNLOAD_MODULE = "lib/intake/device-download.ts";

/** What a download needs, and all the download module may use: an object URL, the Blob behind it, and a download link. */
const DOWNLOAD_NAMES = ["createObjectURL", "Blob", "download"];

/** The download module's one function the page calls. */
const DOWNLOAD_FUNCTION = "saveFilledFormToDevice";

/** The one module allowed to load the download module: the page, from its download button. */
const DOWNLOAD_CALLER = "app/intake/device-results.tsx";

/**
 * The data-action of the page's download button. It isn't the bare word
 * "download", which the save check reads as a download attribute wherever
 * it is written as a string, the page included.
 */
const DOWNLOAD_BUTTON_ACTION = "download-copy";

/**
 * Names in code that save something to the device or hand the browser a
 * file to save: an object URL and the Blob or File behind it, a Blob read
 * out of a response or a canvas, a download attribute, the share sheet
 * (which offers Save to Files), the save and directory pickers, the
 * origin's private file system and the old file system API, a canvas
 * turned into an image file, the browser's storage (cookies and the old
 * WebSQL included), and a service worker, which can keep what passes
 * through it.
 */
const SAVING_NAMES = new Set([
  "createObjectURL",
  "Blob",
  "File",
  "blob",
  "convertToBlob",
  "download",
  "share",
  "canShare",
  "showSaveFilePicker",
  "showDirectoryPicker",
  "getDirectory",
  "getFileHandle",
  "createWritable",
  "createSyncAccessHandle",
  "requestFileSystem",
  "webkitRequestFileSystem",
  "toBlob",
  "toDataURL",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "caches",
  "cookie",
  "cookieStore",
  "openDatabase",
  "serviceWorker",
]);

/**
 * The device's two sealed answer stores, the only modules on the path that
 * may touch the browser's storage, each only through its own: device-kv.ts
 * is the IndexedDB store that holds the sealed answers and the
 * non-extractable key that seals them, and client-store.ts keeps only its
 * AES-GCM sealed envelope in localStorage. Neither sees the filled form.
 */
const SEALED_STORES: ReadonlyMap<string, readonly string[]> = new Map([
  ["lib/device-kv.ts", ["indexedDB"]],
  ["lib/intake/client-store.ts", ["localStorage"]],
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
 * storage don't count: only code does. A name counts written as a name
 * (`localStorage`, `anchor.download`, `<a download>`) or as a whole string
 * (`window["localStorage"]`, `{ ["cookie"]: ... }`,
 * `setAttribute("download", ...)`). A name pieced together at run time
 * would get past this, which is why the page's DOM test also watches
 * what the page does (device-results.test.tsx).
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
    if (ts.isStringLiteralLike(node) && (SAVING_NAMES.has(node.text) || node.text.toLowerCase() === "download")) {
      // setAttribute("download", ...), window["localStorage"], a JSX value.
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

/** A file's code, parsed the way the bundler reads it. */
function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** The function a node's code runs in, or null at the top of the module. */
function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current)) {
      return current;
    }
  }
  return null;
}

/** Whether a JSX attribute is the onClick of the download button, a <button data-action="download-copy">. */
function isDownloadButtonClick(attribute: ts.Node): boolean {
  if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name) || attribute.name.text !== "onClick") {
    return false;
  }
  const element = attribute.parent.parent;
  if (!(ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element))) {
    return false;
  }
  const isButton = ts.isIdentifier(element.tagName) && element.tagName.text === "button";
  const isDownload = element.attributes.properties.some(
    (property) =>
      ts.isJsxAttribute(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "data-action" &&
      property.initializer !== undefined &&
      ts.isStringLiteral(property.initializer) &&
      property.initializer.text === DOWNLOAD_BUTTON_ACTION,
  );
  return isButton && isDownload;
}

/** Whether `node` is the value written in a download button's onClick: `onClick={node}`. */
function isDownloadButtonClickValue(node: ts.Node): boolean {
  return ts.isJsxExpression(node.parent) && node.parent.expression === node && isDownloadButtonClick(node.parent.parent);
}

/** Whether a function is async, so what it runs after an await is no longer in the press. */
function isAsync(handler: ts.SignatureDeclaration): boolean {
  const modifiers = ts.canHaveModifiers(handler) ? (ts.getModifiers(handler) ?? []) : [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword);
}

/** Whether a function runs in the press itself: not async, and written right in a download button's onClick. */
function isInlineDownloadHandler(handler: ts.SignatureDeclaration): boolean {
  return (
    (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
    !isAsync(handler) &&
    isDownloadButtonClickValue(handler)
  );
}

/** The name a function is declared under, as `function name() {}` or `const name = () => {}`, or null. */
function declaredName(handler: ts.SignatureDeclaration): ts.Identifier | null {
  if (ts.isFunctionDeclaration(handler) && handler.name !== undefined) {
    return handler.name;
  }
  if (
    (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) &&
    ts.isVariableDeclaration(handler.parent) &&
    handler.parent.initializer === handler &&
    ts.isIdentifier(handler.parent.name)
  ) {
    return handler.parent.name;
  }
  return null;
}

/**
 * Every call of the download function in a file, and every way the file
 * could save a copy without the person's own press of its download button,
 * each by what it is. The download module may be imported only for its one
 * function, by name. That function may only be called, and each call must
 * run in the press itself: in a function that isn't async, written right
 * in the download button's onClick, or declared on its
 * own and used only that way, as `onClick={handler}` or as a call from such
 * an onClick. So a call from an effect, a timer, a promise callback, the
 * fill's own handler, or a press of any other button counts, and so does
 * the function passed or stored anywhere. The file is parsed, so comments
 * and copy don't count. The browser's own check (device-download.ts)
 * covers what this reading can't, such as a click made by script.
 */
function downloadCalls(file: string, source = readFileSync(join(SRC, file), "utf8")): {
  readonly calls: number;
  readonly problems: readonly string[];
} {
  const parsed = parse(file, source);
  const problems: string[] = [];
  const isDownloadModule = (specifier: ts.Expression | undefined) =>
    specifier !== undefined &&
    ts.isStringLiteralLike(specifier) &&
    isLocal(specifier.text) &&
    resolveLocal(file, specifier.text) === DOWNLOAD_MODULE;
  // The names the download function is imported under, and the identifiers that import it.
  const names = new Set<string>();
  const importBindings = new Set<ts.Node>();
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && isDownloadModule(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause === undefined) {
        problems.push("imports the download module for what it does when it loads");
        continue;
      }
      if (clause.isTypeOnly) {
        continue;
      }
      if (clause.name !== undefined) {
        problems.push("imports the download module's default export");
      }
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        problems.push("imports the whole download module");
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) {
            continue;
          }
          const imported = (element.propertyName ?? element.name).text;
          if (imported !== DOWNLOAD_FUNCTION) {
            problems.push(`imports ${imported} from the download module`);
            continue;
          }
          names.add(element.name.text);
          importBindings.add(element.name);
        }
      }
    }
    if (ts.isExportDeclaration(statement) && isDownloadModule(statement.moduleSpecifier)) {
      problems.push("re-exports the download module");
    }
  }
  let calls = 0;
  const handlerProblems = (handler: ts.SignatureDeclaration, what: string): string[] => {
    if (isInlineDownloadHandler(handler)) {
      return [];
    }
    const name = declaredName(handler);
    if (name === null || isAsync(handler)) {
      return [`${what} outside a press of the download button`];
    }
    const uses: ts.Identifier[] = [];
    const findUses = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === name.text && node !== name) {
        uses.push(node);
      }
      ts.forEachChild(node, findUses);
    };
    findUses(parsed);
    const pressOnly = uses.every((use) => {
      if (isDownloadButtonClickValue(use)) {
        return true;
      }
      const caller = enclosingFunction(use);
      return (
        ts.isCallExpression(use.parent) &&
        use.parent.expression === use &&
        caller !== null &&
        isInlineDownloadHandler(caller)
      );
    });
    return uses.length > 0 && pressOnly
      ? []
      : [`${what} in ${name.text}, which runs other than in a press of the download button`];
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      isDownloadModule(node.arguments[0])
    ) {
      problems.push("loads the download module with import()");
    }
    if (ts.isIdentifier(node) && names.has(node.text) && !importBindings.has(node)) {
      if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) {
        problems.push(`uses ${node.text} other than by calling it`);
      } else {
        calls += 1;
        const handler = enclosingFunction(node);
        problems.push(
          ...(handler === null
            ? [`calls ${node.text} when the module loads`]
            : handlerProblems(handler, `calls ${node.text}`)),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return { calls, problems };
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

/**
 * Every name in a file's code, written as a name or as a whole string (an
 * option key in quotes, a computed key, a bracketed member), so an option
 * counts however it is spelled.
 */
function namesIn(file: string, source = readFileSync(join(SRC, file), "utf8")): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) {
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
      "lib/intake/device-download.ts",
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

  it("never saves the filled form to the device from the fill, the print preview, or the page", () => {
    // No object URL, Blob, File, or download attribute, no share sheet,
    // nothing that embeds the PDF in the page, no image file made from a
    // page, no file system, and none of the browser's storage. The person's
    // downloaded copy goes only through the download module.
    for (const file of FILLED_FORM_HOLDERS) {
      expect(files.has(file), `${file} is on the path`).toBe(true);
      expect(savingConstructs(file), `${file} could save the filled form`).toEqual([]);
    }
  });

  it("saves nothing anywhere on the path but the sealed answers in their own stores and a download through its own module", () => {
    // A helper module the page loads could save the form as well as the
    // page itself could, so every module on the path is read. The two
    // sealed stores may use their own storage and nothing else, and the
    // download module only what a download needs.
    for (const file of files) {
      const allowed = SEALED_STORES.get(file) ?? (file === DOWNLOAD_MODULE ? DOWNLOAD_NAMES : []);
      const found = savingConstructs(file).filter((name) => !allowed.includes(name));
      expect(found, `${file} could save something to the device`).toEqual([]);
    }
    for (const [store, names] of SEALED_STORES) {
      // Non-vacuous: the stores are on the path, and use what they're allowed.
      expect(files.has(store), `${store} is on the path`).toBe(true);
      expect(new Set(savingConstructs(store)), store).toEqual(new Set(names));
    }
    // Likewise the download module: on the path, using exactly what a download needs.
    expect(files.has(DOWNLOAD_MODULE), `${DOWNLOAD_MODULE} is on the path`).toBe(true);
    expect(new Set(savingConstructs(DOWNLOAD_MODULE)), DOWNLOAD_MODULE).toEqual(new Set(DOWNLOAD_NAMES));
  });

  it("lets only the page load the download module, to call it from its download button's click handler alone", () => {
    // The rules allow the copy only when the person chooses to download it,
    // so nothing else on the path may reach the module, and the page may
    // reach it only from a press of Download a copy.
    for (const file of files) {
      if (file === DOWNLOAD_CALLER || file === DOWNLOAD_MODULE) {
        continue;
      }
      expect(localImports(file), `${file} loads the download module`).not.toContain(DOWNLOAD_MODULE);
    }
    expect(localImports(DOWNLOAD_CALLER)).toContain(DOWNLOAD_MODULE);
    const page = downloadCalls(DOWNLOAD_CALLER);
    expect(page.problems).toEqual([]);
    // Non-vacuous: the page does call it.
    expect(page.calls).toBe(1);
  });

  it("logs nothing about the downloaded copy", () => {
    // Telemetry is a server module the path can't import (above); the
    // download module doesn't write to the console either.
    expect(namesIn(DOWNLOAD_MODULE)).not.toContain("console");
  });

  it("gives pdf.js nothing that would send it to the network or into a Worker", () => {
    // The print preview hands pdf.js the filled bytes and nothing else; the
    // worker hook keeps it on the page's thread (device-print.test.ts).
    const names = namesIn(PRINT_MODULE);
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
  // The save check reads code, so it must catch each way it knows to save
  // the filled form wherever it sits among ordinary statements, however
  // the name is spelled, and never mistake a comment or a sentence of copy
  // for code.
  const statement = fc.constantFrom(
    "const pages = 21;",
    "function label(page) { return `Page ${page}`; }",
    "if (pages > 0) { release(); }",
    "// Nothing here keeps a download, a Blob, or localStorage.",
    "/* An iframe or an object URL would save the form. */",
    'const note = "Nothing is saved to this device, and there is no download.";',
    'const hint = "Share it, file it, or keep it as a blob in a cookie jar.";',
    "const frame = <div role=\"img\" aria-label={label(1)} />;",
  );
  const surrounding = fc.array(statement, { maxLength: 4 });

  it("flags each way it knows to save the filled form, wherever it sits and however it is spelled", () => {
    const saves = fc.constantFrom(
      "const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))",
      "const url = URL['createObjectURL'](form)",
      "const file = new Blob([bytes])",
      "const file = new File([bytes], 'dhb-5200.pdf', { type: 'application/pdf' })",
      "const image = await new Response(bytes).blob()",
      "const image = await offscreen.convertToBlob()",
      "anchor.download = name",
      "anchor.setAttribute('download', name)",
      'anchor["download"] = name',
      "const link = <a href={url} download={name}>Save</a>",
      "const link = <a href={url} download>Save</a>",
      "await navigator.share({ files: [form] })",
      "if (navigator.canShare?.({ files })) { offer(); }",
      "const frame = <iframe src={url} />",
      "const frame = <IFRAME src={url}></IFRAME>",
      "const frame = <embed src={url} type=\"application/pdf\" />",
      "const frame = <object data={url} />",
      "const frame = document.createElement('iframe')",
      'const frame = document.createElement("embed")',
      "const frame = document.createElementNS(ns, `object`)",
      "await window.showSaveFilePicker()",
      "const folder = await window.showDirectoryPicker()",
      "const root = await navigator.storage.getDirectory()",
      "const handle = await root.getFileHandle('form.pdf', { create: true })",
      "const writer = await handle.createWritable()",
      "const access = await handle.createSyncAccessHandle()",
      "window.webkitRequestFileSystem(kind, size, keep)",
      "canvas.toBlob((image) => keep(image))",
      "const image = canvas.toDataURL()",
      "localStorage.setItem('form', text)",
      "window['localStorage'].setItem('form', text)",
      "window.sessionStorage.setItem('form', text)",
      "const request = indexedDB.open('forms')",
      "const request = Reflect.get(globalThis, 'indexedDB').open('forms')",
      "const cache = await caches.open('forms')",
      "document.cookie = `form=${text}`",
      "await cookieStore.set('form', text)",
      "const db = openDatabase('forms', '1', 'forms', 1024)",
      "await navigator.serviceWorker.register('/sw.js')",
      "const { ['serviceWorker']: worker } = navigator",
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
          (name: string) => `engine.getDocument({ data, "${name}": value });`,
          (name: string) => `engine.getDocument({ data, ["${name}"]: value });`,
          (name: string) => `const options = { data }; options.${name} = value;`,
          (name: string) => `const options = { data }; options['${name}'] = value;`,
          (name: string) => `engine.GlobalWorkerOptions.${name} = value;`,
          (name: string) => `engine.GlobalWorkerOptions[\`${name}\`] = value;`,
          (name: string) => `const { ${name} } = settings;`,
        ),
        (name, write) => {
          expect(namesIn(PRINT_MODULE, write(name))).toContain(name);
        },
      ),
    );
  });
});

describe("the boundary check's reading of the download button", () => {
  // The page may save a copy only in a press of Download a copy, so the
  // reading must take each way of writing that handler, and catch every
  // other way of reaching the download, wherever it sits among ordinary
  // code and copy.
  const DOWNLOAD_IMPORT = 'import { saveFilledFormToDevice } from "../../lib/intake/device-download";';

  interface PageParts {
    readonly imports?: readonly string[];
    /** Statements in the page's body, before it returns. */
    readonly body: readonly string[];
    /** What the download button's onClick is written as. */
    readonly handler: string;
    /** More elements beside the buttons. */
    readonly jsx?: readonly string[];
  }

  /** A page with a print button and a download button, built from `parts`, with `filler` among its statements. */
  function page(parts: PageParts, filler: readonly string[] = []): string {
    const middle = Math.floor(filler.length / 2);
    return [
      ...(parts.imports ?? [DOWNLOAD_IMPORT]),
      "export function Page(props: { readonly bytes: Uint8Array; readonly announce: (saved: boolean) => void }) {",
      "  const { bytes, announce } = props;",
      ...filler.slice(0, middle),
      ...parts.body,
      ...filler.slice(middle),
      "  return (",
      "    <div>",
      '      <button type="button" data-action="print" onClick={() => window.print()}>Print the form</button>',
      `      <button type="button" data-action="download-copy" onClick={${parts.handler}}>Download a copy</button>`,
      ...(parts.jsx ?? []),
      "    </div>",
      "  );",
      "}",
    ].join("\n");
  }

  const filler = fc.array(
    fc.constantFrom(
      "  const pages = 21;",
      "  // Nothing here saves a copy until the person presses Download a copy.",
      '  const note = "Download a copy to keep, print, or send in.";',
      "  function label(page: number): string { return `Page ${page}`; }",
      "  useEffect(() => { document.title = label(1); }, []);",
      "  const later = () => setTimeout(() => announce(false), 0);",
    ),
    { maxLength: 4 },
  );

  const SAVE = 'saveFilledFormToDevice(bytes, "dhb-5200.pdf")';
  const NAMED = ["  function downloadCopy(): void {", `    ${SAVE};`, "  }"];
  const PRINT = "() => window.print()";

  it("takes every way of saving a copy in the press itself", () => {
    const accepted: readonly PageParts[] = [
      { body: ["  function downloadCopy(): void {", `    announce(${SAVE});`, "  }"], handler: "downloadCopy" },
      { body: ["  const downloadCopy = () => {", `    const saved = ${SAVE};`, "    announce(saved);", "  };"], handler: "downloadCopy" },
      { body: NAMED, handler: "() => downloadCopy()" },
      { body: [], handler: `() => announce(${SAVE})` },
      { body: [], handler: `function () { ${SAVE}; }` },
      {
        imports: [
          'import { saveFilledFormToDevice as save, type DownloadEnvironment } from "@/lib/intake/device-download";',
          'import type * as Download from "../../lib/intake/device-download";',
        ],
        body: [],
        handler: '() => announce(save(bytes, "dhb-5200.pdf"))',
      },
    ];
    fc.assert(
      fc.property(filler, (statements) => {
        for (const parts of accepted) {
          const source = page(parts, statements);
          const read = downloadCalls("app/intake/probe.tsx", source);
          expect(read.problems, source).toEqual([]);
          expect(read.calls, source).toBe(1);
        }
      }),
      { numRuns: 30 },
    );
  });

  it("catches every other way of reaching the download, wherever it sits", () => {
    const rejected: readonly PageParts[] = [
      // An effect, as the page loads or as the pages appear.
      { body: [`  useEffect(() => { ${SAVE}; }, [bytes]);`], handler: PRINT },
      // A timer or a promise callback started by the press, which runs after it.
      { body: [], handler: `() => { setTimeout(() => ${SAVE}, 0); }` },
      { body: [], handler: `() => { void Promise.resolve().then(() => ${SAVE}); }` },
      // An async handler, which saves after an await.
      { body: [], handler: `async () => { await Promise.resolve(); ${SAVE}; }` },
      {
        body: ["  async function downloadLater(): Promise<void> {", "    await Promise.resolve();", `    ${SAVE};`, "  }"],
        handler: "() => void downloadLater()",
      },
      // The handler run from somewhere else as well: the fill finishing, or an effect.
      {
        body: [...NAMED, "  async function showFilledForm(): Promise<void> {", "    await Promise.resolve();", "    downloadCopy();", "  }"],
        handler: "downloadCopy",
      },
      { body: [...NAMED, "  useEffect(() => downloadCopy(), []);"], handler: "downloadCopy" },
      // The handler on another button, on something that isn't a button, or on another event.
      { body: NAMED, handler: PRINT, jsx: ['      <button type="button" data-action="print" onClick={downloadCopy}>Print</button>'] },
      { body: NAMED, handler: PRINT, jsx: ['      <div data-action="download-copy" onClick={downloadCopy}>Download a copy</div>'] },
      {
        body: NAMED,
        handler: PRINT,
        jsx: ['      <button type="button" data-action="download-copy" onMouseEnter={downloadCopy}>Download a copy</button>'],
      },
      // The function itself handed on or kept.
      { body: ["  const save = saveFilledFormToDevice;"], handler: '() => save(bytes, "dhb-5200.pdf")' },
      { body: [], handler: PRINT, jsx: ["      <Child onSave={saveFilledFormToDevice} />"] },
      // A call as the module loads.
      { imports: [DOWNLOAD_IMPORT, 'saveFilledFormToDevice(new Uint8Array(1), "dhb-5200.pdf");'], body: [], handler: PRINT },
      // The module reached some other way.
      {
        imports: ['import * as download from "../../lib/intake/device-download";'],
        body: [],
        handler: '() => download.saveFilledFormToDevice(bytes, "dhb-5200.pdf")',
      },
      { imports: ['import download from "../../lib/intake/device-download";'], body: [], handler: PRINT },
      { imports: ['import { DOWNLOAD_URL_LIFETIME_MS } from "../../lib/intake/device-download";'], body: [], handler: PRINT },
      { imports: ['import "../../lib/intake/device-download";'], body: [], handler: PRINT },
      { imports: ['export { saveFilledFormToDevice } from "@/lib/intake/device-download";'], body: [], handler: PRINT },
      {
        imports: [],
        body: [],
        handler:
          'async () => { const { saveFilledFormToDevice: save } = await import("../../lib/intake/device-download"); save(bytes, "dhb-5200.pdf"); }',
      },
    ];
    fc.assert(
      fc.property(filler, (statements) => {
        for (const parts of rejected) {
          const source = page(parts, statements);
          expect(downloadCalls("app/intake/probe.tsx", source).problems.length, source).toBeGreaterThan(0);
        }
      }),
      { numRuns: 30 },
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
