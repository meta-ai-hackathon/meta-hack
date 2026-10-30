import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb } from "../../../lib/db";
import { runMigrations } from "../../../lib/migrate";
import { setLogSink } from "../../../lib/telemetry";
import {
  loadAnswers,
  readSessionCookie,
  saveAnswer,
  sessionCookieHeader,
} from "../../../lib/intake/store";
import { QUESTION_BY_ID, PII_QUESTION_IDS_IN_SPEC } from "../../../lib/intake/spec";
import { KB_ENTRIES } from "../../../lib/kb";
import { findBannedClaims } from "../../../lib/honesty";
import { GET, POST } from "./route";

// Match route tests (Mission v2 M3, VAL-MATCH-001..005 at the HTTP surface):
// the route reads the session's stored answers server-side and returns the
// ranked cards plus the to-resolve list. Every model call is absent — the
// explainer degrades to entry-fact copy when no transport is installed
// (no key in the test env), keeping these tests network-free.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_match";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const adminUrl = databaseFrom(databaseUrl, "postgres");
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

let admin: postgres.Sql;
let testDb: postgres.Sql;
let sessionId = "";

beforeAll(async () => {
  admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  testDb = postgres(testUrl, { max: 1 });
  process.env.DATABASE_URL = testUrl;
  await runMigrations(testDb);
  const rows = await testDb`
    INSERT INTO person DEFAULT VALUES RETURNING id
  `;
  const personId = String(rows[0].id);
  const sessionRows = await testDb`
    INSERT INTO session (person_id, caseworker_assisted, status)
    VALUES (${personId}, false, 'draft') RETURNING id
  `;
  sessionId = String(sessionRows[0].id);
});

beforeEach(() => {
  setLogSink(() => undefined);
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await Promise.all([admin.end({ timeout: 1 }), testDb.end({ timeout: 1 })]);
  await closeDb();
});

afterEach(() => {
  setLogSink(() => undefined);
});

// Seeded answers: a known benefit-relevant core plus explicit unknowns.
async function seedAnswers(): Promise<void> {
  await saveAnswer(sessionId, "main_goal", "known", "food", "user_supplied");
  await saveAnswer(sessionId, "housing_status", "known", "shelter", "user_supplied");
  await saveAnswer(sessionId, "income_sources", "known", ["none"], "user_supplied");
  await saveAnswer(sessionId, "household_size", "known", 3, "user_supplied");
  await saveAnswer(sessionId, "id_status", "unknown", null, "user_supplied");
  await saveAnswer(sessionId, "citizenship_status", "unverified", "us_citizen", "ai_drafted");
}

function matchRequest(method: "GET" | "POST"): Request {
  return new Request("http://localhost:3100/api/match", {
    method,
    headers: { cookie: sessionCookieHeader(sessionId) },
  });
}

interface MatchResponseBody {
  hasSession: boolean;
  matches: {
    entryId: string;
    entryTitle: string;
    entryVersion: number;
    score: number;
    framing: string;
    reasons: {
      text: string;
      questionId?: string;
      answerLabel?: string;
      source: {
        entryId: string;
        entryVersion: number;
        entryStatus: string;
        sourceUrl: string;
        retrievedAt: string;
      };
    }[];
    requirements: {
      kind: string;
      text: string;
      source: { sourceUrl: string; retrievedAt: string; entryVersion: number };
    }[];
    links: {
      label: string;
      url: string;
      source: { sourceUrl: string; retrievedAt: string; entryVersion: number };
    }[];
    explanation: { text: string; source: string };
    terms: { id: string; term: string; definition: string; source: { url: string } }[];
  }[];
  toResolve: { questionId: string; prompt: string; status: string; statusLabel: string }[];
}

async function bodyOf(response: Response): Promise<MatchResponseBody> {
  return (await response.json()) as MatchResponseBody;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/match — ranked match for the session (VAL-MATCH-001)", () => {
  it("returns byte-identical ranked match bodies across repeated calls", async () => {
    await seedAnswers();
    const first = await GET(matchRequest("GET"));
    const second = await GET(matchRequest("GET"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.text()).toBe(await second.clone().text());
  });

  it("ranks the food-focused sample first for a food goal with no income", async () => {
    await seedAnswers();
    const body = await bodyOf(await GET(matchRequest("GET")));
    expect(body.hasSession).toBe(true);
    expect(body.matches.length).toBe(KB_ENTRIES.length);
    expect(body.matches[0]!.entryId).toBe("pilot_program_sample_b");
    expect(body.matches[0]!.score).toBeGreaterThan(0);
    // Descending scores; ties broken by entry id.
    for (let index = 1; index < body.matches.length; index += 1) {
      const previous = body.matches[index - 1]!.score;
      const current = body.matches[index]!.score;
      expect(previous).toBeGreaterThanOrEqual(current);
      if (previous === current) {
        expect(body.matches[index - 1]!.entryId < body.matches[index]!.entryId).toBe(
          true,
        );
      }
    }
  });

  it("accepts POST the same as GET", async () => {
    await seedAnswers();
    const post = await POST(matchRequest("POST"));
    const get = await GET(matchRequest("GET"));
    expect(post.status).toBe(200);
    expect(await post.text()).toBe(await get.clone().text());
  });
});

