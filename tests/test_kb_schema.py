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


class TestOptionalGroups(KbSchemaTestCase):
    """Mission v2 M3: optional `steps` and `match_signals` fact groups.

    Both carry the same per-group provenance as the required groups. A
    match signal names a question in the generic spec (a cross-reference
    the JSON Schema cannot express) and carries the program-side reason a
    match card can show.
    """

    def entry_with_group(self, group: str, value: object) -> dict:
        entry = copy.deepcopy(self.sample)
        entry["facts"][group] = value
        return entry

    def signal_group(self) -> dict:
        return {
            "items": [
                {
                    "question_id": "housing_status",
                    "values": ["shelter", "car"],
                    "weight": 3,
                    "reason": "The program's rules give priority to people without stable housing.",
                }
            ],
            "source_id": "official_rules_source",
            "retrieved_at": "2026-10-29",
        }

    def steps_group(self) -> dict:
        return {
            "items": ["Gather the required documents.", "Start the application."],
            "source_id": "official_rules_source",
            "retrieved_at": "2026-10-29",
        }

    def test_optional_groups_validate_with_provenance(self):
        for group, value in [("steps", self.steps_group()), ("match_signals", self.signal_group())]:
            self.assertValid(self.entry_with_group(group, value), f"entry with {group}")

    def test_optional_groups_stay_optional(self):
        self.assertValid(self.sample, "entry without the optional groups")

    def test_signal_missing_reason_fails(self):
        entry = self.entry_with_group("match_signals", self.signal_group())
        del entry["facts"]["match_signals"]["items"][0]["reason"]
        self.assertInvalid(entry, "signal without reason")

    def test_signal_unknown_key_fails(self):
        entry = self.entry_with_group("match_signals", self.signal_group())
        entry["facts"]["match_signals"]["items"][0]["bonus"] = "nope"
        self.assertInvalid(entry, "signal with unknown key")

    def test_signal_malformed_question_id_fails(self):
        entry = self.entry_with_group("match_signals", self.signal_group())
        entry["facts"]["match_signals"]["items"][0]["question_id"] = "Not A Question!"
        self.assertInvalid(entry, "signal with malformed question_id")

    def test_signal_out_of_range_weight_fails(self):
        for weight in [0, 10, 1.5]:
            entry = self.entry_with_group("match_signals", self.signal_group())
            entry["facts"]["match_signals"]["items"][0]["weight"] = weight
            self.assertInvalid(entry, f"signal with weight {weight}")

    def test_signal_empty_values_fails(self):
        entry = self.entry_with_group("match_signals", self.signal_group())
        entry["facts"]["match_signals"]["items"][0]["values"] = []
        self.assertInvalid(entry, "signal with empty values")

    def test_optional_group_source_ids_resolve(self):
        # The schema cannot cross-reference source_id -> sources (the same
        # limitation the required groups have, checked in the consuming
        # module). Here: every shipped entry's optional groups resolve.
        for path in sorted(ENTRIES_DIR.glob("*.json")):
            entry = json.loads(path.read_text(encoding="utf-8"))
            source_ids = {source["id"] for source in entry["sources"]}
            for group in ["steps", "match_signals"]:
                if group in entry["facts"]:
                    self.assertIn(
                        entry["facts"][group]["source_id"],
                        source_ids,
                        f"{path.name} facts.{group}",
                    )

    def test_signal_question_ids_resolve_in_the_spec(self):
        # Cross-reference the schema cannot express: every shipped entry's
        # match signal must name a question the generic spec actually asks,
        # so scoring never ranks against a question that cannot be answered.
        spec_path = REPO_ROOT / "specs" / "question-spec" / "generic-questions.json"
        spec_ids = {q["id"] for q in json.loads(spec_path.read_text(encoding="utf-8"))["questions"]}
        for path in sorted(ENTRIES_DIR.glob("*.json")):
            entry = json.loads(path.read_text(encoding="utf-8"))
            signals = entry["facts"].get("match_signals")
            if not signals:
                continue
            for item in signals["items"]:
                self.assertIn(
                    item["question_id"],
                    spec_ids,
                    f"{path.name} signal targets a question the spec does not ask",
                )


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
