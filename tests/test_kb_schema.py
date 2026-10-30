"""Knowledge-base schema checks (BN-04/HACK-29): VAL-KB-001..003.

The validation contract expects pytest evidence for the KB: entries are
versioned and source-linked (VAL-KB-001), stale/withdrawn handling is
encoded in the schema and demonstrably bites (VAL-KB-002), and the shipped
sample is pilot-agnostic (VAL-KB-003). Entries are validated mechanically
against kb/schema.json with the draft-07 validator from the pinned
`jsonschema` dev dependency.
"""

import copy
import datetime
import json
import re
import tempfile
import unittest
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from jsonschema import Draft7Validator

REPO_ROOT = Path(__file__).resolve().parents[1]
KB_DIR = REPO_ROOT / "kb"
SCHEMA_PATH = KB_DIR / "schema.json"
ENTRIES_DIR = KB_DIR / "entries"
SAMPLE_PATH = ENTRIES_DIR / "pilot-program-sample.json"
KB_CODE_PATH = REPO_ROOT / "src" / "lib" / "kb.ts"
# Entries for the decided pilot (HACK-50 / BN-22). Real facts with official
# sources live here, apart from the pilot-agnostic samples in ENTRIES_DIR,
# and TestPilotEntries holds them to their own rules.
PILOT_DIR = KB_DIR / "pilot"

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

# The decided pilot is NC Medicaid (Mecklenburg County). Its entries may name
# exactly this program; every other blocklisted name stays banned there too.
PILOT_PROGRAM_NAMES = {"medicaid"}

