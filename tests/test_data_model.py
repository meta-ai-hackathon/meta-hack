"""SQL-level data model checks (BN-02/HACK-27) against a live Postgres.

Complements the Vitest integration suite in src/lib/db.test.ts: the
validation contract (VAL-DM-001..004) expects pytest evidence for the
migration/constraint behavior. Checks run via psql (GitHub runners ship one)
or, as a fallback, `docker exec` against the local dev container; the whole
suite skips when neither can reach Postgres so CI without the service stays
green.
"""

import json
import os
import shutil
import subprocess
import unittest
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = REPO_ROOT / "migrations"
LOCAL_DSN = "postgresql://postgres:benefits_dev@localhost:5432/benefits_navigator"
TEST_DB = "benefits_navigator_pytest_tmp"
TIMEOUT = 30

CORE_TABLES = [
    "answer",
    "conversation_turn",
    "person",
    "schema_migrations",
    "session",
    "session_audit_note",
    "vault_entry",
]
SESSION_STATUSES = [
    "draft",
    "prepared",
    "handed_off",
    "user_reported_submitted",
    "user_reported_decided",
]


def _database_url(db_name: str) -> str:
    raw = os.environ.get("DATABASE_URL", LOCAL_DSN)
    parts = urllib.parse.urlsplit(raw)
    return urllib.parse.urlunsplit(parts._replace(path=f"/{db_name}"))


def _resolve_mode() -> str | None:
    if shutil.which("psql"):
        return "binary"
    if shutil.which("docker"):
        probe = subprocess.run(
            ["docker", "inspect", "benefits-navigator-pg"],
            capture_output=True,
            timeout=10,
        )
        if probe.returncode == 0:
            return "docker"
    return None


def _psql_base(db_name: str) -> list[str]:
    if _resolve_mode() == "binary":
        return [
            "psql",
            "--no-psqlrc",
            "--dbname",
            _database_url(db_name),
            "--set",
            "ON_ERROR_STOP=1",
            "--set",
            "VERBOSITY=verbose",
            "--tuples-only",
            "--no-align",
        ]
    return [
        "docker",
        "exec",
        "-i",
        "benefits-navigator-pg",
        "psql",
        "--username",
        "postgres",
        "--dbname",
        db_name,
        "--set",
        "ON_ERROR_STOP=1",
        "--set",
        "VERBOSITY=verbose",
        "--tuples-only",
        "--no-align",
    ]


def run_sql(db_name: str, sql_text: str, expect_success: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        _psql_base(db_name) + ["--command", sql_text],
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )
    if expect_success and proc.returncode != 0:
        raise AssertionError(f"psql failed ({proc.returncode}): {proc.stderr}")
    return proc


def run_rows(db_name: str, sql_text: str) -> list[dict[str, object]]:
    # CTE wrapper accepts both SELECT and INSERT/UPDATE ... RETURNING.
    wrapped = f"WITH q AS ({sql_text}) SELECT coalesce(json_agg(q), '[]'::json) FROM q;"
    proc = run_sql(db_name, wrapped)
    payload = json.loads(proc.stdout.strip())
    assert isinstance(payload, list)
    return payload


def run_file(db_name: str, path: Path) -> None:
    proc = subprocess.run(
        _psql_base(db_name) + ["--file", "-"],
        input=path.read_text(encoding="utf-8"),
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
    )
    if proc.returncode != 0:
        raise AssertionError(f"psql failed on {path.name} ({proc.returncode}): {proc.stderr}")


