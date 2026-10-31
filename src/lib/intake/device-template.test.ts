import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { parseCommittedRegistryEntries } from "../forms/registry-core";
import { PILOT_CONFIG } from "../pilot";
import { deviceTemplateUrl, loadDeviceTemplate } from "./device-template";

// The blank form the device fill starts from (HACK-115): the static copy
// is byte for byte the registry's committed form, and fetching it sends
// nothing but a plain GET for that one file.

const ENTRIES = parseCommittedRegistryEntries((detail) => new Error(detail));
const PILOT_ENTRY = ENTRIES.find((entry) => entry.id === PILOT_CONFIG.formRegistryId)!;
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

function publicCopy(url: string): Buffer {
  return readFileSync(path.join(REPO_ROOT, "public", url));
}

describe("the static blank form", () => {
  it("is the pilot form's committed bytes, exactly", () => {
    const committed = readFileSync(path.join(REPO_ROOT, PILOT_ENTRY.pdfPath));
    expect(publicCopy(deviceTemplateUrl(PILOT_ENTRY)).equals(committed)).toBe(true);
  });

  it("serves only registered forms, each identical to its committed copy", () => {
    for (const file of readdirSync(path.join(REPO_ROOT, "public", "forms"))) {
      const entry = ENTRIES.find((candidate) => deviceTemplateUrl(candidate) === `/forms/${file}`);
      expect(entry, `public/forms/${file} is not a registered form`).toBeDefined();
      const committed = readFileSync(path.join(REPO_ROOT, entry!.pdfPath));
      expect(publicCopy(`/forms/${file}`).equals(committed), file).toBe(true);
    }
  });
});

describe("loadDeviceTemplate", () => {
  it("sends one bodiless GET with no cookies or referrer, and returns the bytes only on success", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 200, max: 599 }),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        async (status, body) => {
          // Statuses that can't carry a body get none, as a real server sends them.
          const bodiless = [204, 205, 304].includes(status);
          const fetchSpy = vi.fn(async () => new Response(bodiless ? null : body, { status }));
          const bytes = await loadDeviceTemplate(PILOT_ENTRY, fetchSpy as unknown as typeof fetch);
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          expect(fetchSpy).toHaveBeenCalledWith(deviceTemplateUrl(PILOT_ENTRY), {
            method: "GET",
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
          if (status >= 200 && status < 300) {
            expect(bytes).toEqual(bodiless ? new Uint8Array() : body);
          } else {
            expect(bytes).toBeNull();
          }
        },
      ),
    );
  });

  it("returns null instead of rejecting when the request fails", async () => {
    const offline = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(loadDeviceTemplate(PILOT_ENTRY, offline as unknown as typeof fetch)).resolves.toBeNull();
  });
});
