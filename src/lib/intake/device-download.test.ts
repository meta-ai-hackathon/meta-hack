// @vitest-environment jsdom
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveFilledFormToDevice, type DownloadEnvironment } from "./device-download";

// The person's own copy of the filled form (HACK-115), handed to the browser
// by the one module on the device path allowed to. The page's DOM test
// (device-results.test.tsx) drives the button; this file holds the module
// to the rules' conditions: a copy only when the person is acting on the
// page, exactly the bytes it was given as a PDF under the name asked for,
// the link off the page at once, the object URL alive until the caller
// releases it (iOS Safari reads the file only when the person taps Download
// in its prompt, HACK-145), and nothing sent anywhere.

/** What the browser was handed, and what became of it. */
interface Handed {
  readonly files: Blob[];
  readonly urls: string[];
  readonly revoked: string[];
  readonly clicks: { href: string; download: string; connected: boolean }[];
}

/** A browser environment that records every step, with the person acting on the page as `acting` says. */
function recordingEnvironment(acting: boolean | undefined): { readonly handed: Handed; readonly environment: DownloadEnvironment } {
  const handed: Handed = { files: [], urls: [], revoked: [], clicks: [] };
  return {
    handed,
    environment: {
      document,
      urls: {
        createObjectURL: (file) => {
          handed.files.push(file);
          const url = `blob:filled-form-${handed.urls.length + 1}`;
          handed.urls.push(url);
          return url;
        },
        revokeObjectURL: (url) => {
          handed.revoked.push(url);
        },
      },
      personActing: () => acting,
    },
  };
}

/** Clicks on links record what they would download, instead of navigating. */
function recordClicks(handed: Handed): void {
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    handed.clicks.push({ href: this.href, download: this.download, connected: this.isConnected });
  });
}

/** A file's bytes, read the way a page reads a Blob (jsdom's Blob has no arrayBuffer()). */
function bytesOf(file: Blob): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

/** Put object URL functions on jsdom's URL, which has none, that record what they're given. */
function stubObjectUrls(): { readonly files: Blob[]; readonly revoked: string[] } {
  const files: Blob[] = [];
  const revoked: string[] = [];
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (file: Blob) => {
      files.push(file);
      return "blob:filled-form";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: (url: string) => {
      revoked.push(url);
    },
  });
  return { files, revoked };
}

const bytesArb = fc.uint8Array({ minLength: 1, maxLength: 256 });
const nameArb = fc.stringMatching(/^[a-z0-9-]{1,20}\.pdf$/);

/** An hour, far longer than any prompt a browser shows before it reads the file. */
const AN_HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (navigator as { userActivation?: unknown }).userActivation;
  delete (URL as { createObjectURL?: unknown }).createObjectURL;
  delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
  document.body.replaceChildren();
});

