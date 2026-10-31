import { readFileSync } from "node:fs";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { closeDb, getDb } from "./db";
import { runMigrations } from "./migrate";
import { AppError, redactFields, setLogSink } from "./telemetry";
import {
  CROSSING_ALLOWLIST,
  readVaultFields,
  readVaultFieldsForFill,
  vaultCrossingDecision,
  vaultDelete,
  vaultFlowValues,
  vaultPut,
} from "./vault";
import { getFormRegistryEntry } from "./forms/registry";

const FILL_ENTRY = getFormRegistryEntry("sample-application-form");

// Integration suite for the BN-03/HACK-31 PII vault (VAL-PII-001..003). Runs
// against the real Docker Postgres on its own scratch database (independent
// of db.test.ts's scratch database so the files can run in parallel), dropped
// and re-created from scratch on every run.
//
// The vault contract under test:
// - vault_entry is structurally separate from answer/person.
// - vaultPut accepts ONLY pii:true spec fields; everything else is rejected.
// - readVaultFields is the boundary a prompt builder must consume: it serves
//   ONLY fields on the (empty) CROSSING_ALLOWLIST and rejects everything
//   else loudly with a taxonomy error.
// - The forms fill reads through readVaultFieldsForFill, whose permit is
//   derived from the committed form-registry entry — no caller-supplied
//   list can widen it.
// - No vault content (field id or value) ever reaches a log line.

const LOCAL_DATABASE_URL =
  "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator";
const TEST_DB_NAME = "benefits_navigator_vitest_vault";

function databaseFrom(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const adminUrl = databaseFrom(databaseUrl, "postgres");
const testUrl = databaseFrom(databaseUrl, TEST_DB_NAME);

const SPEC_PATH = new URL(
  "../../specs/question-spec/generic-questions.json",
  import.meta.url,
);
const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
  questions: { id: string; pii: boolean }[];
};
const SPEC_PII_FIELDS: readonly string[] = spec.questions
  .filter((question) => question.pii)
  .map((question) => question.id);
const SPEC_NON_PII_FIELDS: readonly string[] = spec.questions
  .filter((question) => !question.pii)
  .map((question) => question.id);
const SPEC_ALL_FIELDS: readonly string[] = spec.questions.map(
  (question) => question.id,
);

const CORE_TABLES = [
  "answer",
  "conversation_turn",
  "person",
  "schema_migrations",
  "session",
  "session_audit_note",
  "vault_entry",
] as const;

function sentinelFor(field: string): string {
  return `VAULT-SENTINEL-${field}-${field.length}`;
}

// The app-side ciphertext envelope (AES-256-GCM, see vault-crypto.ts):
// "enc1.<iv base64>.<tag base64>.<ciphertext base64>". A direct DB read of
// every vault row must match this — never the plaintext value.
const ENVELOPE_SHAPE = /^enc1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/;

let admin: postgres.Sql;
let testDb: postgres.Sql;

beforeAll(async () => {
  admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  testDb = postgres(testUrl, { max: 1 });
  // vault.ts resolves its own connection lazily through getDb(); point the
  // environment at the scratch database before any vault call.
  process.env.DATABASE_URL = testUrl;
  const applied = await runMigrations(testDb);
  expect(applied).toEqual([
    "0001_core.sql",
    "0002_vault_entry.sql",
    "0003_conversation_turn.sql",
  ]);
});

afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await Promise.all([admin.end({ timeout: 1 }), testDb.end({ timeout: 1 })]);
  await closeDb();
});

async function createSession(): Promise<string> {
  const [person] =
    await testDb`INSERT INTO person DEFAULT VALUES RETURNING id`;
  const [session] =
    await testDb`INSERT INTO session (person_id) VALUES (${person.id}) RETURNING id`;
  return String(session.id);
}

async function vaultRowCount(sessionId: string): Promise<number> {
  const rows = await testDb`
    SELECT count(*) AS n FROM vault_entry WHERE session_id = ${sessionId}
  `;
  return Number(rows[0].n);
}

