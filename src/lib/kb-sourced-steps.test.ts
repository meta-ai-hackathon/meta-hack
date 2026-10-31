import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import sampleEntryJson from "../../kb/entries/pilot-program-sample.json";
import {
  ALL_KB_FACT_GROUPS,
  KB_ENTRY_STATUSES,
  KbValidationError,
  SOURCED_STEP_KB_FACT_GROUPS,
  SilentCitationError,
  citeSourcedSteps,
  parseKbEntry,
  validateKbEntry,
  type SourcedStepKbFactGroupName,
} from "./kb";

// The handoff groups (BN-24 and BN-26, HACK-46 and HACK-47): ordered steps
// that each carry their own source. Validation mirrors kb/schema.json plus
// the cross-references JSON Schema cannot express (step ids unique within
// a group, every step's source_id naming a listed source), and
// citeSourcedSteps cites every step with its own source, in order, never
// silently for a stale or withdrawn entry.

interface RawStep {
  id: string;
  label: string;
  detail: string;
  link?: { label: string; url: string };
  source_id: string;
}

interface RawStepGroup {
  items: RawStep[];
  form_id?: string;
  retrieved_at: string;
}

const SAMPLE_SOURCES = sampleEntryJson.sources;
const SAMPLE_SOURCE_IDS = SAMPLE_SOURCES.map((source) => source.id);
const REQUIRED_STEP_KEYS = ["id", "label", "detail", "source_id"] as const;

function rawWith(
  groups: Partial<Record<SourcedStepKbFactGroupName, unknown>>,
): Record<string, unknown> {
  const raw = structuredClone(sampleEntryJson) as Record<string, unknown>;
  Object.assign(raw.facts as Record<string, unknown>, groups);
  return raw;
}

function aStep(overrides: Partial<RawStep> = {}): RawStep {
  return {
    id: "sign_it",
    label: "Sign it",
    detail: "The official form asks for a signature.",
    source_id: "official_rules_source",
    ...overrides,
  };
}

function aGroup(items: RawStep[]): RawStepGroup {
  return { items, retrieved_at: "2026-10-29" };
}

// Arbitraries. Ids come from a unique array, so every generated group is
// valid by construction and nothing has to be filtered out.
const textArb = fc.string({ minLength: 1, maxLength: 40 });
const linkArb = fc.record({
  label: textArb,
  url: fc.webUrl({ validSchemes: ["https"] }),
});
const stepBodyArb = fc.record(
  {
    label: textArb,
    detail: textArb,
    link: linkArb,
    source_id: fc.constantFrom(...SAMPLE_SOURCE_IDS),
  },
  { requiredKeys: ["label", "detail", "source_id"] },
);
const groupArb: fc.Arbitrary<RawStepGroup> = fc
  .tuple(
    fc
      .uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/), {
        minLength: 1,
        maxLength: 6,
      })
      .chain((ids) =>
        fc.tuple(...ids.map((id) => stepBodyArb.map((body) => ({ id, ...body })))),
      ),
    fc.option(fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/), { nil: undefined }),
  )
  .map(([items, formId]) => ({
    items,
    ...(formId === undefined ? {} : { form_id: formId }),
    // A day after the sample's sources were retrieved, so a card that
    // showed the group's date instead of its source's would be caught.
    retrieved_at: "2026-10-30",
  }));

describe("handoff groups: schema mirror", () => {
  const schemaPath = fileURLToPath(new URL("../../kb/schema.json", import.meta.url));
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    definitions: {
      facts: { properties: Record<string, { $ref: string }> };
      sourced_step_fact_group: {
        required: string[];
        properties: {
          items: { items: { required: string[]; properties: Record<string, unknown> } };
        };
      };
    };
  };

  it("lists exactly the module's fact groups, the handoff groups included", () => {
    expect(Object.keys(schema.definitions.facts.properties).sort()).toEqual(
      [...ALL_KB_FACT_GROUPS, ...SOURCED_STEP_KB_FACT_GROUPS].sort(),
    );
    for (const name of SOURCED_STEP_KB_FACT_GROUPS) {
      expect(schema.definitions.facts.properties[name]?.$ref).toBe(
        "#/definitions/sourced_step_fact_group",
      );
    }
  });

  it("requires a source on every step, not one per group", () => {
    const definition = schema.definitions.sourced_step_fact_group;
    expect(definition.required.sort()).toEqual(["items", "retrieved_at"]);
    expect(Object.keys(definition.properties).sort()).toEqual([
      "form_id",
      "items",
      "retrieved_at",
    ]);
    expect(definition.properties.items.items.required.sort()).toEqual(
      [...REQUIRED_STEP_KEYS].sort(),
    );
    expect(Object.keys(definition.properties.items.items.properties).sort()).toEqual(
      ["detail", "id", "label", "link", "source_id"],
    );
  });
});

