// The person's own copy of their filled application (HACK-115).
//
// The person signs and sends in the application themselves, so they need a
// copy of the filled form to print, sign, send in, and keep. The owner
// decided on HACK-115 that downloading it is a vital part of the journey,
// and .github/claude-review/rules.md (Real data rules) sanctions it on its
// conditions. This is the one module on the device path allowed to hand the
// browser a file, and device-path-boundary.test.ts holds it to exactly
// that: it makes a Blob of the filled bytes and an object URL for it,
// clicks an anchor with a download attribute once, and takes the anchor off
// the page. Some browsers start a download a moment after the click, and
// revoking the URL before then cancels it, so the URL is revoked
// DOWNLOAD_URL_LIFETIME_MS after the click.
//
// The bytes are the form filled in this browser (device-fill.ts) from the
// answers sealed on this device and those typed into the review. Nothing
// here reads anything else, sends anything, logs anything, or keeps
// anything: the file goes only to the browser to save, and once the URL is
// revoked nothing here holds it. Only the person's own press saves a copy.
// The page calls this from its download button's click handler and nowhere
// else, which the boundary check reads on the page's source. Where the
// browser can tell whether the person is acting on the page, a call while
// they aren't, from a timer for example, is refused.

/** How long the filled form's object URL outlives the click. */
export const DOWNLOAD_URL_LIFETIME_MS = 1_000;

/** What saving a copy needs from the browser. The page passes nothing, so the browser's own are used. */
export interface DownloadEnvironment {
  readonly document: Document;
  readonly urls: {
    createObjectURL(file: Blob): string;
    revokeObjectURL(url: string): void;
  };
  readonly later: (run: () => void, ms: number) => void;
  /**
   * Whether the person is acting on the page right now, from the browser's
   * user activation, or undefined in a browser that can't say.
   */
  readonly personActing: () => boolean | undefined;
}

function browserEnvironment(): DownloadEnvironment {
  return {
    document,
    urls: URL,
    later: (run, ms) => {
      setTimeout(run, ms);
    },
    personActing: () => (navigator as { readonly userActivation?: UserActivation }).userActivation?.isActive,
  };
}

/**
 * Hand the browser the filled form to save as `fileName`. Returns true once
 * it has. Returns false, having made nothing, when the browser says the
 * person isn't acting on the page, so a copy is never saved on its own.
 */
export function saveFilledFormToDevice(
  bytes: Uint8Array,
  fileName: string,
  environment: DownloadEnvironment = browserEnvironment(),
): boolean {
  if (environment.personActing() === false) {
    return false;
  }
  const url = environment.urls.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
  const anchor = environment.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  environment.document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    environment.later(() => environment.urls.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
  }
  return true;
}