/** Retrieve a promise's rejection value, failing the test if it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (caught) {
    return caught;
  }
  throw new Error("expected promise to reject");
}

describe("vault_entry is structurally separate (VAL-PII-001)", () => {
  it("is its own table alongside (not inside) the core tables", async () => {
    const rows = await testDb`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    expect(rows.map((row) => String(row.table_name))).toEqual(CORE_TABLES);
  });

  it("hangs off session only: one FK to session, nothing referencing the vault", async () => {
    const outbound = await testDb`
      SELECT confrelid::regclass::text AS ref FROM pg_constraint
      WHERE conrelid = 'vault_entry'::regclass AND contype = 'f'
    `;
    expect(outbound.map((row) => String(row.ref))).toEqual(["session"]);

    const inbound = await testDb`
      SELECT count(*) AS n FROM pg_constraint
      WHERE confrelid = 'vault_entry'::regclass AND contype = 'f'
    `;
    expect(Number(inbound[0].n)).toBe(0);
  });

  it("carries (session_id, field, value, created_at), one row per field per session", async () => {
    const columns = await testDb`
      SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'vault_entry'
      ORDER BY ordinal_position
    `;
    expect(columns.map((row) => String(row.column_name))).toEqual([
      "id",
      "session_id",
      "field",
      "value",
      "created_at",
    ]);
    for (const row of columns) {
      if (["session_id", "field", "value"].includes(String(row.column_name))) {
        expect(String(row.is_nullable)).toBe("NO");
      }
    }

    const unique = await testDb`
      SELECT count(*) AS n FROM pg_constraint
      WHERE conrelid = 'vault_entry'::regclass AND contype = 'u'
    `;
    expect(Number(unique[0].n)).toBeGreaterThan(0);
  });
});

describe("vaultPut write path", () => {
  it("stores every pii:true spec field as ciphertext, updating not duplicating (full population, VAL-VAULTENC-001)", async () => {
    const sessionId = await createSession();
    for (const field of SPEC_PII_FIELDS) {
      await vaultPut(sessionId, field, sentinelFor(field));
    }
    // Re-put every field: the UNIQUE (session_id, field) upsert contract
    // means an update, never a second row.
    const updated = new Map(
      SPEC_PII_FIELDS.map((field) => [field, `${sentinelFor(field)}-v2`]),
    );
    for (const [field, value] of updated) {
      await vaultPut(sessionId, field, value);
    }
    expect(await vaultRowCount(sessionId)).toBe(SPEC_PII_FIELDS.length);

    const rows = await testDb`
      SELECT field, value FROM vault_entry WHERE session_id = ${sessionId}
    `;
    const stored = new Map(
      rows.map((row) => [String(row.field), String(row.value)]),
    );
    expect([...stored.keys()].sort()).toEqual([...SPEC_PII_FIELDS].sort());

    // Ciphertext at rest: a DIRECT database read shows an AES-GCM envelope
    // for every row — never the plaintext value (VAL-VAULTENC-001).
    for (const [field, value] of updated) {
      const storedValue = stored.get(field) ?? "";
      expect(storedValue).not.toBe(value);
      expect(storedValue).not.toContain("VAULT-SENTINEL");
      expect(storedValue).toMatch(ENVELOPE_SHAPE);
    }

    // The key material never lands in the database either.
    const allValues = rows.map((row) => String(row.value)).join("\n");
    const vaultKey = process.env.VAULT_ENC_KEY ?? "";
    expect(vaultKey).not.toBe("");
    expect(allValues).not.toContain(vaultKey);

    // Round-trip: the sanctioned server-side read serves the updated values.
    const values = await vaultFlowValues(sessionId, SPEC_PII_FIELDS);
    for (const [field, value] of updated) {
      expect(values[field]).toBe(value);
    }
  });

  it("rejects every non-pii spec field and anything else — the vault is PII-only", async () => {
    const sessionId = await createSession();
    for (const field of [...SPEC_NON_PII_FIELDS, "made_up_field"]) {
      const rejection = vaultPut(sessionId, field, `not-actually-${field}`);
      await expect(rejection).rejects.toBeInstanceOf(AppError);
      await expect(rejection).rejects.toMatchObject({
        code: "validation_error",
      });
      // The surfaced copy stays generic: no field names, no values.
      const error = (await rejectionOf(rejection)) as AppError;
      expect(error.safeMessage).not.toContain(field);
    }
    expect(await vaultRowCount(sessionId)).toBe(0);
  });

  it("rejects empty and non-string values", async () => {
    const sessionId = await createSession();
    await expect(vaultPut(sessionId, "county", "")).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(vaultPut(sessionId, "county", "   ")).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(
      vaultPut(sessionId, "county", 42 as unknown as string),
    ).rejects.toBeInstanceOf(AppError);
    expect(await vaultRowCount(sessionId)).toBe(0);
  });
});

describe("encryption at rest (VAL-VAULTENC-001)", () => {
  it("round-trips arbitrary values through put and the sanctioned read (property)", async () => {
    const sessionId = await createSession();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SPEC_PII_FIELDS),
        fc.string({ minLength: 1 }).map((value) => (value.trim() === "" ? "v" : value)),
        async (field, value) => {
          await vaultPut(sessionId, field, value);
          const values = await vaultFlowValues(sessionId, [field]);
          const stored = await testDb`
            SELECT value FROM vault_entry
            WHERE session_id = ${sessionId} AND field = ${field}
          `;
          return (
            values[field] === value &&
            ENVELOPE_SHAPE.test(String(stored[0].value)) &&
            String(stored[0].value) !== value
          );
        },
      ),
      { numRuns: 25 },
    );
  });

  it("the fill's entry-derived read round-trips encrypted values (VAL-VAULTENC-002)", async () => {
    const sessionId = await createSession();
    await vaultPut(sessionId, "date_of_birth", "1990-01-01");
    await vaultPut(sessionId, "phone_contact", "555-0100");
    const values = await readVaultFieldsForFill(sessionId, FILL_ENTRY);
    expect(values.date_of_birth).toBe("1990-01-01");
    expect(values.phone_contact).toBe("555-0100");
  });
});

describe("fail-closed key handling (VAL-VAULTENC-002)", () => {
  /** Run fn with VAULT_ENC_KEY overridden (or unset), restoring it after. */
  async function withoutKey<T>(fn: () => Promise<T>): Promise<T> {
    const previous = process.env.VAULT_ENC_KEY;
    delete process.env.VAULT_ENC_KEY;
    try {
      return await fn();
    } finally {
      if (previous === undefined) {
        delete process.env.VAULT_ENC_KEY;
      } else {
        process.env.VAULT_ENC_KEY = previous;
      }
    }
  }

  it("a missing key rejects vaultPut with a taxonomy error and writes nothing", async () => {
    const sessionId = await createSession();
    await withoutKey(async () => {
      const rejection = vaultPut(sessionId, "county", "Franklin");
      await expect(rejection).rejects.toBeInstanceOf(AppError);
      await expect(rejection).rejects.toMatchObject({ code: "internal" });
    });
    expect(await vaultRowCount(sessionId)).toBe(0);
  });

  it("an invalid key rejects vaultPut the same way", async () => {
    const sessionId = await createSession();
    for (const bad of ["", "short", "g".repeat(64)]) {
      const previous = process.env.VAULT_ENC_KEY;
      process.env.VAULT_ENC_KEY = bad;
      try {
        const rejection = vaultPut(sessionId, "county", "Franklin");
        await expect(rejection).rejects.toBeInstanceOf(AppError);
        await expect(rejection).rejects.toMatchObject({ code: "internal" });
      } finally {
        if (previous === undefined) {
          delete process.env.VAULT_ENC_KEY;
        } else {
          process.env.VAULT_ENC_KEY = previous;
        }
      }
    }
    expect(await vaultRowCount(sessionId)).toBe(0);
  });

  it("a missing key on a read path throws — it never serves stored plaintext", async () => {
    const sessionId = await createSession();
    await vaultPut(sessionId, "county", "Franklin");
    await withoutKey(async () => {
      const rejection = vaultFlowValues(sessionId, ["county"]);
      await expect(rejection).rejects.toBeInstanceOf(AppError);
      await expect(rejection).rejects.toMatchObject({ code: "internal" });
    });
  });

  it("a missing key on a LEGACY plaintext row fails closed — never a plaintext fallback", async () => {
    const sessionId = await createSession();
    // Simulate a pre-encryption row written straight into the table.
    await testDb`
      INSERT INTO vault_entry (session_id, field, value)
      VALUES (${sessionId}, 'county', 'Franklin')
    `;
    await withoutKey(async () => {
      const rejection = vaultFlowValues(sessionId, ["county"]);
      await expect(rejection).rejects.toBeInstanceOf(AppError);
      await expect(rejection).rejects.toMatchObject({ code: "internal" });
    });
  });
});

