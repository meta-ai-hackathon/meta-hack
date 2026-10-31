import type { FormRegistryEntry } from "../forms/registry-core";

// The blank application form the step-by-step page fills on the device
// (HACK-115). It is the public form exactly as the agency publishes it, the
// same bytes as the registry's committed copy (a test pins the two), served
// as a static file from public/forms/. It carries no person data.
//
// This is the one request the device path makes, and only when the person
// asks to download their filled form: a GET for the blank form with no
// body, no cookies, and no referrer, so nothing about the person or their
// answers rides along. The fill itself happens in the browser afterwards.

/** Where the static blank copy of a registered form is served. */
export function deviceTemplateUrl(entry: Pick<FormRegistryEntry, "id">): string {
  return `/forms/${entry.id}.pdf`;
}

/**
 * Fetch the blank form for `entry`, or null when it can't be had right now
 * (offline, a server error, a blocked request). Never rejects.
 */
export async function loadDeviceTemplate(
  entry: Pick<FormRegistryEntry, "id">,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array | null> {
  try {
    const response = await fetchImpl(deviceTemplateUrl(entry), {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) {
      return null;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}
