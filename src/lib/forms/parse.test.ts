import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  MAPPING_MAX_TOKENS,
  assertLoadablePdf,
  discoverAcroFormFields,
  extractFieldLabels,
  mapFieldsToQuestions,
  parseFormPdf,
} from "./parse";
import { getFormRegistryEntry } from "./registry";
import { AppError, setLogSink } from "../telemetry";
import {
  CHAT_MODEL,
  setModelTransport,
  type ModelRequestInit,
} from "../model";

// Forms parser tests (Mission v2 M4, VAL-PDF-001): the committed synthetic
// AcroForm sample parses into exactly the fields the committed registry
// entry describes, labels are matched by proximity, and the LLM-assisted
// mapping is grounded on the spec + labels (scripted transport — no live
// model calls) while degrading honestly on model failure.

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const acroformBytes = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-acroform.pdf")));
const xfaBytes = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-xfa.pdf")));
const encryptedBytes = () =>
  new Uint8Array(readFileSync(path.join(FIXTURES, "sample-form-encrypted.pdf")));

interface RecordedCall {
  readonly body: {
    model: string;
    max_tokens: number;
    messages: { role: string; content: string }[];
  };
}

const recordedCalls: RecordedCall[] = [];

function scriptMappingResponse(content: string): void {
  setModelTransport(async (_url, init: ModelRequestInit) => {
    recordedCalls.push({
      body: JSON.parse(String(init.body)) as RecordedCall["body"],
    });
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        model: CHAT_MODEL,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 5 },
        },
      }),
      { status: 200 },
    );
  });
}

beforeAll(() => {
  setLogSink(() => undefined);
  // The model client refuses to call the transport without a key present;
  // scripted-transport tests set a sentinel exactly like the route tests do.
  process.env.MODEL_API_KEY = "sentinel-test-key-never-log";
});

afterEach(() => {
  setModelTransport(undefined);
  recordedCalls.length = 0;
});

describe("AcroForm discovery", () => {
  it("finds exactly the registry entry's fields in the committed sample", async () => {
    const pdf = await assertLoadablePdf(acroformBytes());
    const fields = discoverAcroFormFields(pdf);
    const entry = getFormRegistryEntry("sample-application-form");
    expect(fields.map((field) => field.name)).toEqual(
      entry.fields.map((field) => field.name),
    );
  });

  it("carries kind, page, and rectangle for every field", async () => {
    const pdf = await assertLoadablePdf(acroformBytes());
    const fields = discoverAcroFormFields(pdf);
    for (const field of fields) {
      expect(field.page).toBe(1);
      expect(field.rect.width).toBeGreaterThan(0);
      expect(field.rect.height).toBeGreaterThan(0);
    }
    const byName = new Map(fields.map((field) => [field.name, field]));
    expect(byName.get("applicant_name")?.kind).toBe("text");
    expect(byName.get("housing_situation")?.kind).toBe("dropdown");
    expect(byName.get("mail_consent")?.kind).toBe("checkbox");
    expect(byName.get("applicant_date_of_birth")?.kind).toBe("text");
  });
});

describe("label extraction by proximity", () => {
  it("matches each field to the label text printed near it", async () => {
    const pdf = await assertLoadablePdf(acroformBytes());
    const fields = discoverAcroFormFields(pdf);
    const labels = await extractFieldLabels(acroformBytes(), fields);
    expect(labels.applicant_name).toBe("Your full name");
    expect(labels.applicant_date_of_birth).toBe("Date of birth");
    expect(labels.household_size_count).toBe(
      "How many people live in your household?",
    );
    expect(labels.housing_situation).toBe(
      "What is your current housing situation?",
    );
    expect(labels.monthly_rent_amount).toBe("Monthly rent or housing cost");
    expect(labels.contact_phone).toBe("Phone number");
    expect(labels.contact_email).toBe("Email address");
    expect(labels.mail_consent).toBe("May we send mail to a shelter address?");
    expect(labels.case_number).toBe(
      "Case number, if you already have one (optional)",
    );
  });

  it("never mistakes text inside a widget for the label", async () => {
    // The dropdown renders its option labels inside its own rectangle; the
    // matcher must not pick one of those as the field's label.
    const pdf = await assertLoadablePdf(acroformBytes());
    const fields = discoverAcroFormFields(pdf);
    const labels = await extractFieldLabels(acroformBytes(), fields);
    expect(labels.housing_situation).not.toBe("In a shelter");
  });
});

