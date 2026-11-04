import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { buildFormFlow } from "../forms/flow";
import { parseCommittedRegistryEntries } from "../forms/registry-core";
import { setLogSink, type LogLine } from "../telemetry";
import {
  EMPTY_CLIENT_ANSWERS,
  saveClientAnswer,
  type ClientAnswerState,
} from "./client-store";
import { fillFormOnDevice } from "./device-fill";
import { fillReviewOnDevice, type ReviewFillField } from "./review-fill";

// The download path's guarantees after the server fill route's retirement
// (HACK-138 owner decision, 2026-11-04): POST /api/forms/<formId>/fill is
// gone — it filled the form on the server from the vault and sent the PDF
// back, which the sanctioned-download rule (rules.md, HACK-115) does not
// permit. Both product downloads now fill on the device (review-fill.ts for
// the conversation page, device-fill.ts for the step-by-step page), so the
// guarantees the fill route's tests used to pin re-vehicle HERE, onto the
// on-device modules. The assertions' meaning is unchanged — only their
// vehicle moved:
//
// - the fill round-trips values with per-field provenance, unknown fields
//   visibly blank and named to-resolve (VAL-PDF-003's meaning);
// - bad templates fill nothing (VAL-PDF-004's meaning);
// - filled bytes and answer values are never persisted server-side — no
//   file, no database write, no log line (VAL-PDF-005's meaning): there is
//   no longer any server surface that could receive them at all;
// - the typed signature fills only from fresh typed input, never from a
//   stored answer or a payload value, and the app never signs
//   (VAL-VJS2-002's meaning);
// - the second application's download fills its client-held mapped fields,
//   leaves unknowns blank and named, and its signature block behaves the
//   same way (the second form's download contracts, on-device).

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES = path.join(REPO_ROOT, "lib/forms/fixtures");

const SAMPLE_BYTES = () =>
  new Uint8Array(
    readFileSync(path.join(FIXTURES, "sample-form-acroform.pdf")),
  );
const REAL_BYTES = () =>
  new Uint8Array(
    readFileSync(path.join(FIXTURES, "dhb-5200-ia-9-2020.pdf")),
  );
const DSS_BYTES = () =>
  new Uint8Array(
    readFileSync(path.join(FIXTURES, "dss-8207-fns-app-10-2024.pdf")),
  );

const ENTRIES = parseCommittedRegistryEntries(
  (detail) => new Error(detail),
);
const SAMPLE_ENTRY = ENTRIES.find(
  (entry) => entry.id === "sample-application-form",
)!;
const REAL_ENTRY = ENTRIES.find((entry) => entry.id === "dhb-5200")!;
const DSS_ENTRY = ENTRIES.find((entry) => entry.id === "dss-8207")!;

/** The review payload's field views, built exactly as the review route builds them. */
function payloadViews(
  entry: typeof SAMPLE_ENTRY,
  answers: Parameters<typeof buildFormFlow>[1],
): readonly ReviewFillField[] {
  return buildFormFlow(entry, answers).fields;
}

/** The same answers as the device keeps them (the step-by-step page's state). */
function deviceState(
  answers: Record<
    string,
    { status: "known" | "unknown" | "unverified"; value: unknown }
  >,
): ClientAnswerState {
  let state = EMPTY_CLIENT_ANSWERS;
  for (const [questionId, answer] of Object.entries(answers)) {
    state = saveClientAnswer(state, {
      questionId,
      status: answer.status,
      value: answer.value,
      provenance: "user_supplied",
    });
  }
  return state;
}

