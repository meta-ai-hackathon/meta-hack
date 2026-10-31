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

from hypothesis import given, settings
from hypothesis import strategies as st
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

# The Jest snapshot-file extension (".snap") is a token, not a program
# mention (claude-review P2 on PR #60, adjudicated 2026-10-30): strip the
# exact token before scanning so the case-insensitive SNAP word-boundary
# pattern cannot collide with it. Every other mention — any casing —
# still trips.
SNAP_EXTENSION_RE = re.compile(r"\.snap\b", re.IGNORECASE)


def find_program_name(line: str) -> "re.Match[str] | None":
    """Scan one KB-surface line for a blocklisted program name."""
    return PROGRAM_NAME_RE.search(SNAP_EXTENSION_RE.sub(" ", line))

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

    def test_shipped_entries_are_the_three_samples_plus_the_real_pilot_entry(self):
        # Mission v2 M3 added matching fixtures B and C (so matching has
        # something to rank); mission v2.1 M6 added the REAL pilot entry
        # (HACK-16 Done: NC Medicaid) built from official government
        # sources. All must validate; see also TestOptionalGroups and
        # TestRealPilotEntry.
        shipped = sorted(path.name for path in ENTRIES_DIR.glob("*.json"))
        self.assertEqual(
            shipped,
            [
                "nc-medicaid.json",
                "pilot-program-sample-b.json",
                "pilot-program-sample-c.json",
                "pilot-program-sample.json",
            ],
        )
        for name in shipped:
            entry = json.loads((ENTRIES_DIR / name).read_text(encoding="utf-8"))
            errors = self.schema_errors(entry)
            self.assertEqual(errors, [], f"{name}: {errors}")

    def test_every_sample_entry_stays_pilot_agnostic(self):
        # The SAMPLES stay placeholder templates after the lock (they remain
        # the test fixtures); the real entry is sanctioned by
        # TestRealPilotEntry instead.
        for name in [
            "pilot-program-sample.json",
            "pilot-program-sample-b.json",
            "pilot-program-sample-c.json",
        ]:
            text = (ENTRIES_DIR / name).read_text(encoding="utf-8")
            self.assertIn(
                "{{PILOT_PROGRAM}}",
                text,
                f"{name} must stay a placeholder template",
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


# The optional handoff groups (BN-24 and BN-26, HACK-46 and HACK-47).
SOURCED_STEP_GROUPS = ["submission_steps", "after_you_apply"]
SOURCED_STEP_REQUIRED_KEYS = ["id", "label", "detail", "source_id"]
SAMPLE_SOURCE_IDS = ["official_rules_source", "official_application_portal"]

STEP_TEXT = st.text(min_size=1, max_size=40)
STEP_LINK = st.fixed_dictionaries(
    {
        "label": STEP_TEXT,
        "url": st.from_regex(r"https://[a-z]{1,12}\.(gov|org)/[a-z0-9-]{0,12}", fullmatch=True),
    }
)
STEP = st.fixed_dictionaries(
    {
        "id": st.from_regex(r"[a-z][a-z0-9_]{0,15}", fullmatch=True),
        "label": STEP_TEXT,
        "detail": STEP_TEXT,
        "source_id": st.sampled_from(SAMPLE_SOURCE_IDS),
    },
    optional={"link": STEP_LINK},
)
STEP_LISTS = st.lists(STEP, min_size=1, max_size=6, unique_by=lambda step: str(step["id"]))

# A phone or fax number written out (555-123-4567, 555.123.4567, (555) 123-4567).
PHONE_NUMBER_RE = re.compile(r"\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b")


class TestSourcedStepGroups(KbSchemaTestCase):
    """The optional `submission_steps` and `after_you_apply` groups.

    Both hold ordered steps for the handoff, and every step names its own
    source instead of the group naming one, because a single list draws on
    the form, a county page, and an online portal. The schema checks the
    shape. The cross-references it cannot express (unique step ids, each
    step's source_id resolving) are checked here for every shipped entry,
    and in src/lib/kb.ts at load.
    """

    REAL_PATH = ENTRIES_DIR / "nc-medicaid.json"

    def step(self, **changes: object) -> dict[str, object]:
        step: dict[str, object] = {
            "id": "sign_it",
            "label": "Sign it",
            "detail": "The official form asks for a signature.",
            "source_id": "official_rules_source",
        }
        step.update(changes)
        return step

    def entry_with(self, group: str, items: list[Any], **group_changes: object) -> dict:
        entry = copy.deepcopy(self.sample)
        entry["facts"][group] = {"items": items, "retrieved_at": "2026-10-29", **group_changes}
        return entry

    @settings(max_examples=150, deadline=None)
    @given(group=st.sampled_from(SOURCED_STEP_GROUPS), steps=STEP_LISTS)
    def test_any_well_formed_group_validates(self, group: str, steps: list[dict]) -> None:
        self.assertValid(self.entry_with(group, steps), f"{group} with {steps!r}")

    @settings(max_examples=150, deadline=None)
    @given(
        group=st.sampled_from(SOURCED_STEP_GROUPS),
        steps=STEP_LISTS,
        pick=st.integers(min_value=0),
        key=st.sampled_from(SOURCED_STEP_REQUIRED_KEYS),
    )
    def test_dropping_any_required_step_field_fails(
        self, group: str, steps: list[dict], pick: int, key: str
    ) -> None:
        broken = copy.deepcopy(steps)
        del broken[pick % len(broken)][key]
        self.assertInvalid(self.entry_with(group, broken), f"{group} step without {key}")

    def test_groups_stay_optional(self) -> None:
        for group in SOURCED_STEP_GROUPS:
            self.assertNotIn(group, self.sample["facts"])
        self.assertValid(self.sample, "entry without the handoff groups")

    def test_a_group_level_source_is_not_a_substitute(self) -> None:
        # One source for the whole group is exactly what this shape rules
        # out: the source belongs on each step.
        for group in SOURCED_STEP_GROUPS:
            entry = self.entry_with(group, [self.step()], source_id="official_rules_source")
            self.assertInvalid(entry, f"{group} with a group-level source_id")
            unsourced = self.step()
            del unsourced["source_id"]
            self.assertInvalid(self.entry_with(group, [unsourced]), f"{group} step without source_id")

    def test_malformed_steps_fail(self) -> None:
        cases: list[tuple[str, list[Any]]] = [
            ("unknown step key", [self.step(bonus="nope")]),
            ("malformed step id", [self.step(id="Not An Id!")]),
            ("empty label", [self.step(label="")]),
            ("empty detail", [self.step(detail="")]),
            ("non-https link", [self.step(link={"label": "Apply", "url": "http://example.org/apply"})]),
            ("link without a label", [self.step(link={"url": "https://example.org/apply"})]),
            ("link with an unknown key", [self.step(link={"label": "Apply", "url": "https://example.org/apply", "target": "_blank"})]),
            ("malformed source id", [self.step(source_id="Not A Source!")]),
            ("step that is not an object", ["Sign it."]),
            ("empty items", []),
        ]
        for name, items in cases:
            for group in SOURCED_STEP_GROUPS:
                self.assertInvalid(self.entry_with(group, items), f"{group}: {name}")

    def test_group_needs_its_retrieval_date(self) -> None:
        for group in SOURCED_STEP_GROUPS:
            entry = self.entry_with(group, [self.step()])
            del entry["facts"][group]["retrieved_at"]
            self.assertInvalid(entry, f"{group} without retrieved_at")
            entry = self.entry_with(group, [self.step()], retrieved_at="Oct 30")
            self.assertInvalid(entry, f"{group} with a malformed retrieved_at")

    def test_form_id_is_optional_and_shaped_like_a_registry_id(self) -> None:
        for group in SOURCED_STEP_GROUPS:
            entry = self.entry_with(group, [self.step()], form_id="sample-form-1")
            self.assertValid(entry, f"{group} with a form_id")
            entry = self.entry_with(group, [self.step()], form_id="Not A Form!")
            self.assertInvalid(entry, f"{group} with a malformed form_id")

    def test_shipped_form_ids_name_a_registered_form(self) -> None:
        # Cross-reference the schema cannot express: a group tied to a form
        # names one the form registry actually ships.
        registered = {
            json.loads(path.read_text(encoding="utf-8"))["id"]
            for path in (KB_DIR / "forms").glob("*.json")
            if path.name != "schema.json"
        }
        for path in sorted(ENTRIES_DIR.glob("*.json")):
            entry = json.loads(path.read_text(encoding="utf-8"))
            for group in SOURCED_STEP_GROUPS:
                form_id = entry["facts"].get(group, {}).get("form_id")
                if form_id is not None:
                    self.assertIn(form_id, registered, f"{path.name} {group}")

    def test_shipped_step_ids_are_unique_and_every_source_resolves(self) -> None:
        for path in sorted(ENTRIES_DIR.glob("*.json")):
            entry = json.loads(path.read_text(encoding="utf-8"))
            source_ids = {source["id"] for source in entry["sources"]}
            for group in SOURCED_STEP_GROUPS:
                steps = entry["facts"].get(group, {}).get("items", [])
                ids = [step["id"] for step in steps]
                self.assertEqual(len(ids), len(set(ids)), f"{path.name} {group} repeats a step id")
                for step in steps:
                    self.assertIn(step["source_id"], source_ids, f"{path.name} {group} {step['id']}")

    def test_the_real_entry_carries_both_groups_from_official_pages(self) -> None:
        from urllib.parse import urlparse

        real = json.loads(self.REAL_PATH.read_text(encoding="utf-8"))
        sources = {source["id"]: source for source in real["sources"]}
        for group in SOURCED_STEP_GROUPS:
            steps = real["facts"][group]["items"]
            self.assertGreaterEqual(len(steps), 1, group)
            for step in steps:
                if "link" in step:
                    host = urlparse(step["link"]["url"]).hostname or ""
                    self.assertTrue(
                        host in {"dcr.mecknc.gov", "epass.nc.gov"},
                        f"{step['id']} links {host}, not an official page this entry verified",
                    )
                    # The link is the page its own source verified.
                    self.assertEqual(step["link"]["url"], sources[step["source_id"]]["url"], step["id"])

    def test_the_real_steps_sign_before_any_channel(self) -> None:
        real = json.loads(self.REAL_PATH.read_text(encoding="utf-8"))
        ids = [step["id"] for step in real["facts"]["submission_steps"]["items"]]
        channels = ["drop_off_or_fax_in_county", "take_or_mail_to_county", "apply_online_instead"]
        for channel in channels:
            self.assertLess(ids.index("sign_and_date"), ids.index(channel), channel)

    def test_the_real_steps_copy_no_numbers_and_no_legacy_rule(self) -> None:
        # Addresses, phone and fax numbers stay on the official pages the
        # steps link (they can change); the 2020 form's three-month
        # coverage line stays out (no current official page confirms it).
        real = json.loads(self.REAL_PATH.read_text(encoding="utf-8"))
        for group in SOURCED_STEP_GROUPS:
            for step in real["facts"][group]["items"]:
                text = f"{step['label']} {step['detail']}"
                self.assertIsNone(PHONE_NUMBER_RE.search(text), step["id"])
                self.assertNotIn("three months", text.lower(), step["id"])
                self.assertNotRegex(text.lower(), r"\b(approved|guaranteed|qualify|will receive)\b", step["id"])

    def test_phone_number_check_bites(self) -> None:
        for text in ["call 555-123-4567", "fax (555) 123-4567", "555.123.4567"]:
            self.assertIsNotNone(PHONE_NUMBER_RE.search(text), text)
        self.assertIsNone(PHONE_NUMBER_RE.search("within 1-2 weeks, or 10 calendar days"))


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

    def test_snap_extension_token_does_not_trip_the_blocklist(self):
        # claude-review P2 on PR #60 (adjudicated 2026-10-30): a Jest
        # snapshot-file reference on a KB-surface line is a file-extension
        # token, not a program mention — the case-insensitive SNAP
        # word-boundary pattern must not collide with it. A real mention,
        # in any casing, still trips.
        for line in [
            "src/lib/match.test.ts.snap: card renders snapshot",
            "exports[`match card renders`] = `retrieved 2026-10-29`  # .snap",
            "see match-card.test.ts.snap and kb.test.ts.snap",
        ]:
            self.assertIsNone(find_program_name(line), line)
        for line in ["SNAP", "snap benefits", "the Snap program", "food stamps"]:
            self.assertIsNotNone(find_program_name(line), line)

    def test_no_real_program_names_outside_the_sanctioned_real_entry(self):
        # Post-lock grep check (VAL-KB-003 as amended by VAL-X2-004, Oct 30):
        # HACK-16 is Done, so real program/jurisdiction names are sanctioned
        # in exactly ONE KB surface — the committed versioned real entry
        # (nc-medicaid.json) whose official sources + retrieval dates carry
        # the verification discipline. The samples, the schema, the README,
        # and the consuming module stay name-free. The kb/forms/ registry
        # entries are the forms surface, governed by test_forms_registry.
        sanctioned = ENTRIES_DIR / "nc-medicaid.json"
        forms_dir = (KB_DIR / "forms").resolve()
        for path in self.kb_surface_files():
            if path == sanctioned or forms_dir in path.resolve().parents:
                continue
            for line_number, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), start=1
            ):
                match = find_program_name(line)
                if match is None:
                    continue
                # The consuming module stays name-free except for the exact
                # import of the sanctioned entry file — loading the
                # sanctioned entry is the sanctioned wiring.
                if (
                    path == KB_CODE_PATH
                    and "import" in line
                    and f"kb/entries/{sanctioned.name}" in line
                ):
                    continue
                self.fail(
                    f"{path.name}:{line_number} names a real program "
                    f"({match.group(0)!r}); only the versioned real pilot "
                    "entry may carry program names on the KB surface"
                )


