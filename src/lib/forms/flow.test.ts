import { describe, expect, it } from "vitest";
import { getFormRegistryEntry } from "./registry";
import { buildFormFlow } from "./flow";

// Form-driven flow tests (Mission v2 M4, VAL-PDF-002): form questions join
// the conversation — mapped fields pre-fill from stored answers ("we
// already know this from what you told us"), conditional fields respect the
// spec's skip logic, and unmapped fields are asked normally. Pii values are
// structurally omitted from the view; their status badge speaks for them.

const ENTRY = getFormRegistryEntry("sample-application-form");

describe("buildFormFlow (VAL-PDF-002)", () => {
  it("pre-fills mapped fields from stored answers without re-asking", () => {
    const view = buildFormFlow(
      ENTRY,
      {
        household_size: { status: "known", value: 3 },
        date_of_birth: { status: "known", value: "1990-01-01" },
        housing_status: { status: "known", value: "shelter" },
        phone_contact: { status: "known", value: "555-0100" },
        email_contact: { status: "known", value: "person@example.com" },
        mailing_situation: { status: "known", value: "shelter" },
        shelter_mail_consent: { status: "known", value: true },
        id_status: { status: "known", value: "need_id" },
        id_issue_detail: { status: "known", value: "my ID was lost" },
      },
      { applicant_name: { value: "Jane Tester", provenance: "user_supplied" } },
    );
    const byName = new Map(view.fields.map((field) => [field.fieldName, field]));
    expect(byName.get("household_size_count")?.state).toBe("prefilled");
    expect(byName.get("household_size_count")?.value).toBe("3");
    expect(byName.get("applicant_date_of_birth")?.state).toBe("prefilled");
    // Choice answers on pii-likely fields stay value-less by design: the
    // status badge speaks for them, the fill uses the stored value.
    expect(byName.get("housing_situation")?.state).toBe("prefilled");
    const housing = byName.get("housing_situation");
    expect(housing !== undefined && !("value" in housing)).toBe(true);
    // The spec's own skip logic marks housing_cost not applicable when the
    // housing situation is a shelter: not prefilled, never asked.
    expect(byName.get("monthly_rent_amount")?.state).toBe("not_applicable");
    // case_number is unmapped with no stored form answer: still asked.
    expect(byName.get("case_number")?.state).toBe("asked");
    expect(view.counts.prefilled).toBe(8);
    expect(view.counts.asked).toBe(1);
    expect(view.counts.notApplicable).toBe(1);
    expect(view.toResolve.map((item) => item.fieldName)).toEqual([
      "case_number",
    ]);
  });

  it("omits pii values structurally while keeping the status badge", () => {
    const view = buildFormFlow(ENTRY, {
      date_of_birth: { status: "known", value: "1990-01-01" },
      phone_contact: { status: "known", value: "555-0100" },
    });
    const dob = view.fields.find(
      (field) => field.fieldName === "applicant_date_of_birth",
    );
    expect(dob?.state).toBe("prefilled");
    expect(dob?.piiLikely).toBe(true);
    expect(dob?.status).toBe("known");
    expect(dob !== undefined && !("value" in dob)).toBe(true);
  });

  it("marks conditional fields not-applicable when the spec's skip logic skips them", () => {
    const view = buildFormFlow(ENTRY, {
      id_status: { status: "known", value: "have_id" },
      mailing_situation: { status: "known", value: "family_or_friend" },
    });
    const byName = new Map(view.fields.map((field) => [field.fieldName, field]));
    expect(byName.get("id_problem_explanation")?.state).toBe("not_applicable");
    expect(byName.get("mail_consent")?.state).toBe("not_applicable");
    // Skipped fields are never to-resolve.
    const names = view.toResolve.map((item) => item.fieldName);
    expect(names).not.toContain("id_problem_explanation");
    expect(names).not.toContain("mail_consent");
  });

  it("asks mapped-but-unanswered fields and lists them as to-resolve", () => {
    const view = buildFormFlow(ENTRY, {
      household_size: { status: "known", value: 2 },
    });
    const dob = view.fields.find(
      (field) => field.fieldName === "applicant_date_of_birth",
    );
    expect(dob?.state).toBe("asked");
    expect(view.toResolve.map((item) => item.fieldName)).toContain(
      "applicant_date_of_birth",
    );
  });

  it("an unknown answer is still asked (fail-open) and to-resolve", () => {
    const view = buildFormFlow(ENTRY, {
      phone_contact: { status: "unknown", value: null },
    });
    const phone = view.fields.find(
      (field) => field.fieldName === "contact_phone",
    );
    expect(phone?.state).toBe("asked");
    expect(phone?.status).toBe("unknown");
    expect(view.toResolve.map((item) => item.fieldName)).toContain(
      "contact_phone",
    );
  });

  it("unmapped fields are asked normally and answered into the form store", () => {
    const view = buildFormFlow(ENTRY, {});
    const name = view.fields.find((field) => field.fieldName === "applicant_name");
    expect(name?.state).toBe("asked");
    expect(name?.specQuestionId).toBeNull();
    const caseNumber = view.fields.find(
      (field) => field.fieldName === "case_number",
    );
    expect(caseNumber?.state).toBe("asked");
    const toResolveNames = view.toResolve.map((item) => item.fieldName);
    expect(toResolveNames).toContain("applicant_name");
    expect(toResolveNames).toContain("case_number");

    // With a stored form answer, the unmapped field pre-fills too.
    const answered = buildFormFlow(ENTRY, {}, {
      applicant_name: { value: "Jane Tester", provenance: "user_supplied" },
    });
    const answeredName = answered.fields.find(
      (field) => field.fieldName === "applicant_name",
    );
    expect(answeredName?.state).toBe("prefilled");
    // piiLikely stays flagged even when the answer is on file: the value
    // stays out of the client view by design.
    expect(answeredName?.piiLikely).toBe(true);
    expect(answeredName !== undefined && !("value" in answeredName)).toBe(true);
    expect(answered.toResolve.map((item) => item.fieldName)).not.toContain(
      "applicant_name",
    );
  });
});
