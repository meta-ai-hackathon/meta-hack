import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenewalFactsSection, ReportedDateView } from "../../app/renewal/renewal-view";
import { RenewalTracker } from "../../app/renewal/renewal-tracker";
import { RenewalBannerView } from "../../components/renewal-reminder-banner";
import { parseIsoDate } from "./calendar-date";
import { bannerMessage } from "./copy";
import { requestPersistentStorage } from "./device-kv";
import {
  newCalendarId,
  reminderDates,
  reminderStatus,
  RENEWAL_REMINDER_VERSION,
  type RenewalReminder,
} from "./reminder";
import { buildReminderCalendar } from "./reminder-calendar";
import { clearReminder, loadReminder, saveReminder, type DeviceKv } from "./reminder-store";
import { PILOT_RENEWAL_FACTS } from "./renewal-facts";

// The date never leaves the device (HACK-50, real-data rules of Oct 29):
// no server route, database column, log line, analytics call, or model
// call ever receives it. Proven two ways: a static scan of every renewal
// source file for network, logging, and server-action surfaces (and of
// the API routes for any renewal import), and a runtime run of the whole
// client path with fetch and the other network globals trapped.

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const REPORTED = "2027-04-30";

function files(dir: string, keep: (path: string) => boolean): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return files(full, keep);
    }
    return keep(full) ? [full] : [];
  });
}

const isSource = (path: string) => /\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path);