describe("saving the person's own copy of the filled form", () => {
  it("hands the browser exactly the bytes, as a PDF under the name asked for, with one click of a link it takes away", async () => {
    await fc.assert(
      fc.asyncProperty(bytesArb, nameArb, fc.constantFrom(true, undefined), async (bytes, name, acting) => {
        vi.restoreAllMocks();
        const { handed, environment } = recordingEnvironment(acting);
        recordClicks(handed);
        const original = [...bytes];

        const release = saveFilledFormToDevice(bytes, name, environment);
        expect(release).toBeTypeOf("function");
        expect(handed.files).toHaveLength(1);
        expect(handed.files[0].type).toBe("application/pdf");
        expect(await bytesOf(handed.files[0])).toEqual(original);
        // One click of a link to that file, made for it and on the page
        // only for the click.
        expect(handed.clicks).toEqual([{ href: handed.urls[0], download: name, connected: true }]);
        expect(document.querySelectorAll("a")).toHaveLength(0);
        // The URL stays alive until the caller releases it, then is revoked
        // exactly once, however often the release is called.
        expect(handed.revoked).toEqual([]);
        release!();
        expect(handed.revoked).toEqual(handed.urls);
        release!();
        expect(handed.revoked).toEqual(handed.urls);
        // The caller's bytes are as they were.
        expect([...bytes]).toEqual(original);
      }),
      { numRuns: 40 },
    );
  });

  it("gives each copy its own release, so releasing one never revokes another", () => {
    fc.assert(
      fc.property(fc.array(bytesArb, { minLength: 2, maxLength: 5 }), fc.nat(), (forms, pick) => {
        vi.restoreAllMocks();
        const { handed, environment } = recordingEnvironment(true);
        recordClicks(handed);
        const releases = forms.map((bytes) => saveFilledFormToDevice(bytes, "dhb-5200.pdf", environment)!);
        const chosen = pick % releases.length;
        releases[chosen]();
        expect(handed.revoked).toEqual([handed.urls[chosen]]);
        for (const release of releases) {
          release();
        }
        expect([...handed.revoked].sort()).toEqual([...handed.urls].sort());
      }),
      { numRuns: 30 },
    );
  });

  it("saves its own copy, so wiping the bytes afterwards leaves the file whole", async () => {
    await fc.assert(
      fc.asyncProperty(bytesArb, async (bytes) => {
        vi.restoreAllMocks();
        const { handed, environment } = recordingEnvironment(true);
        recordClicks(handed);
        const original = [...bytes];
        saveFilledFormToDevice(bytes, "dhb-5200.pdf", environment);
        bytes.fill(0);
        expect(await bytesOf(handed.files[0])).toEqual(original);
      }),
      { numRuns: 20 },
    );
  });

  it("makes nothing when the browser says the person isn't acting on the page", () => {
    fc.assert(
      fc.property(bytesArb, nameArb, (bytes, name) => {
        vi.restoreAllMocks();
        const { handed, environment } = recordingEnvironment(false);
        recordClicks(handed);
        expect(saveFilledFormToDevice(bytes, name, environment)).toBeNull();
        expect(handed.files).toEqual([]);
        expect(handed.urls).toEqual([]);
        expect(handed.clicks).toEqual([]);
        expect(document.querySelectorAll("a")).toHaveLength(0);
      }),
      { numRuns: 20 },
    );
  });

  it("takes the link away and revokes the URL at once when the click throws", () => {
    const { handed, environment } = recordingEnvironment(true);
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
      throw new Error("the click failed");
    });
    expect(() => saveFilledFormToDevice(new Uint8Array([1, 2, 3]), "dhb-5200.pdf", environment)).toThrow(
      "the click failed",
    );
    expect(document.querySelectorAll("a")).toHaveLength(0);
    expect(handed.revoked).toEqual(handed.urls);
  });

  it("in the browser itself, keeps the URL alive until it is released, with no timer, and asks nothing of the network", () => {
    // iOS Safari reads the file only when the person taps Download in its
    // prompt, so no timer may revoke the URL first, however long they take.
    vi.useFakeTimers();
    const { files, revoked } = stubObjectUrls();
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const release = saveFilledFormToDevice(new Uint8Array([37, 80, 68, 70]), "dhb-5200.pdf");
    expect(release).toBeTypeOf("function");
    expect(clicks).toEqual(["dhb-5200.pdf"]);
    expect(files).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(AN_HOUR_MS);
    expect(revoked).toEqual([]);
    release!();
    expect(revoked).toEqual(["blob:filled-form"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("in the browser itself, refuses a call while the person isn't acting on the page, and saves in their press", () => {
    vi.useFakeTimers();
    const { files, revoked } = stubObjectUrls();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const activation = { isActive: false };
    Object.defineProperty(navigator, "userActivation", { value: activation, configurable: true });
    expect(saveFilledFormToDevice(new Uint8Array([1]), "dhb-5200.pdf")).toBeNull();
    expect(files).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    activation.isActive = true;
    const release = saveFilledFormToDevice(new Uint8Array([1]), "dhb-5200.pdf");
    expect(files).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(revoked).toEqual([]);
    release!();
    expect(revoked).toEqual(["blob:filled-form"]);
  });
});
