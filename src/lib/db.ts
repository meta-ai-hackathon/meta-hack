import postgres from "postgres";

// Postgres access for the Benefits Navigator data model (BN-02). Reads
// DATABASE_URL (documented in .env.example; local dev runs the
// docker-compose Postgres on 5432). Plain SQL via the pinned `postgres`
// driver — no ORM.

const globalForDb = globalThis as unknown as {
  __benefitsNavigatorDb?: postgres.Sql;
};

export function getDb(): postgres.Sql {
  if (!globalForDb.__benefitsNavigatorDb) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is not set — copy .env.example to .env and set it (local dev: postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator)",
      );
    }
    globalForDb.__benefitsNavigatorDb = postgres(databaseUrl, {
      // Vercel Postgres sits behind PgBouncer, which does not support
      // prepared statements.
      prepare: false,
    });
  }
  return globalForDb.__benefitsNavigatorDb;
}

export async function closeDb(): Promise<void> {
  const client = globalForDb.__benefitsNavigatorDb;
  globalForDb.__benefitsNavigatorDb = undefined;
  await client?.end({ timeout: 5 });
}