describe("the server fill route is retired (HACK-138)", () => {
  it("no fill route exists under src/app/api/forms, and the review route remains", () => {
    // Non-vacuous: the review route (the download path's one payload GET)
    // is still there, so the walk below really covers the route tree.
    expect(existsUnder("app/api/forms", "review", "route.ts")).toBe(true);
    expect(existsUnder("app/api/forms", "fill", "route.ts")).toBe(false);
  });

  it("the walkthrough journey no longer posts answers to a fill route", () => {
    const core = readFileSync(
      path.join(REPO_ROOT, "..", "scripts", "walkthrough-core.mjs"),
      "utf8",
    );
    expect(core.includes("/fill`")).toBe(false);
    expect(core.includes("/fill'")).toBe(false);
    expect(core.includes('/fill"')).toBe(false);
  });
});

function existsUnder(
  rootRelative: string,
  dirName: string,
  fileName: string,
): boolean {
  const root = path.join(REPO_ROOT, rootRelative);
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const joined = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        entry.name === dirName &&
        existsSyncFile(path.join(joined, fileName))
      ) {
        return true;
      }
      if (entry.isDirectory() && walk(joined)) {
        return true;
      }
    }
    return false;
  };
  return walk(root);
}

function existsSyncFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

describe("the on-device fills never persist server-side (VAL-PDF-005)", () => {
  const SENTINEL = "PERSIST-SENTINEL-DEVICE-FILL";

  afterEach(() => {
    setLogSink(() => undefined);
  });

  it("the download's fill path imports no filesystem, database, or send API", () => {
    // Static backstop, checked on the source: every module the two on-device
    // fills run has no way to write a file, reach the database, or send a
    // request. With the fill route deleted there is no server surface that
    // could receive an answer at all — this pins that the fill machinery
    // itself grew none back.
    const fillPathModules = [
      "lib/intake/review-fill.ts",
      "lib/intake/device-fill.ts",
      "lib/intake/device-form.ts",
      "lib/forms/fill-core.ts",
      "lib/forms/registry-core.ts",
      "lib/forms/display.ts",
    ];
    for (const relative of fillPathModules) {
      const source = readFileSync(path.join(REPO_ROOT, relative), "utf8");
      expect(source, relative).not.toMatch(/from\s+["'](node:)?fs/);
      expect(source, relative).not.toMatch(/require\(["'](node:)?fs/);
      expect(source, relative).not.toContain("writeFile");
      expect(source, relative).not.toContain("appendFile");
      // Any relative specifier that resolves to the database or vault module
      // at any depth ("../db" from lib/intake, "../../lib/db" from deeper
      // nests), or the Postgres driver directly.
      expect(source, relative).not.toMatch(
        /(?:from\s+|import\s*\(\s*|require\(\s*)["'](?:\.{1,2}\/)+(?:lib\/)?(?:db|vault)["']/,
      );
      expect(source, relative).not.toMatch(/from\s+["']postgres["']/);
      expect(source, relative).not.toMatch(/\bfetch\s*\(/);
      expect(source, relative).not.toContain("XMLHttpRequest");
      expect(source, relative).not.toContain("sendBeacon");
    }
  });

  it("a sentinel typed value reaches only the person's own bytes", async () => {
    const logLines: LogLine[] = [];
    setLogSink((line) => logLines.push(JSON.parse(line) as LogLine));

    // Both download surfaces, each filling with the sentinel typed value.
    const review = await fillReviewOnDevice(
      SAMPLE_BYTES(),
      payloadViews(SAMPLE_ENTRY, {
        household_size: { status: "known", value: 3 },
      }),
      { applicant_name: SENTINEL },
      SAMPLE_ENTRY,
    );
    const device = await fillFormOnDevice(
      SAMPLE_BYTES(),
      deviceState({
        household_size: { status: "known", value: 3 },
      }),
      { applicant_name: SENTINEL },
      SAMPLE_ENTRY,
    );
    setLogSink(() => undefined);

    expect(review.kind).toBe("filled");
    expect(device.kind).toBe("filled");
    if (review.kind !== "filled" || device.kind !== "filled") {
      return;
    }
    // The bytes ARE the product: the person's own copy carries their value
    // (read back the way a PDF viewer would — streams are compressed, so a
    // raw byte grep proves nothing).
    for (const outcome of [review.outcome, device.outcome]) {
      const pdf = await PDFDocument.load(outcome.bytes);
      expect(pdf.getForm().getTextField("applicant_name").getText()).toBe(
        SENTINEL,
      );
    }

    // 1. No log line carries the sentinel.
    for (const line of logLines) {
      expect(JSON.stringify(line)).not.toContain(SENTINEL);
    }

    // 2. Filesystem: no file in the process tmpdir carries the sentinel.
    //    Only REGULAR files are read: open()ing a FIFO for read blocks
    //    until a writer appears (a synchronous freeze — this hung a CI
    //    runner), and size is bounded so no giant pre-existing file
    //    dominates the run.
    for (const name of readdirSync(os.tmpdir())) {
      const candidate = path.join(os.tmpdir(), name);
      try {
        const stat = statSync(candidate, { throwIfNoEntry: false });
        if (!stat?.isFile() || stat.size > 64 * 1024 * 1024) {
          continue;
        }
        const content = readFileSync(candidate);
        expect(content.includes(SENTINEL)).toBe(false);
      } catch {
        // unreadable (permissions) — skip
      }
    }

    // 3. No database home exists for filled bytes: the static scan above
    //    proved the fill path imports no database module at all, so no
    //    table can see the sentinel — the same guarantee the fill route's
    //    table scan pinned, now by construction.
  });
});

describe("the real form's typed signature on the download fill (VAL-VJS2-002)", () => {
  it("without a typed signature the form downloads unsigned and the signature is named still-needed", async () => {
    // The payload DOES carry client-held values (the state at least) — yet
    // nothing may pre-fill the signature: its only source is the fresh
    // typed draft, and this fill carries none.
    const fields = payloadViews(REAL_ENTRY, {
      state: { status: "known", value: "NC" },
    });
    const result = await fillReviewOnDevice(REAL_BYTES(), fields, {}, REAL_ENTRY);
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    expect(pdf.getForm().getTextField("Signature").getText() ?? "").toBe("");
    expect(
      result.outcome.toResolve.map((item) => item.fieldName),
    ).toContain("Signature");
  });

  it("the signature fills only from the fresh typed draft, never from a payload value", async () => {
    // The payload's prefilled name value is NOT a signature source: the
    // signature fills only from the draft typed into the review, and the
    // two differ here to prove no copying or auto-derivation.
    const fields = payloadViews(REAL_ENTRY, {
      state: { status: "known", value: "NC" },
    });
    const result = await fillReviewOnDevice(
      REAL_BYTES(),
      fields,
      { Signature: "Alex Rivera" },
      REAL_ENTRY,
    );
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    expect(pdf.getForm().getTextField("Signature").getText()).toBe(
      "Alex Rivera",
    );
    const signature = result.outcome.filled.find(
      (item) => item.fieldName === "Signature",
    );
    expect(signature?.provenance).toBe("user_supplied");
  });
});

describe("the second application's download fill (dss-8207)", () => {
  // The mapped spec answers the review payload carries: the non-private
  // values ride the payload; the vault-held ones (date of birth, phone,
  // email) are structurally omitted — their views carry the status badge,
  // never a value, and the fill degrades them fail-closed.
  const SPEC_ANSWERS = {
    housing_cost: { status: "known", value: 950 },
    utilities_cost: { status: "known", value: 180 },
    state: { status: "known", value: "NC" },
    received_benefits_before: { status: "known", value: false },
    veteran_status: { status: "known", value: true },
    date_of_birth: { status: "known", value: "1979-07-08" },
    phone_contact: { status: "known", value: "555-010-9911" },
    email_contact: { status: "known", value: "alex.rivera@example.com" },
  } as const;

  it("fills the client-held mapped fields; vault-held answers degrade to blank and to-resolve", async () => {
    const fields = payloadViews(DSS_ENTRY, SPEC_ANSWERS);
    const result = await fillReviewOnDevice(DSS_BYTES(), fields, {}, DSS_ENTRY);
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    const form = pdf.getForm();
    // The payload's non-private mapped values fill in their display forms.
    expect(
      form.getTextField(
        "AmountWhat are the total monthly shelter costs rent or mortgage that the household pays",
      ).getText(),
    ).toBe("950");
    expect(form.getTextField("Text5").getText()).toBe("North Carolina");
    expect(form.getCheckBox("A veteran").isChecked()).toBe(true);
    expect(
      form
        .getRadioGroup(
          "Does anyone get Food and Nutrition Services Food Stamps or SNAP in this or another county or state",
        )
        .getSelected(),
    ).toBe("No_6");
    // Vault-held answers the page doesn't hold stay VISIBLY blank — never
    // guessed, never asked for.
    expect(form.getTextField("Birth DateSelf").getText() ?? "").toBe("");
    expect(form.getTextField("Message Number").getText() ?? "").toBe("");
    expect(form.getTextField("Email Address voluntary").getText() ?? "").toBe("");
    // Each blank mapped field is honestly named to-resolve with its
    // plain-language question.
    const toResolve = new Map(
      result.outcome.toResolve.map((item) => [item.fieldName, item.reason]),
    );
    for (const name of [
      "Birth DateSelf",
      "Message Number",
      "Email Address voluntary",
      "Name of School",
    ]) {
      expect(toResolve.get(name), name).toBe("unknown");
    }
    // Everything filled carries a provenance label.
    for (const item of result.outcome.filled) {
      expect(item.provenance.length).toBeGreaterThan(0);
    }
  });

  it("without typed input the signature block stays blank and is named still-needed; the app never signs", async () => {
    const fields = payloadViews(DSS_ENTRY, SPEC_ANSWERS);
    const result = await fillReviewOnDevice(DSS_BYTES(), fields, {}, DSS_ENTRY);
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    const form = pdf.getForm();
    for (const name of [
      "Text1",
      "Text2",
      "First Name Middle Initial Last Name",
      "Date Signed",
    ]) {
      expect(form.getTextField(name).getText() ?? "", name).toBe("");
    }
    const toResolve = result.outcome.toResolve.map((item) => item.fieldName);
    for (const name of [
      "Text1",
      "Text2",
      "First Name Middle Initial Last Name",
      "Date Signed",
    ]) {
      expect(toResolve, name).toContain(name);
    }
  });

  it("typed drafts fill the signature block exactly as typed", async () => {
    const fields = payloadViews(DSS_ENTRY, SPEC_ANSWERS);
    const result = await fillReviewOnDevice(
      DSS_BYTES(),
      fields,
      {
        Text1: "Alex Rivera",
        "Date Signed": "11/04/2026",
      },
      DSS_ENTRY,
    );
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    const form = pdf.getForm();
    expect(form.getTextField("Text1").getText()).toBe("Alex Rivera");
    expect(form.getTextField("Date Signed").getText()).toBe("11/04/2026");
  });

  it("the digital-signature widget is never filled, even when a draft names it", async () => {
    const fields = payloadViews(DSS_ENTRY, SPEC_ANSWERS);
    const result = await fillReviewOnDevice(
      DSS_BYTES(),
      fields,
      { "Your Signature or Authorized Representative": "Forged McForgeface" },
      DSS_ENTRY,
    );
    if (result.kind !== "filled") {
      throw new Error(`expected a fill, got ${result.kind}`);
    }
    const pdf = await PDFDocument.load(result.outcome.bytes);
    // The widget stays a signature widget with no value API — the pipeline
    // never converts it into a filled field; the person signs by hand.
    expect(
      pdf.getForm().getField("Your Signature or Authorized Representative")
        ?.constructor.name,
    ).toBe("PDFSignature");
    // The forged string is absent from the output bytes entirely.
    expect(new TextDecoder().decode(result.outcome.bytes)).not.toContain(
      "Forged",
    );
  });
});