class DataModelSqlTests(unittest.TestCase):
    """VAL-DM-001..004 at the SQL level on a scratch database."""

    @classmethod
    def setUpClass(cls) -> None:
        if _resolve_mode() is None:
            raise unittest.SkipTest(
                "no psql client and no benefits-navigator-pg container; skipping Postgres checks"
            )
        try:
            run_sql("postgres", "SELECT 1")
        except (AssertionError, subprocess.TimeoutExpired, OSError) as error:
            raise unittest.SkipTest(f"Postgres not reachable; skipping ({error})") from error
        run_sql("postgres", f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)", expect_success=False)
        run_sql("postgres", f"CREATE DATABASE {TEST_DB}")
        for migration in sorted(MIGRATIONS_DIR.glob("*.sql")):
            run_file(TEST_DB, migration)

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            run_sql("postgres", f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
        except (AssertionError, subprocess.TimeoutExpired, OSError):
            pass

    def test_001_migrations_create_core_tables(self) -> None:
        rows = run_rows(
            TEST_DB,
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' ORDER BY table_name",
        )
        self.assertEqual(sorted(str(r["table_name"]) for r in rows), CORE_TABLES)

    def test_002_session_status_uses_bn25_vocabulary_only(self) -> None:
        person = run_rows(TEST_DB, "INSERT INTO person DEFAULT VALUES RETURNING id")[0]
        for status in SESSION_STATUSES:
            rows = run_rows(
                TEST_DB,
                f"INSERT INTO session (person_id, status) VALUES ('{person['id']}', '{status}') RETURNING status",
            )
            self.assertEqual(rows[0]["status"], status)
        for status in ["submitted", "in_progress", "complete"]:
            proc = run_sql(
                TEST_DB,
                f"INSERT INTO session (person_id, status) VALUES ('{person['id']}', '{status}')",
                expect_success=False,
            )
            self.assertNotEqual(proc.returncode, 0, f"status {status!r} must be rejected")
            self.assertIn("23514", proc.stderr)

    def test_004_answer_roundtrip_and_update_not_duplicate(self) -> None:
        person = run_rows(TEST_DB, "INSERT INTO person DEFAULT VALUES RETURNING id")[0]
        session = run_rows(
            TEST_DB, f"INSERT INTO session (person_id) VALUES ('{person['id']}') RETURNING id"
        )[0]
        for status in ["known", "unknown", "unverified"]:
            for provenance in [
                "user_supplied",
                "ai_drafted",
                "source_verified",
                "tax_return",
                "user",
            ]:
                value = "null" if status == "unknown" else json.dumps({"answer": f"{status}/{provenance}"})
                run_sql(
                    TEST_DB,
                    f"INSERT INTO answer (session_id, question_id, value, status, provenance) "
                    f"VALUES ('{session['id']}', 'q_test_roundtrip', '{value}'::jsonb, '{status}', '{provenance}') "
                    f"ON CONFLICT (session_id, question_id) DO UPDATE SET value = EXCLUDED.value, "
                    f"status = EXCLUDED.status, provenance = EXCLUDED.provenance",
                )
                rows = run_rows(
                    TEST_DB,
                    f"SELECT status, provenance, value FROM answer "
                    f"WHERE session_id = '{session['id']}' AND question_id = 'q_test_roundtrip'",
                )
                self.assertEqual(
                    (rows[0]["status"], rows[0]["provenance"]),
                    (status, provenance),
                )
                expected = None if status == "unknown" else {"answer": f"{status}/{provenance}"}
                self.assertEqual(rows[0]["value"], expected)

    def test_003_caseworker_assisted_session_records_audit_note(self) -> None:
        person = run_rows(TEST_DB, "INSERT INTO person DEFAULT VALUES RETURNING id")[0]
        session = run_rows(
            TEST_DB,
            f"INSERT INTO session (person_id, caseworker_assisted) "
            f"VALUES ('{person['id']}', true) RETURNING id, caseworker_assisted",
        )[0]
        self.assertIs(session["caseworker_assisted"], True)
        run_sql(
            TEST_DB,
            f"INSERT INTO session_audit_note (session_id, actor_role, note) "
            f"VALUES ('{session['id']}', 'caseworker', 'Reviewed housing questions together')",
        )
        notes = run_rows(
            TEST_DB,
            f"SELECT actor_role, note, created_at FROM session_audit_note "
            f"WHERE session_id = '{session['id']}'",
        )
        self.assertEqual(len(notes), 1)
        self.assertEqual(notes[0]["actor_role"], "caseworker")
        self.assertEqual(notes[0]["note"], "Reviewed housing questions together")
        self.assertIsNotNone(notes[0]["created_at"])

    def test_005_answer_status_rejects_outside_tri_state(self) -> None:
        person = run_rows(TEST_DB, "INSERT INTO person DEFAULT VALUES RETURNING id")[0]
        session = run_rows(
            TEST_DB, f"INSERT INTO session (person_id) VALUES ('{person['id']}') RETURNING id"
        )[0]
        for status in ["maybe", "sure", "true"]:
            proc = run_sql(
                TEST_DB,
                f"INSERT INTO answer (session_id, question_id, status, provenance) "
                f"VALUES ('{session['id']}', 'q_test_bad', '{status}', 'user_supplied')",
                expect_success=False,
            )
            self.assertNotEqual(proc.returncode, 0, f"status {status!r} must be rejected")
            self.assertIn("23514", proc.stderr)

    def test_006_vault_entry_is_structurally_separate(self) -> None:
        """BN-03/HACK-31: the PII vault hangs off session only, one row per field."""
        person = run_rows(TEST_DB, "INSERT INTO person DEFAULT VALUES RETURNING id")[0]
        session = run_rows(
            TEST_DB, f"INSERT INTO session (person_id) VALUES ('{person['id']}') RETURNING id"
        )[0]
        # FK graph: vault_entry references session; nothing references the vault.
        outbound = run_rows(
            TEST_DB,
            "SELECT confrelid::regclass::text AS ref FROM pg_constraint "
            "WHERE conrelid = 'vault_entry'::regclass AND contype = 'f'",
        )
        self.assertEqual([str(row["ref"]) for row in outbound], ["session"])
        inbound = run_rows(
            TEST_DB,
            "SELECT count(*) AS n FROM pg_constraint "
            "WHERE confrelid = 'vault_entry'::regclass AND contype = 'f'",
        )
        self.assertEqual(str(inbound[0]["n"]), "0")
        # One row per (session, field): re-put is an update, not a duplicate.
        run_sql(
            TEST_DB,
            f"INSERT INTO vault_entry (session_id, field, value) "
            f"VALUES ('{session['id']}', 'date_of_birth', '1968-04-19')",
        )
        run_sql(
            TEST_DB,
            f"INSERT INTO vault_entry (session_id, field, value) "
            f"VALUES ('{session['id']}', 'date_of_birth', '1968-04-20') "
            f"ON CONFLICT (session_id, field) DO UPDATE SET value = EXCLUDED.value",
        )
        rows = run_rows(
            TEST_DB,
            f"SELECT field, value FROM vault_entry WHERE session_id = '{session['id']}'",
        )
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["field"], "date_of_birth")
        self.assertEqual(rows[0]["value"], "1968-04-20")
        # person/answer carry no vault columns; the vault is not an answer column.
        vaultish = run_rows(
            TEST_DB,
            "SELECT count(*) AS n FROM information_schema.columns "
            "WHERE table_name IN ('person', 'answer') AND column_name LIKE '%vault%'",
        )
        self.assertEqual(str(vaultish[0]["n"]), "0")


if __name__ == "__main__":
    unittest.main()
