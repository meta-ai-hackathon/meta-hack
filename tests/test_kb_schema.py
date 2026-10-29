"""Knowledge-base schema checks (BN-04/HACK-29): VAL-KB-001..003.

The validation contract expects pytest evidence for the KB: entries are
versioned and source-linked (VAL-KB-001), stale/withdrawn handling is
encoded in the schema and demonstrably bites (VAL-KB-002), and the shipped
sample is pilot-agnostic (VAL-KB-003). Entries are validated mechanically
against kb/schema.json with the draft-07 validator from the pinned
`jsonschema` dev dependency.
"""

import copy
import json
import re
import unittest
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator

REPO_ROOT = Path(__file__).resolve().parents[1]
KB_DIR = REPO_ROOT / "kb"
SCHEMA_PATH = KB_DIR / "schema.json"
ENTRIES_DIR = KB_DIR / "entries"
SAMPLE_PATH = ENTRIES_DIR / "pilot-program-sample.json"
KB_CODE_PATH = REPO_ROOT / "src" / "lib" / "kb.ts"

FACT_GROUPS = ["rules", "required_documents", "official_links", "deadlines"]

# Every required field path in the raw entry shape: top level, source items,
# and each fact group. Deleting any one of them must fail schema validation.
REQUIRED_PATHS: list[list[object]] = [
    ["id"],
    ["title"],
    ["version"],
    ["status"],
    ["sources"],
    ["facts"],
    ["sources", 0, "id"],
    ["sources", 0, "title"],
    ["sources", 0, "url"],
    ["sources", 0, "retrieved_at"],
    ["sources", 0, "supports"],
]
for _group in FACT_GROUPS:
    REQUIRED_PATHS.append(["facts", _group, "items"])
    REQUIRED_PATHS.append(["facts", _group, "source_id"])
    REQUIRED_PATHS.append(["facts", _group, "retrieved_at"])

# Real benefit-program names must never appear on the KB surface while the
# pilot decision is open (VAL-KB-003). Scanned with word boundaries so a
# fragment inside an unrelated word does not trip the check.
PROGRAM_NAME_BLOCKLIST = [
    "SNAP",
    "CalFresh",
    "food stamps",
    "Section 8",
    "Medicaid",
    "Medicare",
    "SSI",
    "SSDI",
    "TANF",
    "WIC",
    "LIHEAP",
    "EBT",
    "ACA",
    "CHIP",
    "EITC",
]
PROGRAM_NAME_RE = re.compile(
    r"\b(" + "|".join(re.escape(name) for name in PROGRAM_NAME_BLOCKLIST) + r")\b",
    re.IGNORECASE,
)

ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def load_schema() -> dict:
    with open(SCHEMA_PATH, encoding="utf-8") as handle:
        schema = json.load(handle)
    Draft7Validator.check_schema(schema)
    return schema


def load_sample() -> dict:
    with open(SAMPLE_PATH, encoding="utf-8") as handle:
        return json.load(handle)


class KbSchemaTestCase(unittest.TestCase):
    schema: dict
    sample: dict
    validator: Draft7Validator

    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = load_schema()
        cls.sample = load_sample()
        cls.validator = Draft7Validator(cls.schema)

    def schema_errors(self, instance: object) -> list[str]:
        return [error.message for error in self.validator.iter_errors(instance)]

    def assertValid(self, instance: object, context: str) -> None:
        self.assertEqual(self.schema_errors(instance), [], context)

    def assertInvalid(self, instance: object, context: str) -> None:
        self.assertTrue(self.schema_errors(instance), f"expected failure: {context}")

    def variant(self, **changes: object) -> dict:
        entry = copy.deepcopy(self.sample)
        entry.update(changes)
        return entry

    def delete_path(self, entry: dict, path: list[Any]) -> None:
        node: Any = entry
        for key in path[:-1]:
            node = node[key]
        last = path[-1]
        if isinstance(node, list) and isinstance(last, int):
            node.pop(last)
        else:
            del node[last]


class TestSchemaAndSample(KbSchemaTestCase):
    def test_schema_is_valid_draft07(self):
        # check_schema in load_schema raises on an invalid schema; assert
        # explicitly so the property has a named home.
        self.assertTrue(hasattr(self.validator, "iter_errors"))

    def test_sample_entry_exists_and_validates(self):
        self.assertTrue(SAMPLE_PATH.is_file(), f"missing {SAMPLE_PATH}")
        self.assertValid(self.sample, "shipped sample entry")
        self.assertEqual(self.sample["status"], "active")
        self.assertIsInstance(self.sample["version"], int)
        self.assertGreaterEqual(self.sample["version"], 1)

    def test_sample_is_the_single_shipped_entry(self):
        shipped = sorted(path.name for path in ENTRIES_DIR.glob("*.json"))
        self.assertEqual(shipped, [SAMPLE_PATH.name])

    def test_version_sources_and_group_provenance_present(self):
        self.assertIn("version", self.sample)
        sources = self.sample["sources"]
        self.assertGreaterEqual(len(sources), 1)
        for source in sources:
            self.assertTrue(source["url"].startswith("https://"), source["id"])
            self.assertRegex(source["retrieved_at"], ISO_DATE_RE)
            self.assertTrue(source["supports"].strip(), source["id"])
        for group in FACT_GROUPS:
            facts = self.sample["facts"][group]
            self.assertGreaterEqual(len(facts["items"]), 1, group)
            self.assertTrue(facts["source_id"], group)
            self.assertRegex(facts["retrieved_at"], ISO_DATE_RE)

    def test_fact_group_source_ids_resolve(self):
        # Cross-reference the schema cannot express: every fact group's
        # source_id must name a source listed on the entry.
        source_ids = {source["id"] for source in self.sample["sources"]}
        for group in FACT_GROUPS:
            self.assertIn(self.sample["facts"][group]["source_id"], source_ids, group)