class TestRealPilotEntry(KbSchemaTestCase):
    """VAL-PILOTREAL-003 (pytest half): the real NC Medicaid entry ships with
    official sources, retrieval dates, and HACK-17 claim-verification notes."""

    REAL_PATH = ENTRIES_DIR / "nc-medicaid.json"
    OFFICIAL_HOSTS = (
        "ncdhhs.gov",
        "epass.nc.gov",
        "mecknc.gov",
    )

    def setUp(self) -> None:
        super().setUp()
        self.real = json.loads(self.REAL_PATH.read_text(encoding="utf-8"))

    def test_entry_is_active_and_schema_valid(self):
        self.assertValid(self.real, "real pilot entry")
        self.assertEqual(self.real["status"], "active")
        self.assertGreaterEqual(self.real["version"], 1)

    def test_every_source_is_an_official_government_host(self):
        from urllib.parse import urlparse

        for source in self.real["sources"]:
            host = urlparse(source["url"]).hostname or ""
            self.assertTrue(
                any(
                    host == official or host.endswith(f".{official}")
                    for official in self.OFFICIAL_HOSTS
                ),
                f"{source['id']}: {source['url']} is not an official host",
            )

    def test_every_source_records_its_retrieval_date(self):
        for source in self.real["sources"]:
            self.assertRegex(source["retrieved_at"], ISO_DATE_RE, source["id"])

    def test_every_source_carries_claim_verification_notes(self):
        # HACK-17 discipline: the supports string says WHAT was verified and
        # on which page; retrieved_at says WHEN. Unresolved claims are not
        # encoded as facts (the rules group says so explicitly).
        for source in self.real["sources"]:
            self.assertIn("HACK-17", source["supports"], source["id"])
            self.assertIn("2026-10-30", source["supports"], source["id"])

    def test_dhb_5200_vs_5201_reconciliation_is_recorded(self):
        text = self.REAL_PATH.read_text(encoding="utf-8")
        self.assertIn("DHB-5200", text)
        self.assertIn("DHB-5201", text)
        self.assertIn("initial", text)

    def test_no_thresholds_derived_from_legacy_form_illustrations(self):
        text = self.REAL_PATH.read_text(encoding="utf-8")
        self.assertNotIn("94,000", text)
        self.assertNotIn("$94", text)


if __name__ == "__main__":
    unittest.main()