describe("match cards (VAL-MATCH-002)", () => {
  it("carries an official source and retrieval date on every card item", async () => {
    await seedAnswers();
    const body = await bodyOf(await GET(matchRequest("GET")));
    for (const card of body.matches) {
      for (const item of [
        ...card.reasons.map((reason) => reason.source),
        ...card.requirements.map((requirement) => requirement.source),
        ...card.links.map((link) => link.source),
      ]) {
        expect(item.sourceUrl.startsWith("https://")).toBe(true);
        expect(item.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(item.entryVersion).toBeGreaterThanOrEqual(1);
      }
      expect(card.framing).toBe("This may be worth pursuing.");
      expect(card.requirements.length).toBeGreaterThan(0);
    }
  });

  it("presents only active entries (VAL-MATCH-004 at the route)", async () => {
    await seedAnswers();
    const body = await bodyOf(await GET(matchRequest("GET")));
    for (const card of body.matches) {
      for (const reason of card.reasons) {
        expect(reason.source.entryStatus).toBe("active");
      }
    }
  });
});

describe("to-resolve list (VAL-MATCH-005)", () => {
  it("names the session's unknown and unverified answers in plain language", async () => {
    await seedAnswers();
    const body = await bodyOf(await GET(matchRequest("GET")));
    const byId = new Map(body.toResolve.map((item) => [item.questionId, item]));
    expect(byId.get("id_status")?.status).toBe("unknown");
    expect(byId.get("id_status")?.prompt).toBe(QUESTION_BY_ID["id_status"]?.prompt);
    expect(byId.get("citizenship_status")?.status).toBe("unverified");
    expect(byId.get("citizenship_status")?.statusLabel).toBe(
      "Answered but not verified",
    );
    // Known answers never land in the to-resolve list.
    expect(byId.has("main_goal")).toBe(false);
    expect(byId.has("housing_status")).toBe(false);
  });
});

describe("banned claims and privacy at the route (VAL-MATCH-003)", () => {
  it("returns zero banned-claim matches on the response body", async () => {
    await seedAnswers();
    const body = await bodyOf(await GET(matchRequest("GET")));
    for (const card of body.matches) {
      const text = [
        card.framing,
        ...card.reasons.map((reason) => reason.text),
        ...card.requirements.map((requirement) => requirement.text),
        ...card.links.map((link) => link.label),
        card.explanation.text,
        ...card.terms.map((term) => `${term.term}: ${term.definition}`),
      ].join(" ");
      expect(findBannedClaims(text), card.entryId).toEqual([]);
    }
  });

  it("never returns a stored pii value in the body (full population)", async () => {
    // Seed EVERY pii:true question with a type-appropriate private value,
    // then prove the response body carries none of them — structurally, via
    // the pii reason-label omission, and literally, via absence of every
    // specific value. Generic one-word values ("yes") are skipped for the
    // literal check (the same specificity rule the redaction detector
    // uses); their structural omission is asserted instead.
    const piiValues: [string, unknown][] = [
      ["goal_detail", "sentinel-private-narrative-9182"],
      ["county", "sentinel-county-4711"],
      ["housing_status", "shelter"],
      ["id_issue_detail", "sentinel-id-detail-7734"],
      ["date_of_birth", "1980-02-03"],
      ["citizenship_status", "us_citizen"],
      ["disability_status", "yes"],
      ["mailing_situation", "po_box"],
      ["shelter_mail_consent", true],
      ["phone_contact", "555-010-9911"],
      ["email_contact", "sentinel.person@example.com"],
    ];
    for (const [questionId, value] of piiValues) {
      await saveAnswer(sessionId, questionId, "known", value, "user_supplied");
    }
    const response = await GET(matchRequest("GET"));
    const body = await response.text();
    for (const [questionId, value] of piiValues) {
      const stored = await loadAnswers(sessionId);
      expect(stored[questionId]?.status, questionId).toBe("known");
      if (typeof value !== "string") {
        continue;
      }
      // Specific values (sentinels, dates, phones, emails, distinct option
      // values) must be literally absent from the body.
      if (value.length >= 6 || /[\d@._\-/\s]/.test(value)) {
        expect(body, `${questionId} value "${value}"`).not.toContain(value);
      }
    }
    // Every pii question that reached a card reason must omit its label —
    // the structural guarantee behind the literal absence above.
    const parsed = (await GET(matchRequest("GET")).then((r) => r.json())) as MatchResponseBody;
    for (const card of parsed.matches) {
      for (const reason of card.reasons) {
        if (reason.questionId && PII_QUESTION_IDS_IN_SPEC.includes(reason.questionId)) {
          expect(reason.answerLabel, reason.questionId).toBeUndefined();
        }
      }
    }
  });

  it("answers a visitor with no session honestly and without creating one", async () => {
    const response = await GET(
      new Request("http://localhost:3100/api/match", { method: "GET" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as MatchResponseBody;
    expect(body.hasSession).toBe(false);
    expect(body.matches).toEqual([]);
    expect(body.toResolve).toEqual([]);
    // Read-only: no session was created for the anonymous visitor.
    const rows = await testDb`SELECT count(*) AS n FROM session`;
    const before = Number(rows[0].n);
    await GET(new Request("http://localhost:3100/api/match", { method: "GET" }));
    const after = await testDb`SELECT count(*) AS n FROM session`;
    expect(Number(after[0].n)).toBe(before);
  });

  it("does not trust an anonymous cookie value", async () => {
    const response = await GET(
      new Request("http://localhost:3100/api/match", {
        method: "GET",
        headers: { cookie: "bn_session=not-a-uuid" },
      }),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as MatchResponseBody).hasSession).toBe(false);
  });

  it("keeps the session cookie parsing aligned with the store", () => {
    expect(readSessionCookie(sessionCookieHeader(sessionId))).toBe(sessionId);
  });
});