class TestStatusStates(KbSchemaTestCase):
    def test_active_state_validates(self):
        self.assertValid(self.sample, "active entry")

    def test_stale_state_validates_with_reason(self):
        stale = self.variant(status="stale", status_reason="source page changed since retrieval")
        self.assertValid(stale, "stale entry with reason")

    def test_withdrawn_state_validates_with_reason(self):
        withdrawn = self.variant(
            status="withdrawn", status_reason="program ended", superseded_by="replacement_entry"
        )
        self.assertValid(withdrawn, "withdrawn entry with reason")

    def test_stale_without_reason_fails(self):
        self.assertInvalid(self.variant(status="stale"), "stale without status_reason")

    def test_withdrawn_without_reason_fails(self):
        self.assertInvalid(self.variant(status="withdrawn"), "withdrawn without status_reason")

    def test_unknown_status_fails(self):
        self.assertInvalid(self.variant(status="maybe"), "status outside the vocabulary")

    def test_unknown_key_fails(self):
        entry = copy.deepcopy(self.sample)
        entry["bonus_field"] = "not in the schema"
        self.assertInvalid(entry, "entry with unknown key")

    def test_malformed_superseded_by_fails(self):
        entry = self.variant(
            status="withdrawn",
            status_reason="program ended",
            superseded_by="Not A Snake_Id!",
        )
        self.assertInvalid(entry, "withdrawn with malformed superseded_by")


class TestMissingFieldsFail(KbSchemaTestCase):
    def test_missing_version_fails(self):
        entry = copy.deepcopy(self.sample)
        del entry["version"]
        self.assertInvalid(entry, "entry without version")

    def test_missing_sources_fails(self):
        entry = copy.deepcopy(self.sample)
        del entry["sources"]
        self.assertInvalid(entry, "entry without sources")

    def test_empty_sources_fails(self):
        self.assertInvalid(self.variant(sources=[]), "entry with empty sources")

    def test_source_missing_url_fails(self):
        entry = copy.deepcopy(self.sample)
        del entry["sources"][0]["url"]
        self.assertInvalid(entry, "source without url")

    def test_source_missing_retrieval_date_fails(self):
        entry = copy.deepcopy(self.sample)
        del entry["sources"][0]["retrieved_at"]
        self.assertInvalid(entry, "source without retrieved_at")

    def test_group_missing_retrieved_at_fails(self):
        for group in FACT_GROUPS:
            entry = copy.deepcopy(self.sample)
            del entry["facts"][group]["retrieved_at"]
            self.assertInvalid(entry, f"{group} without retrieved_at")

    def test_group_missing_source_link_fails(self):
        for group in FACT_GROUPS:
            entry = copy.deepcopy(self.sample)
            del entry["facts"][group]["source_id"]
            self.assertInvalid(entry, f"{group} without source_id")

    def test_deleting_any_required_field_fails(self):
        for path in REQUIRED_PATHS:
            entry = copy.deepcopy(self.sample)
            self.delete_path(entry, path)
            self.assertInvalid(entry, f"deleting {path}")


class TestPilotAgnostic(KbSchemaTestCase):
    def kb_surface_files(self) -> list[Path]:
        files = [path for path in KB_DIR.rglob("*") if path.is_file()]
        if KB_CODE_PATH.is_file():
            files.append(KB_CODE_PATH)
        return files

    def test_sample_uses_pilot_placeholder(self):
        text = SAMPLE_PATH.read_text(encoding="utf-8")
        self.assertIn("{{PILOT_PROGRAM}}", text, "sample must stay a template")

    def test_no_real_program_names_on_the_kb_surface(self):
        # Grep-style repo check (VAL-KB-003): the KB data, schema, README, and
        # the consuming module must be free of program-specific content.
        for path in self.kb_surface_files():
            text = path.read_text(encoding="utf-8")
            match = PROGRAM_NAME_RE.search(text)
            if match is not None:
                self.fail(
                    f"{path.name} names a real program ({match.group(0)!r}); "
                    "the pilot decision is still OPEN"
                )


if __name__ == "__main__":
    unittest.main()
