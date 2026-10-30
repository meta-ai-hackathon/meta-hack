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