# Official sources for the pilot entries: North Carolina government hosts,
# https only. A host matches when it equals one of these or ends with
# "." + one of them.
PILOT_SOURCE_DOMAINS = ("ncdhhs.gov", "nc.gov")


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

    def test_nothing_sits_beside_a_ref(self):
        # Draft-07 ignores every keyword next to a $ref, so a description or
        # a constraint written there reads as contract but never applies
        # (HACK-50 third review). Notes about a referenced field go on a
        # definition object or in kb/README.md instead.
        def beside_ref(node: object, path: str) -> list[str]:
            found: list[str] = []
            if isinstance(node, dict):
                if "$ref" in node and len(node) > 1:
                    found.append(f"{path}: {sorted(set(node) - {'$ref'})}")
                for key, value in node.items():
                    found += beside_ref(value, f"{path}/{key}")
            elif isinstance(node, list):
                for index, value in enumerate(node):
                    found += beside_ref(value, f"{path}/{index}")
            return found

        self.assertEqual(beside_ref(self.schema, "#"), [])
        # The check bites, and the validator really does drop such a
        # keyword: maxProperties 0 beside a $ref lets any group through.
        probe = copy.deepcopy(self.schema)
        target = probe["definitions"]["facts"]["properties"]["steps"]
        target["maxProperties"] = 0
        self.assertEqual(beside_ref(probe, "#"), ["#/definitions/facts/properties/steps: ['maxProperties']"])
        entry = copy.deepcopy(self.sample)
        entry["facts"]["steps"] = {"items": ["One step."], "source_id": entry["sources"][0]["id"], "retrieved_at": "2026-10-01"}
        self.assertEqual(list(Draft7Validator(probe).iter_errors(entry)), [])

    def test_sample_entry_exists_and_validates(self):
        self.assertTrue(SAMPLE_PATH.is_file(), f"missing {SAMPLE_PATH}")
        self.assertValid(self.sample, "shipped sample entry")
        self.assertEqual(self.sample["status"], "active")
        self.assertIsInstance(self.sample["version"], int)
        self.assertGreaterEqual(self.sample["version"], 1)

    def test_shipped_entries_are_exactly_the_three_samples(self):
        # Mission v2 M3 updated this rule: benefit matching needs more than
        # one shipped entry to rank, so the KB ships three pilot-agnostic
        # samples (the base sample plus matching fixtures B and C). All
        # must validate; see also TestOptionalGroups.
        shipped = sorted(path.name for path in ENTRIES_DIR.glob("*.json"))
        self.assertEqual(
            shipped,
            [
                "pilot-program-sample-b.json",
                "pilot-program-sample-c.json",
                "pilot-program-sample.json",
            ],
        )
        for name in shipped:
            entry = json.loads((ENTRIES_DIR / name).read_text(encoding="utf-8"))
            errors = self.schema_errors(entry)
            self.assertEqual(errors, [], f"{name}: {errors}")

    def test_every_shipped_entry_stays_pilot_agnostic(self):
        for path in sorted(ENTRIES_DIR.glob("*.json")):
            text = path.read_text(encoding="utf-8")
            self.assertIn(
                "{{PILOT_PROGRAM}}",
                text,
                f"{path.name} must stay a placeholder template",
            )

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

    def cadence_group(self) -> dict:
        return {
            "items": [
                {
                    "id": "every_6_months",
                    "interval_months": 6,
                    "label": "Every 6 months",
                    "applies_to": "People the official rules name for this schedule",
                    "starts_on": "2027-01-01",
                },
                {
                    "id": "once_a_year",
                    "interval_months": 12,
                    "label": "Once a year",
                    "applies_to": "Everyone else the official rules name",
                },
            ],
            "source_id": "official_rules_source",
            "retrieved_at": "2026-10-29",
        }

    def coverage_ends_group(self) -> dict:
        return {
            "items": ["A letter explains the decision and how to appeal it."],
            "source_id": "official_rules_source",
            "retrieved_at": "2026-10-29",
        }

    def test_optional_groups_validate_with_provenance(self):
        for group, value in [
            ("steps", self.steps_group()),
            ("match_signals", self.signal_group()),
            ("renewal_cadence", self.cadence_group()),
            ("if_coverage_ends", self.coverage_ends_group()),
        ]:
            self.assertValid(self.entry_with_group(group, value), f"entry with {group}")

    def test_coverage_ends_needs_provenance_and_text(self):
        for key in ["items", "source_id", "retrieved_at"]:
            entry = self.entry_with_group("if_coverage_ends", self.coverage_ends_group())
            del entry["facts"]["if_coverage_ends"][key]
            self.assertInvalid(entry, f"if_coverage_ends without {key}")
        blank = self.entry_with_group("if_coverage_ends", self.coverage_ends_group())
        blank["facts"]["if_coverage_ends"]["items"] = [""]
        self.assertInvalid(blank, "if_coverage_ends with a blank item")

    def test_cadence_age_range_validates(self):
        entry = self.entry_with_group("renewal_cadence", self.cadence_group())
        entry["facts"]["renewal_cadence"]["items"][0]["ages"] = {"min": 19, "max": 64}
        self.assertValid(entry, "cadence item with an age range")
        for ages in [
            {"min": 19},
            {"max": 64},
            {"min": -1, "max": 64},
            {"min": 19, "max": 131},
            {"min": 19.5, "max": 64},
            {"min": "19", "max": 64},
            {"min": 19, "max": 64, "label": "adults"},
            [19, 64],
        ]:
            bad = self.entry_with_group("renewal_cadence", self.cadence_group())
            bad["facts"]["renewal_cadence"]["items"][0]["ages"] = ages
            self.assertInvalid(bad, f"cadence ages {ages!r}")

    def test_cadence_item_may_name_its_own_source(self):
        # A group can draw its schedules from different pages; each schedule
        # then renders with the page that states it (HACK-50 review fix).
        entry = self.entry_with_group("renewal_cadence", self.cadence_group())
        entry["facts"]["renewal_cadence"]["items"][0]["source_id"] = "official_application_portal"
        self.assertValid(entry, "cadence item with its own source")
        for value in ["Not A Source", "", 7, None]:
            bad = self.entry_with_group("renewal_cadence", self.cadence_group())
            bad["facts"]["renewal_cadence"]["items"][0]["source_id"] = value
            self.assertInvalid(bad, f"cadence item source_id {value!r}")

    def test_cadence_missing_any_required_key_fails(self):
        for key in ["id", "interval_months", "label", "applies_to"]:
            entry = self.entry_with_group("renewal_cadence", self.cadence_group())
            del entry["facts"]["renewal_cadence"]["items"][0][key]
            self.assertInvalid(entry, f"cadence item without {key}")

    def test_cadence_starts_on_stays_optional(self):
        entry = self.entry_with_group("renewal_cadence", self.cadence_group())
        del entry["facts"]["renewal_cadence"]["items"][0]["starts_on"]
        self.assertValid(entry, "cadence item without starts_on")

    def test_cadence_out_of_range_interval_fails(self):
        for months in [0, 25, -6, 1.5, "6"]:
            entry = self.entry_with_group("renewal_cadence", self.cadence_group())
            entry["facts"]["renewal_cadence"]["items"][0]["interval_months"] = months
            self.assertInvalid(entry, f"cadence interval {months!r}")

    def test_cadence_malformed_fields_fail(self):
        for key, value in [
            ("id", "Every Six!"),
            ("starts_on", "2027/01/01"),
            ("label", ""),
            ("applies_to", ""),
        ]:
            entry = self.entry_with_group("renewal_cadence", self.cadence_group())
            entry["facts"]["renewal_cadence"]["items"][0][key] = value
            self.assertInvalid(entry, f"cadence item with {key}={value!r}")

    def test_cadence_unknown_key_and_empty_items_fail(self):
        entry = self.entry_with_group("renewal_cadence", self.cadence_group())
        entry["facts"]["renewal_cadence"]["items"][0]["ends_on"] = "2028-01-01"
        self.assertInvalid(entry, "cadence item with an unknown key")
        empty = self.entry_with_group("renewal_cadence", self.cadence_group())
        empty["facts"]["renewal_cadence"]["items"] = []
        self.assertInvalid(empty, "cadence group with no items")

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
        for path in sorted(ENTRIES_DIR.glob("*.json")) + sorted(PILOT_DIR.glob("*.json")):
            entry = json.loads(path.read_text(encoding="utf-8"))
            source_ids = {source["id"] for source in entry["sources"]}
            for group in ["steps", "match_signals", "renewal_cadence", "if_coverage_ends"]:
                if group in entry["facts"]:
                    self.assertIn(
                        entry["facts"][group]["source_id"],
                        source_ids,
                        f"{path.name} facts.{group}",
                    )
            # A schedule's own source_id must resolve too.
            for item in entry["facts"].get("renewal_cadence", {}).get("items", []):
                if "source_id" in item:
                    self.assertIn(
                        item["source_id"],
                        source_ids,
                        f"{path.name} facts.renewal_cadence schedule {item['id']}",
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
        # kb/pilot/ is the one exception: it holds the decided pilot's real
        # entries (HACK-50), and TestPilotEntries below checks them instead.
        # The samples, schema, README, and the consuming module stay free of
        # program names.
        files = [
            path
            for path in KB_DIR.rglob("*")
            if path.is_file() and PILOT_DIR not in path.parents
        ]
        if KB_CODE_PATH.is_file():
            files.append(KB_CODE_PATH)
        return files

    def test_surface_scan_still_covers_the_samples_and_schema(self):
        # The pilot exclusion must not hollow out the scan.
        names = {path.name for path in self.kb_surface_files()}
        for expected in ["schema.json", "README.md", "pilot-program-sample.json", "kb.ts"]:
            self.assertIn(expected, names)
        self.assertFalse(
            any(PILOT_DIR in path.parents for path in self.kb_surface_files()),
            "pilot entries are checked by TestPilotEntries, not this scan",
        )

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


def is_official_pilot_host(url: str) -> bool:
    parsed = urlparse(url)
    host = parsed.hostname or ""
    return parsed.scheme == "https" and any(
        host == domain or host.endswith("." + domain) for domain in PILOT_SOURCE_DOMAINS
    )


def pilot_files(directory: Path = PILOT_DIR) -> list[Path]:
    # Every file under kb/pilot/, not only the JSON entries. The VAL-KB-003
    # scan skips the whole directory, README and any later notes included,
    # so the name and placeholder checks have to read all of it.
    return sorted(path for path in directory.rglob("*") if path.is_file())


def other_program_names(paths: list[Path]) -> dict[str, set[str]]:
    """Blocklisted program names other than the pilot's own, by file path."""
    found: dict[str, set[str]] = {}
    for path in paths:
        text = path.read_text(encoding="utf-8")
        named = {match.group(0).lower() for match in PROGRAM_NAME_RE.finditer(text)}
        extra = named - PILOT_PROGRAM_NAMES
        if extra:
            found[str(path)] = extra
    return found


class TestPilotEntries(KbSchemaTestCase):
    """HACK-50: entries for the decided pilot carry real, verified facts.

    They live in kb/pilot/, apart from the pilot-agnostic samples, and must
    validate against the same schema, cite only official North Carolina
    government sources over https, carry no placeholders, and name no real
    program other than the pilot's own. The last two rules cover every file
    in the directory, since none of them is on the VAL-KB-003 scan.
    """

    def pilot_entries(self) -> list[tuple[Path, dict]]:
        return [
            (path, json.loads(path.read_text(encoding="utf-8")))
            for path in sorted(PILOT_DIR.glob("*.json"))
        ]

    def test_ships_the_renewal_entry(self):
        # assertIn, not an exact list: the next kb/pilot entry adds a file
        # without loosening this check.
        names = [path.name for path, _ in self.pilot_entries()]
        self.assertIn("nc-medicaid-renewal.json", names)

    def test_cadence_age_ranges_are_ordered(self):
        # The schema cannot compare min with max; kb.ts and this check do.
        for path, entry in self.pilot_entries():
            for item in entry["facts"].get("renewal_cadence", {}).get("items", []):
                if "ages" in item:
                    self.assertLessEqual(item["ages"]["min"], item["ages"]["max"], path.name)

    def test_pilot_entries_validate(self):
        for path, entry in self.pilot_entries():
            self.assertEqual(self.schema_errors(entry), [], path.name)
            self.assertEqual(entry["status"], "active", path.name)

    def test_pilot_ids_do_not_collide_with_the_samples(self):
        sample_ids = {
            json.loads(path.read_text(encoding="utf-8"))["id"]
            for path in ENTRIES_DIR.glob("*.json")
        }
        pilot_ids = [entry["id"] for _, entry in self.pilot_entries()]
        self.assertEqual(len(pilot_ids), len(set(pilot_ids)))
        self.assertFalse(sample_ids & set(pilot_ids))

    def test_every_group_cites_a_listed_source(self):
        for path, entry in self.pilot_entries():
            source_ids = {source["id"] for source in entry["sources"]}
            for group, facts in entry["facts"].items():
                self.assertIn(facts["source_id"], source_ids, f"{path.name} facts.{group}")
            for item in entry["facts"].get("renewal_cadence", {}).get("items", []):
                if "source_id" in item:
                    self.assertIn(item["source_id"], source_ids, f"{path.name} schedule {item['id']}")

    def test_sources_and_links_are_official_nc_https(self):
        for path, entry in self.pilot_entries():
            for source in entry["sources"]:
                self.assertTrue(is_official_pilot_host(source["url"]), source["url"])
            for link in entry["facts"]["official_links"]["items"]:
                self.assertTrue(is_official_pilot_host(link["url"]), link["url"])

    def test_official_host_check_bites(self):
        for url in [
            "http://medicaid.ncdhhs.gov/renewals",
            "https://example.org/medicaid",
            "https://ncdhhs.gov.example.com/page",
            "https://fakencdhhs.gov/page",
        ]:
            self.assertFalse(is_official_pilot_host(url), url)
        self.assertTrue(is_official_pilot_host("https://epass.nc.gov/"))

    def test_no_placeholders_survive(self):
        for path in pilot_files():
            text = path.read_text(encoding="utf-8")
            self.assertNotIn("{{", text, path.name)
            self.assertNotIn("example.org", text, path.name)

    def test_names_only_the_pilot_program(self):
        self.assertEqual(other_program_names(pilot_files()), {})

    def test_pilot_file_checks_read_every_file_not_only_json(self):
        # The README is on the list, so the checks above are not vacuous.
        names = {path.name for path in pilot_files()}
        self.assertIn("README.md", names)
        self.assertIn("nc-medicaid-renewal.json", names)
        # And the name check bites on files that are not entries: the probe
        # from the HACK-50 review, a README line and a plain text note.
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "README.md").write_text(
                "SNAP and CHIP renew on other schedules.\n", encoding="utf-8"
            )
            (folder / "notes.txt").write_text("SNAP\n", encoding="utf-8")
            (folder / "entry.json").write_text('{"title": "NC Medicaid"}\n', encoding="utf-8")
            found = other_program_names(pilot_files(folder))
        self.assertEqual(
            {Path(name).name: sorted(extra) for name, extra in found.items()},
            {"README.md": ["chip", "snap"], "notes.txt": ["snap"]},
        )

    def test_dates_are_real_and_never_in_the_future(self):
        today = datetime.date.today()
        for path, entry in self.pilot_entries():
            dates = [source["retrieved_at"] for source in entry["sources"]]
            dates += [facts["retrieved_at"] for facts in entry["facts"].values()]
            for value in dates:
                self.assertLessEqual(datetime.date.fromisoformat(value), today, path.name)
            for item in entry["facts"]["deadlines"]["items"]:
                if ISO_DATE_RE.match(item["due"]):
                    datetime.date.fromisoformat(item["due"])

    def test_cadence_schedules_are_unique_and_dated(self):
        for path, entry in self.pilot_entries():
            cadence = entry["facts"].get("renewal_cadence")
            self.assertIsNotNone(cadence, f"{path.name} needs renewal_cadence")
            assert cadence is not None
            ids = [item["id"] for item in cadence["items"]]
            self.assertEqual(len(ids), len(set(ids)), path.name)
            for item in cadence["items"]:
                if "starts_on" in item:
                    datetime.date.fromisoformat(item["starts_on"])


if __name__ == "__main__":
    unittest.main()