describe("LLM-assisted mapping (scripted transport)", () => {
  const mappingsJson = JSON.stringify({
    mappings: [
      {
        fieldName: "applicant_date_of_birth",
        question: "What is your date of birth?",
        specQuestionId: "date_of_birth",
        piiLikely: true,
      },
      {
        fieldName: "housing_situation",
        question: "What is your current housing situation?",
        specQuestionId: "housing_status",
        piiLikely: true,
      },
      {
        fieldName: "case_number",
        question: "What is your case number?",
        specQuestionId: null,
        piiLikely: false,
      },
    ],
  });

  it("grounds the prompt on the spec and the extracted labels", async () => {
    scriptMappingResponse(mappingsJson);
    const parsed = await parseFormPdf(acroformBytes());
    expect(recordedCalls).toHaveLength(1);
    const { body } = recordedCalls[0];
    expect(body.model).toBe(CHAT_MODEL);
    expect(body.max_tokens).toBeGreaterThanOrEqual(1024);
    expect(body.max_tokens).toBe(MAPPING_MAX_TOKENS);
    const system = body.messages[0].content;
    expect(system).toContain("STRICT JSON");
    const user = body.messages[1].content;
    // Grounding: the spec ids, the spec prompts, and the form labels.
    expect(user).toContain("date_of_birth");
    expect(user).toContain("housing_status");
    expect(user).toContain("Your full name");
    expect(user).toContain("case_number");
    // The mapped output uses the scripted answers where the model mapped:
    const dob = parsed.mapping.find(
      (item) => item.fieldName === "applicant_date_of_birth",
    );
    expect(dob?.specQuestionId).toBe("date_of_birth");
    expect(dob?.question).toBe("What is your date of birth?");
    expect(dob?.piiLikely).toBe(true);
  });

  it("coerces unknown spec ids to null instead of trusting the model", async () => {
    scriptMappingResponse(
      JSON.stringify({
        mappings: [
          {
            fieldName: "applicant_name",
            question: "What is your full name?",
            specQuestionId: "made_up_question",
            piiLikely: false,
          },
        ],
      }),
    );
    const pdf = await assertLoadablePdf(acroformBytes());
    const fields = discoverAcroFormFields(pdf);
    const labels = await extractFieldLabels(acroformBytes(), fields);
    const mapping = await mapFieldsToQuestions(fields, labels);
    const name = mapping.find((item) => item.fieldName === "applicant_name");
    expect(name?.specQuestionId).toBeNull();
    expect(name?.question).toBe("What is your full name?");
  });

  it("falls back to label-verbatim questions when the model fails", async () => {
    setModelTransport(async () => {
      throw new Error("network down");
    });
    const parsed = await parseFormPdf(acroformBytes());
    expect(parsed.mapping).toHaveLength(parsed.fields.length);
    const name = parsed.mapping.find(
      (item) => item.fieldName === "applicant_name",
    );
    expect(name?.question).toBe("Your full name");
    expect(name?.specQuestionId).toBeNull();
    expect(name?.piiLikely).toBe(false);
  });

  it("falls back when the model returns garbage", async () => {
    scriptMappingResponse("I am sorry, I cannot do that.");
    const parsed = await parseFormPdf(acroformBytes());
    expect(parsed.mapping).toHaveLength(parsed.fields.length);
    for (const item of parsed.mapping) {
      expect(item.specQuestionId).toBeNull();
      expect(item.question).not.toBe("");
    }
  });
});

describe("unfillable input rejection (VAL-PDF-004)", () => {
  it("rejects an XFA-carrying PDF with a clear validation error", async () => {
    const request = assertLoadablePdf(xfaBytes());
    const error = (await request.catch((caught) => caught)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("validation_error");
    expect(error.safeMessage).toMatch(/XFA/);
  });

  it("rejects a password-encrypted PDF with a clear validation error", async () => {
    const request = assertLoadablePdf(encryptedBytes());
    const error = (await request.catch((caught) => caught)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("validation_error");
    expect(error.safeMessage).toMatch(/password/);
  });

  it("rejects corrupt bytes with a clear validation error", async () => {
    const request = assertLoadablePdf(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]));
    const error = (await request.catch((caught) => caught)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("validation_error");
  });

  it("admits the committed AcroForm sample", async () => {
    await expect(assertLoadablePdf(acroformBytes())).resolves.toBeDefined();
  });
});
