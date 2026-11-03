/**
 * Hand a text file to the person as a download, built entirely in the
 * browser (BN-22 / HACK-50): a Blob behind a temporary blob: URL, so the
 * content never travels over the network. Browser-only.
 */
export function downloadTextFile(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Some browsers read the blob after click() returns; release it later.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The media type of the renewal calendar file. */
export const CALENDAR_FILE_TYPE = "text/calendar;charset=utf-8";

/** What offering a file came to: handed over, nothing to offer, or failed. */
export type FileOfferOutcome = "downloaded" | "nothing" | "failed";

/**
 * Build a file and hand it over, never throwing (third review: the
 * tracker's download click had no catch, so a throw from the calendar
 * builder or from the browser's blob URL left an unhandled exception, no
 * file, and no word). `build` returns null when there is nothing to offer.
 * The caller shows a notice for each outcome.
 */
export function offerFile(
  build: () => { readonly filename: string; readonly text: string } | null,
  save: (filename: string, text: string, type: string) => void,
  type: string,
): FileOfferOutcome {
  try {
    const file = build();
    if (file === null) {
      return "nothing";
    }
    save(file.filename, file.text, type);
    return "downloaded";
  } catch {
    return "failed";
  }
}