describe("legacy plaintext rows (encrypted on read)", () => {
  it("a legacy plaintext row is served through the app and re-encrypted in place", async () => {
    const sessionId = await createSession();
    await testDb`
      INSERT INTO vault_entry (session_id, field, value)
      VALUES (${sessionId}, 'county', 'Franklin')
    `;
    // The app read serves the original value…
    const values = await vaultFlowValues(sessionId, ["county"]);
    expect(values.county).toBe("Franklin");
    // …and leaves no plaintext residue behind.
    const rows = await testDb`
      SELECT value FROM vault_entry
      WHERE session_id = ${sessionId} AND field = 'county'
    `;
    expect(String(rows[0].value)).toMatch(ENVELOPE_SHAPE);
    // A second read — now from ciphertext — still returns the value.
    const again = await vaultFlowValues(sessionId, ["county"]);
    expect(again.county).toBe("Franklin");
  });

  it("a corrupted envelope fails closed instead of returning anything", async () => {
    const sessionId = await createSession();
    // Well-formed envelope shape, bogus GCM tag: authentication must fail
    // loudly rather than degrade to anything resembling the stored value.
    const bogus = `enc1.${Buffer.alloc(12).toString("base64")}.${Buffer.alloc(16).toString("base64")}.${Buffer.from("tampered").toString("base64")}`;
    await testDb`
      INSERT INTO vault_entry (session_id, field, value)
      VALUES (${sessionId}, 'phone_contact', ${bogus})
    `;
    const request = vaultFlowValues(sessionId, ["phone_contact"]);
    await expect(request).rejects.toBeInstanceOf(AppError);
    await expect(request).rejects.toMatchObject({ code: "internal" });
  });
});

