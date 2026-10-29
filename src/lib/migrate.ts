import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres from "postgres";

// Small plain-SQL migration runner (BN-02 / HACK-27). Migration files live in
// migrations/ at the repo root, are numbered and append-only, and are applied
// once each; applied files are tracked in schema_migrations. No ORM.

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

export function defaultMigrationsDir(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../migrations",
  );
}

export async function runMigrations(
  sql: postgres.Sql,
  migrationsDir: string = defaultMigrationsDir(),
): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

  const files = (await readdir(migrationsDir))
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();

  const alreadyApplied = new Set(
    (await sql`SELECT filename FROM schema_migrations`).map((row) =>
      String(row.filename),
    ),
  );

  const applied: string[] = [];
  for (const filename of files) {
    if (alreadyApplied.has(filename)) {
      continue;
    }
    const statements = await readFile(
      path.join(migrationsDir, filename),
      "utf8",
    );
    await sql.begin(async (tx) => {
      await tx.unsafe(statements);
      await tx`INSERT INTO schema_migrations (filename) VALUES (${filename})`;
    });
    applied.push(filename);
  }
  return applied;
}

// CLI entry: `pnpm db:migrate` applies pending migrations to DATABASE_URL.
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "migrate: DATABASE_URL is not set (copy .env.example to .env)",
    );
    process.exitCode = 1;
    return;
  }
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const applied = await runMigrations(sql);
    console.log(
      applied.length > 0
        ? `migrate: applied ${applied.join(", ")}`
        : "migrate: up to date",
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  await main();
}