/** Code only: comments may name what the code avoids ("not localStorage"). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const RENEWAL_SOURCES = [
  ...files(join(SRC, "lib", "renewal"), isSource),
  ...files(join(SRC, "app", "renewal"), isSource),
  ...files(join(SRC, "components"), (path) => isSource(path) && /renewal-/.test(path)),
];

const FORBIDDEN: readonly [string, RegExp][] = [
  ["fetch call", /\bfetch\s*\(/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["sendBeacon", /sendBeacon/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["API route path", /["'`]\/api\//],
  ["server action", /["']use server["']/],
  ["console logging", /\bconsole\./],
  ["telemetry module", /telemetry|logInfo|logWarn|logError/],
  ["database module", /from\s+["'][./]*(?:lib\/)?db["']|postgres/],
  ["model module", /from\s+["'][./]*(?:lib\/)?model["']|chatCompletion/],
  ["web storage in plaintext", /localStorage|sessionStorage|document\.cookie/],
];

describe("static scan: renewal code has no way to send or log the date", () => {
  it("covers the renewal surfaces (non-vacuous)", () => {
    const names = RENEWAL_SOURCES.map((path) => path.slice(SRC.length));
    for (const expected of [
      "lib/renewal/reminder-store.ts",
      "lib/renewal/ics.ts",
      "app/renewal/renewal-tracker.tsx",
      "components/renewal-reminder-banner.tsx",
    ]) {
      expect(names.some((name) => name.endsWith(expected)), expected).toBe(true);
    }
  });

  it("finds no network, logging, storage, database, model, or server-action surface", () => {
    const hits: string[] = [];
    for (const path of RENEWAL_SOURCES) {
      const text = withoutComments(readFileSync(path, "utf8"));
      for (const [what, pattern] of FORBIDDEN) {
        if (pattern.test(text)) {
          hits.push(`${path.slice(SRC.length)}: ${what}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("no API route imports renewal code, so no route can receive the date", () => {
    const routes = files(join(SRC, "app", "api"), isSource);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(readFileSync(route, "utf8"), route).not.toMatch(/renewal/i);
    }
  });

  it("the date field has no name, so no form submission can carry it", () => {
    const tracker = readFileSync(join(SRC, "app", "renewal", "renewal-tracker.tsx"), "utf8");
    const at = tracker.indexOf('type="date"');
    expect(at).toBeGreaterThan(0);
    const dateInput = tracker.slice(tracker.lastIndexOf("<input", at), tracker.indexOf("/>", at));
    expect(dateInput).toContain('type="date"');
    expect(dateInput).not.toMatch(/\bname=/);
    expect(tracker).not.toMatch(/<form[^>]*\baction=/);
  });
});

describe("runtime: the whole client path with the network trapped", () => {
  const trapped: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    trapped.length = 0;
  });

  function trapNetwork() {
    const trap = (name: string) =>
      vi.fn((...args: unknown[]) => {
        trapped.push(`${name}: ${JSON.stringify(args).slice(0, 120)}`);
        throw new Error(`${name} must never be called by the renewal tracker`);
      });
    vi.stubGlobal("fetch", trap("fetch"));
    vi.stubGlobal("XMLHttpRequest", trap("XMLHttpRequest"));
    vi.stubGlobal("WebSocket", trap("WebSocket"));
    vi.stubGlobal("EventSource", trap("EventSource"));
    vi.stubGlobal("navigator", { sendBeacon: trap("sendBeacon") });
    const logs = vi.spyOn(console, "log");
    const infos = vi.spyOn(console, "info");
    const warns = vi.spyOn(console, "warn");
    const errors = vi.spyOn(console, "error");
    return () => [logs, infos, warns, errors].flatMap((spy) => spy.mock.calls.map(String));
  }

  it("saves, loads, estimates, renders, builds the calendar file, and removes without a single call", async () => {
    const logged = trapNetwork();
    const entries = new Map<string, unknown>();
    const kv: DeviceKv = {
      getMany: async (keys) => keys.map((key) => structuredClone(entries.get(key))),
      setMany: async (pairs) => {
        for (const [key, value] of pairs) {
          entries.set(key, structuredClone(value));
        }
      },
      deleteMany: async (keys, guard) => {
        if (guard?.keep(structuredClone(entries.get(guard.key)))) {
          return false;
        }
        for (const key of keys) {
          entries.delete(key);
        }
        return true;
      },
    };
    const deps = {
      kv,
      crypto: {
        subtle: globalThis.crypto.subtle,
        getRandomValues: (array: Uint8Array<ArrayBuffer>) => globalThis.crypto.getRandomValues(array),
      },
    };
    const facts = PILOT_RENEWAL_FACTS;
    for (const kind of ["renewal_due", "approval"] as const) {
      const reminder: RenewalReminder = {
        version: RENEWAL_REMINDER_VERSION,
        entryId: facts.entryId,
        kind,
        reportedDate: kind === "approval" ? "2026-10-15" : REPORTED,
        calendarId: newCalendarId(deps.crypto.getRandomValues),
        revision: 0,
        ...(kind === "approval" ? { ageAnswer: { min: 19, max: 64, answer: "unsure" as const } } : {}),
      };
      await saveReminder(reminder, deps);
      const loaded = await loadReminder(deps, [facts.entryId]);
      expect(loaded.status).toBe("ok");
      expect((await loadReminder(deps, [facts.entryId], { readOnly: true })).status).toBe("ok");
      const today = parseIsoDate("2027-04-10")!;
      const status = reminderStatus(today, reminderDates(reminder, facts.schedules))!;
      const message = bannerMessage(status, kind === "approval");
      const markup = [
        renderToStaticMarkup(createElement(ReportedDateView, { facts, reminder, today })),
        renderToStaticMarkup(createElement(RenewalBannerView, { banner: { phase: "soon", message } })),
      ].join("");
      expect(markup).toContain("You told us");
      const file = buildReminderCalendar({
        facts,
        kind,
        reportedDate: reminder.reportedDate,
        ...(reminder.ageAnswer !== undefined ? { ageAnswer: reminder.ageAnswer } : {}),
        calendarId: reminder.calendarId,
        now: new Date(),
        today,
        minutesIntoToday: 0,
      });
      expect(file).not.toBeNull();
      // Asking the browser to keep storage is local too (navigator is trapped here).
      expect(await requestPersistentStorage()).toBe(false);
      await clearReminder(deps);
    }
    renderToStaticMarkup(createElement(RenewalFactsSection, { facts }));
    renderToStaticMarkup(createElement(RenewalTracker, { facts }));
    expect(trapped).toEqual([]);
    expect(logged()).toEqual([]);
  });

  it("the trap bites: a fetch with the date would be caught", () => {
    trapNetwork();
    expect(() => fetch(`/api/anything?date=${REPORTED}`)).toThrow(/must never be called/);
    expect(trapped.some((call) => call.includes(REPORTED))).toBe(true);
  });
});