describe("handoff groups: validation and citation", () => {
  it("accepts any well-formed group and cites every step with its own source, in order", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SOURCED_STEP_KB_FACT_GROUPS),
        groupArb,
        (name, group) => {
          const raw = rawWith({ [name]: group });
          expect(validateKbEntry(raw)).toEqual([]);
          const entry = parseKbEntry(raw);
          expect(entry.facts[name]?.formId).toBe(group.form_id);
          const citations = citeSourcedSteps(entry, name);
          expect(citations.map((citation) => citation.step.id)).toEqual(
            group.items.map((item) => item.id),
          );
          citations.forEach((citation, index) => {
            const item = group.items[index]!;
            const source = SAMPLE_SOURCES.find(
              (candidate) => candidate.id === item.source_id,
            )!;
            expect(citation.step.label).toBe(item.label);
            expect(citation.step.detail).toBe(item.detail);
            expect(citation.step.link).toEqual(item.link);
            expect(citation.sourceId).toBe(item.source_id);
            expect(citation.sourceTitle).toBe(source.title);
            expect(citation.sourceUrl).toBe(source.url);
            expect(source.retrieved_at).not.toBe(group.retrieved_at);
            expect(citation.retrievedAt).toBe(source.retrieved_at);
            expect(citation.entryVersion).toBe(entry.version);
            expect(citation.status).toBe("active");
            expect(citation.group).toBe(name);
          });
        },
      ),
      { numRuns: 150 },
    );
  });

  it("rejects a group with any one required step field removed", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SOURCED_STEP_KB_FACT_GROUPS),
        groupArb,
        fc.nat(),
        fc.constantFrom(...REQUIRED_STEP_KEYS),
        (name, group, pick, key) => {
          const broken = structuredClone(group);
          delete (broken.items[pick % broken.items.length] as Partial<RawStep>)[key];
          const raw = rawWith({ [name]: broken });
          expect(validateKbEntry(raw).some((problem) => problem.includes(key))).toBe(true);
          expect(() => parseKbEntry(raw)).toThrow(KbValidationError);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("rejects a step whose source_id names no listed source", () => {
    fc.assert(
      fc.property(
        groupArb,
        fc.nat(),
        fc.stringMatching(/^[a-z0-9_-]{0,12}$/),
        (group, pick, suffix) => {
          // The zz_ prefix keeps the id well-formed and off the sample's list.
          const broken = structuredClone(group);
          broken.items[pick % broken.items.length]!.source_id = `zz_${suffix}`;
          const problems = validateKbEntry(rawWith({ submission_steps: broken }));
          expect(problems.some((problem) => problem.includes("does not match a listed source"))).toBe(
            true,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects a repeated step id", () => {
    fc.assert(
      fc.property(groupArb, fc.nat(), (group, pick) => {
        const repeated = structuredClone(group);
        repeated.items.push(structuredClone(repeated.items[pick % repeated.items.length]!));
        const problems = validateKbEntry(rawWith({ after_you_apply: repeated }));
        expect(problems.some((problem) => problem.includes("repeats an earlier step id"))).toBe(
          true,
        );
      }),
      { numRuns: 100 },
    );
  });

  it("never throws anything but KbValidationError on an arbitrary group", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        try {
          parseKbEntry(rawWith({ submission_steps: value }));
          return true;
        } catch (error) {
          return error instanceof KbValidationError;
        }
      }),
      { numRuns: 300 },
    );
  });

  it.each([
    ["a group-level source_id", { ...aGroup([aStep()]), source_id: "official_rules_source" }, "source_id"],
    ["a malformed form id", { ...aGroup([aStep()]), form_id: "Not A Form!" }, "form_id"],
    ["an unknown step key", aGroup([{ ...aStep(), bonus: "nope" } as RawStep]), "bonus"],
    ["a malformed step id", aGroup([aStep({ id: "Not An Id!" })]), ".id"],
    ["an empty label", aGroup([aStep({ label: "" })]), ".label"],
    ["an empty detail", aGroup([aStep({ detail: "" })]), ".detail"],
    ["a non-https link", aGroup([aStep({ link: { label: "Apply", url: "http://example.org/apply" } })]), ".link.url"],
    ["a link without a label", aGroup([aStep({ link: { url: "https://example.org/apply" } as RawStep["link"] })]), ".link.label"],
    ["a link with an unknown key", aGroup([aStep({ link: { label: "Apply", url: "https://example.org/apply", target: "_blank" } as RawStep["link"] })]), "target"],
    ["an empty items list", aGroup([]), "non-empty"],
    ["a retrieval date off the calendar", { items: [aStep()], retrieved_at: "2026-02-30" }, "retrieved_at"],
    ["a step that is not an object", { items: ["Sign it."], retrieved_at: "2026-10-29" }, "must be an object"],
    ["a group that is not an object", ["Sign it."], "must be an object"],
  ])("rejects %s", (_label, group, fragment) => {
    const raw = rawWith({ submission_steps: group });
    const problems = validateKbEntry(raw);
    expect(problems.some((problem) => problem.includes(fragment)), problems.join("; ")).toBe(true);
    expect(() => parseKbEntry(raw)).toThrow(KbValidationError);
  });

  it("keeps both groups optional", () => {
    const entry = parseKbEntry(rawWith({}));
    expect(entry.facts.submission_steps).toBeUndefined();
    expect(entry.facts.after_you_apply).toBeUndefined();
    expect(() => citeSourcedSteps(entry, "submission_steps")).toThrow(KbValidationError);
  });

  it("never cites a stale or withdrawn entry's steps silently", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...KB_ENTRY_STATUSES.filter((status) => status !== "active")),
        fc.string({ minLength: 1, maxLength: 80 }),
        groupArb,
        (status, reason, group) => {
          const raw = rawWith({ submission_steps: group });
          raw.status = status;
          raw.status_reason = reason;
          const entry = parseKbEntry(raw);
          expect(() => citeSourcedSteps(entry, "submission_steps")).toThrow(
            SilentCitationError,
          );
          const citations = citeSourcedSteps(entry, "submission_steps", {
            acknowledgeNonActive: true,
          });
          for (const citation of citations) {
            expect(citation.status).toBe(status);
            expect(citation.statusReason).toBe(reason);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