describe("vaultDelete disavow path (BN-13)", () => {
  it("removes a stored value and is idempotent on absent rows", async () => {
    const sessionId = await createSession();
    await vaultPut(sessionId, "county", "Franklin");
    expect(await vaultRowCount(sessionId)).toBe(1);
    await vaultDelete(sessionId, "county");
    expect(await vaultRowCount(sessionId)).toBe(0);
    // Deleting an absent row deletes nothing and throws nothing.
    await vaultDelete(sessionId, "county");
    expect(await vaultRowCount(sessionId)).toBe(0);
  });

  it("removes only the named field of the named session", async () => {
    const sessionId = await createSession();
    const otherSession = await createSession();
    await vaultPut(sessionId, "county", "Franklin");
    await vaultPut(sessionId, "phone_contact", "555-0100");
    await vaultPut(otherSession, "county", "Elsewhere");
    await vaultDelete(sessionId, "county");
    const rows = await testDb`
      SELECT session_id, field FROM vault_entry
      WHERE session_id IN (${sessionId}, ${otherSession})
    `;
    const remaining = rows.map(
      (row) => `${String(row.session_id) === otherSession ? "other" : "same"}:${String(row.field)}`,
    );
    expect(remaining.sort()).toEqual(["other:county", "same:phone_contact"]);
  });

  it("rejects every non-pii field and anything else — same allowlist as vaultPut", async () => {
    const sessionId = await createSession();
    for (const field of [...SPEC_NON_PII_FIELDS, "made_up_field"]) {
      const rejection = vaultDelete(sessionId, field);
      await expect(rejection).rejects.toBeInstanceOf(AppError);
      await expect(rejection).rejects.toMatchObject({
        code: "validation_error",
      });
      const error = (await rejectionOf(rejection)) as AppError;
      expect(error.safeMessage).not.toContain(field);
    }
  });
});

describe("boundary readVaultFields (VAL-PII-002)", () => {
  it("rejects every pii:true spec field — none is allowlisted", async () => {
    const sessionId = await createSession();
    for (const field of SPEC_PII_FIELDS) {
      await vaultPut(sessionId, field, sentinelFor(field));
      const request = readVaultFields(sessionId, [field]);
      await expect(request).rejects.toBeInstanceOf(AppError);
      await expect(request).rejects.toMatchObject({
        code: "validation_error",
      });
    }
  });

  it("vaultFlowValues serves stored pii values for the server-side flow engine", async () => {
    const sessionId = await createSession();
    await vaultPut(sessionId, "housing_status", "shelter");
    await vaultPut(sessionId, "county", "Franklin");
    const values = await vaultFlowValues(sessionId, [
      "housing_status",
      "county",
      "date_of_birth",
    ]);
    expect(values.housing_status).toBe("shelter");
    expect(values.county).toBe("Franklin");
    expect(values.date_of_birth).toBeUndefined();
  });

  it("vaultFlowValues rejects non-vault fields loudly", async () => {
    const sessionId = await createSession();
    const request = vaultFlowValues(sessionId, ["application_role"]);
    await expect(request).rejects.toBeInstanceOf(AppError);
    await expect(request).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects a mixed request loudly, naming rejected fields only in cause", async () => {
    const sessionId = await createSession();
    const request = readVaultFields(sessionId, [
      ...SPEC_PII_FIELDS,
      "made_up_field",
    ]);
    const error = (await rejectionOf(request)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("validation_error");
    expect(error.safeMessage).not.toContain("made_up_field");
    expect(error.safeMessage).not.toContain("date_of_birth");
    const cause = error.cause as { rejectedFields?: string[] };
    expect(cause.rejectedFields).toHaveLength(SPEC_PII_FIELDS.length + 1);
  });

  it("decides purely: allowed ⊆ CROSSING_ALLOWLIST, everything else rejected", () => {
    const cases: readonly string[][] = [
      [],
      [...SPEC_PII_FIELDS],
      ["made_up_field", ...SPEC_PII_FIELDS.slice(0, 3)],
      ["a", "a", ""],
    ];
    for (const requested of cases) {
      const { allowed, rejected } = vaultCrossingDecision(requested);
      for (const field of allowed) {
        expect(CROSSING_ALLOWLIST).toContain(field);
      }
      for (const field of rejected) {
        expect(CROSSING_ALLOWLIST.includes(field)).toBe(false);
      }
      expect([...allowed, ...rejected].sort()).toEqual(
        [...requested].sort(),
      );
    }
  });

  it("serves an empty result for an empty request (fail-closed today)", async () => {
    const sessionId = await createSession();
    await expect(readVaultFields(sessionId, [])).resolves.toEqual({});
  });
});

describe("the fill's entry-derived permit (Mission v2 M4, VAL-PDF-006)", () => {
  // The forms pipeline is the SECOND sanctioned vault accessor: a form fill
  // reads pii values ONLY through readVaultFieldsForFill, whose permit is
  // derived HERE from the committed form-registry entry — a caller cannot
  // hand it an arbitrary field list. The global CROSSING_ALLOWLIST stays
  // empty; the per-form allowlist is per-entry and committed for review.

  it("serves exactly the fields on the entry's allowlist", async () => {
    const sessionId = await createSession();
    await vaultPut(sessionId, "date_of_birth", "1990-01-01");
    await vaultPut(sessionId, "phone_contact", "555-0100");
    const values = await readVaultFieldsForFill(sessionId, FILL_ENTRY);
    expect(values.date_of_birth).toBe("1990-01-01");
    expect(values.phone_contact).toBe("555-0100");
  });

  it("a mapped pii question missing from the entry's allowlist fails closed", async () => {
    const sessionId = await createSession();
    await vaultPut(sessionId, "phone_contact", "555-0100");
    // The narrowed entry's allowlist drops phone_contact: the value stays
    // in the vault and the fill sees nothing (fail-closed, not an error —
    // the field degrades to to-resolve).
    const narrowEntry = {
      ...FILL_ENTRY,
      vaultFieldAllowlist: FILL_ENTRY.vaultFieldAllowlist.filter(
        (field) => field !== "phone_contact",
      ),
    };
    const values = await readVaultFieldsForFill(sessionId, narrowEntry);
    expect(values.phone_contact).toBeUndefined();
  });

  it("an entry allowlist naming a non-vault field is rejected loudly", async () => {
    const sessionId = await createSession();
    // A registry entry can never widen its permit to a field the vault
    // does not hold — even one that sounds like pii.
    const badEntry = {
      ...FILL_ENTRY,
      vaultFieldAllowlist: [...FILL_ENTRY.vaultFieldAllowlist, "application_role"],
    };
    const request = readVaultFieldsForFill(sessionId, badEntry);
    const error = (await rejectionOf(request)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("validation_error");
    expect(error.safeMessage).not.toContain("application_role");
    const cause = error.cause as { rejectedFields?: string[] };
    expect(cause.rejectedFields).toEqual(["application_role"]);
  });

  it("the prompt-facing read path has no permit parameter and stays fail-closed", async () => {
    const sessionId = await createSession();
    await vaultPut(sessionId, "date_of_birth", "1990-01-01");
    // CROSSING_ALLOWLIST is empty: even a valid vault field cannot cross
    // into model context through the prompt-facing path.
    const request = readVaultFields(sessionId, ["date_of_birth"]);
    const error = (await rejectionOf(request)) as AppError;
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("validation_error");
  });

  it("decides purely with an explicit permit: allowed ⊆ CROSSING ∪ explicit", () => {
    const { allowed, rejected } = vaultCrossingDecision(
      ["date_of_birth", "phone_contact", "made_up_field"],
      ["date_of_birth"],
    );
    expect(allowed).toEqual(["date_of_birth"]);
    expect(rejected).toEqual(["phone_contact", "made_up_field"]);
  });
});

describe("end-to-end prompt payload (VAL-PII-003)", () => {
  it("payload for a fully-populated vault contains zero pii:true values", async () => {
    const sessionId = await createSession();

    // Populate the vault with a PII value for EVERY pii:true question in
    // the spec (full population, not a sample).
    for (const field of SPEC_PII_FIELDS) {
      await vaultPut(sessionId, field, sentinelFor(field));
    }
    const stored = await testDb`
      SELECT count(*) AS n FROM vault_entry WHERE session_id = ${sessionId}
    `;
    expect(Number(stored[0].n)).toBe(SPEC_PII_FIELDS.length);

    // Ordinary non-PII answers live in the answer table.
    const nonPii = SPEC_NON_PII_FIELDS.slice(0, 2);
    await testDb`
      INSERT INTO answer (session_id, question_id, value, status, provenance)
      VALUES
        (${sessionId}, ${nonPii[0]}, ${testDb.json({ answer: "alpha" })}, 'known', 'user_supplied'),
        (${sessionId}, ${nonPii[1]}, ${testDb.json({ answer: "bravo" })}, 'known', 'user_supplied')
    `;

    // Simulated future prompt builder: ordinary answers come from the
    // answer table; anything from the vault MUST go through the boundary,
    // which only serves explicitly allowlisted fields.
    const buildModelPayload = async (id: string): Promise<unknown> => {
      const sql = getDb();
      const answers = await sql`
        SELECT question_id, value FROM answer
        WHERE session_id = ${id}
        ORDER BY question_id
      `;
      const vault = await readVaultFields(id, [...CROSSING_ALLOWLIST]);
      return { answers, vault };
    };

    const payloadJson = JSON.stringify(await buildModelPayload(sessionId));

    // Full-population assertion: none of the vaulted values can appear…
    for (const field of SPEC_PII_FIELDS) {
      expect(payloadJson).not.toContain(sentinelFor(field));
    }
    // …and no sentinel leaked in any other form.
    expect(payloadJson).not.toContain("VAULT-SENTINEL");
    // The payload is not vacuously empty: non-PII answers flow through.
    expect(payloadJson).toContain(nonPii[0]);
    expect(payloadJson).toContain(nonPii[1]);

    // The greedy variant — a builder asking for EVERY spec field — gets
    // nothing at all: the boundary throws before any row is served.
    const greedy = readVaultFields(sessionId, SPEC_ALL_FIELDS);
    await expect(greedy).rejects.toBeInstanceOf(AppError);
  });
});

describe("vault contents never reach logs", () => {
  it("no log line carries any vault field id or value across put/read/reject", async () => {
    const sessionId = await createSession();
    const lines: string[] = [];
    setLogSink((line) => {
      lines.push(line);
    });
    try {
      for (const field of SPEC_PII_FIELDS) {
        await vaultPut(sessionId, field, sentinelFor(field));
      }
      await readVaultFields(sessionId, [...CROSSING_ALLOWLIST]);
      await readVaultFields(sessionId, [...SPEC_PII_FIELDS]).catch(
        () => {},
      );
    } finally {
      // Restore the module's default sink (console.log), matching the
      // default defined in telemetry.ts.
      setLogSink((line) => console.log(line));
    }
    expect(lines.length).toBeGreaterThan(0);
    const joined = lines.join("\n");
    const vaultKey = process.env.VAULT_ENC_KEY ?? "";
    for (const field of SPEC_PII_FIELDS) {
      expect(joined).not.toContain(sentinelFor(field));
      expect(joined).not.toContain(field);
    }
    // No key material either (VAL-VAULTENC-002).
    expect(vaultKey).not.toBe("");
    expect(joined).not.toContain(vaultKey);
  });

  it("redactFields strips records keyed by vault field names", () => {
    const record = {
      date_of_birth: sentinelFor("date_of_birth"),
      nested: { phone_contact: sentinelFor("phone_contact") },
      benign: "application_role",
    };
    const redacted = redactFields(record);
    expect(redacted).not.toHaveProperty("date_of_birth");
    expect(redacted.nested).not.toHaveProperty("phone_contact");
    expect(redacted.benign).toBe("application_role");
  });
});
