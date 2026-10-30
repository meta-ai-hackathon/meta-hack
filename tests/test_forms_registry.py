"""Form-registry checks (Mission v2 M4 / HACK-74): VAL-PDF-001 + VAL-X2-004
follow-through.

The validation contract expects the committed sample form PDFs and the
form-registry entries to be (a) mechanically valid against the registry
schema with spec-cross-checked mappings (VAL-PDF-001, BN-27 discipline) and
(b) pilot-agnostic — zero real program or jurisdiction names anywhere on the
committed surface, placeholder discipline held (VAL-X2-004 round-2 scope
note, Oct 29). PDF fixtures are scanned as raw bytes AND after decompressing
every FlateDecode stream, so blocklisted names cannot hide inside compressed
content.
"""

import hashlib
import json
import re
import unittest
import zlib
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator

REPO_ROOT = Path(__file__).resolve().parents[1]
FORMS_DIR = REPO_ROOT / "kb" / "forms"
SCHEMA_PATH = FORMS_DIR / "schema.json"
SPEC_PATH = REPO_ROOT / "specs" / "question-spec" / "generic-questions.json"
FORMS_LIB_DIR = REPO_ROOT / "src" / "lib" / "forms"

# The REAL pilot fixture (HACK-16 Done, mission v2.1 M6): the DHB-5200 as
# published by NC DHHS, retrieved 2026-10-30 from the official apply page's
# printable-application link. The sha256 pins the committed fixture to the
# retrieved bytes — if the source ever changes, a person re-retrieves,
# re-verifies, and re-pins (BN-27 discipline).
REAL_FORM_SHA256 = (
    "19e1e39f6150c8b823bc25e8732649e5d55bc9602c5b5a4e4a4dc7edc19232e0"
)

PROGRAM_NAME_BLOCKLIST = [
    # Benefit programs (the same list the KB surface enforces).
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
    # Jurisdictions and official-portal names: the pilot has converged on a
    # specific state/county/portal, so those names are blocklisted too until
    # HACK-16 formally lands (VAL-X2-004 round-2 scope note).
    "North Carolina",
    "Mecklenburg",
    "Charlotte",
    "Raleigh",
    "ePASS",
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


def load_spec() -> dict:
    with open(SPEC_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def load_entries() -> dict[str, dict[str, Any]]:
    entries = {}
    for path in sorted(FORMS_DIR.glob("*.json")):
        if path.name == "schema.json":
            continue
        with open(path, encoding="utf-8") as handle:
            entries[path.name] = json.load(handle)
    return entries


def pdf_scannable_chunks(path: Path) -> list[bytes]:
    """Raw bytes plus every successfully decompressed stream, concatenated
    in chunks, so a grep-equivalent scan sees compressed content too."""
    raw = path.read_bytes()
    chunks = [raw]
    for match in re.finditer(rb"stream\r?\n", raw):
        start = match.end()
        end = raw.find(b"endstream", start)
        if end == -1:
            continue
        try:
            chunks.append(zlib.decompress(raw[start:end]))
        except zlib.error:
            continue
    return chunks


class TestRegistrySchemaAndEntries(unittest.TestCase):
    def setUp(self) -> None:
        self.schema = load_schema()
        self.validator = Draft7Validator(self.schema)
        self.entries = load_entries()
        self.spec = load_spec()
        self.spec_ids = {q["id"] for q in self.spec["questions"]}
        self.pii_ids = {q["id"] for q in self.spec["questions"] if q["pii"]}

    def assertValid(self, instance: object, context: str) -> None:
        errors = sorted(
            self.validator.iter_errors(instance), key=lambda e: e.path
        )
        self.assertEqual(
            errors, [], f"{context} failed schema validation: {errors}"
        )

    def test_schema_is_valid_draft07(self):
        Draft7Validator.check_schema(self.schema)

    def test_exactly_two_samples_and_the_real_form_ship(self):
        # Mission v2.1 M6: the two synthetic samples (M4 fixtures) plus the
        # REAL pilot registry entry (HACK-16 Done: the NC Medicaid DHB-5200,
        # official_source origin).
        self.assertEqual(
            sorted(self.entries),
            [
                "dhb-5200.json",
                "sample-form-acroform.json",
                "sample-form-flat.json",
            ],
        )

    def test_both_entries_validate(self):
        for name, entry in self.entries.items():
            self.assertValid(entry, name)

    def test_spec_question_ids_resolve(self):
        for name, entry in self.entries.items():
            for field in entry["fields"]:
                spec_id = field["spec_question_id"]
                if spec_id is not None:
                    self.assertIn(
                        spec_id,
                        self.spec_ids,
                        f"{name}: {field['name']} maps to unknown question",
                    )

    def test_vault_allowlist_is_pii_only_and_covers_every_pii_mapping(self):
        # VAL-PDF-006 data side: the fill reads vault values ONLY through the
        # per-form allowlist, so every field whose spec mapping is pii:true
        # must be on it (otherwise the fill could never see its value), and
        # the allowlist may never name a non-pii question.
        for name, entry in self.entries.items():
            allowlist = set(entry["vault_field_allowlist"])
            self.assertEqual(allowlist, allowlist & self.pii_ids)
            for field in entry["fields"]:
                spec_id = field["spec_question_id"]
                if spec_id is not None and spec_id in self.pii_ids:
                    self.assertIn(
                        spec_id,
                        allowlist,
                        f"{name}: {field['name']} maps pii question "
                        f"{spec_id} but the allowlist omits it",
                    )

    def test_pii_likely_mirrors_the_spec_pii_flag(self):
        # A mapped field's pii_likely is not a judgment call: it must equal
        # the spec's pii flag, or a registry typo could either leak a pii
        # value into a client view (false negative) or over-hide a public
        # one (false positive).
        for name, entry in self.entries.items():
            for field in entry["fields"]:
                spec_id = field["spec_question_id"]
                if spec_id is None:
                    continue
                expected = spec_id in self.pii_ids
                self.assertEqual(
                    field["pii_likely"],
                    expected,
                    f"{name}: {field['name']} pii_likely disagrees with "
                    f"the spec flag for {spec_id}",
                )

    def test_unmapped_fields_are_sensitive_by_default(self):
        # A field the spec does not ask has no classification from the spec,
        # so it is treated as identity-likely by default: its value is
        # omitted from client views. A registry author must make a
        # deliberate, reviewed choice to expose one — the schema cannot
        # carry a default, so the test enforces the conservative direction.
        for name, entry in self.entries.items():
            for field in entry["fields"]:
                if field["spec_question_id"] is None:
                    self.assertTrue(
                        field["pii_likely"],
                        f"{name}: unmapped field {field['name']} must be "
                        "pii_likely (sensitive by default)",
                    )

    def test_flat_entry_has_answer_boxes_and_acroform_entry_does_not(self):
        for name, entry in self.entries.items():
            for field in entry["fields"]:
                box = field.get("answer_box")
                if entry["kind"] == "flat":
                    self.assertIsNotNone(
                        box, f"{name}: flat field {field['name']} lacks answer_box"
                    )
                    self.assertIn(box["page"], field["pages"])
                else:
                    self.assertIsNone(
                        box,
                        f"{name}: acroform field {field['name']} "
                        "must not hardcode coordinates",
                    )

    def test_questions_are_plain_language_and_field_names_come_first(self):
        # The mapping discipline: every field carries the on-form label and a
        # plain-language question (the reviewed LLM-assisted mapping), so the
        # conversation flow can ask it without the opaque field name.
        for name, entry in self.entries.items():
            for field in entry["fields"]:
                self.assertLess(
                    len(field["name"]),
                    len(field["question"]),
                    f"{name}: {field['name']} mapping not reviewed?",
                )


class TestPilotSurfaces(unittest.TestCase):
    """Post-lock successor of TestPilotAgnostic (VAL-X2-004 as amended,
    Oct 30): HACK-16 is Done, so real program/jurisdiction names are
    sanctioned ONLY on surfaces that carry their own verification —
    registry entries declared official_source (with source URL + retrieval
    date) — while the synthetic sample fixtures and the pipeline code stay
    pilot-agnostic."""

    def setUp(self) -> None:
        self.entries = load_entries()
        self.pdf_paths = [
            REPO_ROOT / entry["pdf_path"] for entry in self.entries.values()
        ]

    def sanctioned_entry_names(self) -> set[str]:
        # The sanction is derived from the artifact's own declared provenance,
        # not from a name list: an entry may carry real program names only when
        # it declares origin=official_source (the schema requires url +
        # retrieved_at on every source).
        return {
            name
            for name, entry in self.entries.items()
            if entry["source"]["origin"] == "official_source"
        }

    def test_sample_entries_stay_placeholder_agnostic(self):
        for name, entry in self.entries.items():
            if name in self.sanctioned_entry_names():
                continue
            self.assertEqual(
                entry["program"],
                "{{PILOT_PROGRAM}}",
                f"{name}: sample program must stay a placeholder",
            )

    def test_real_entry_declares_official_provenance(self):
        entry = self.entries["dhb-5200.json"]
        self.assertEqual(entry["program"], "NC Medicaid")
        self.assertEqual(entry["source"]["origin"], "official_source")
        self.assertEqual(
            entry["source"]["url"],
            "https://policies.ncdhhs.gov/wp-content/uploads/dhb-5200-ia-9-2020.pdf",
        )
        self.assertRegex(entry["source"]["retrieved_at"], ISO_DATE_RE)

    def test_no_real_program_names_outside_sanctioned_entries(self):
        # Text surface: the registry entries + schema + the forms module code.
        sanctioned = self.sanctioned_entry_names()
        surfaces: list[tuple[str, str]] = [
            (str(path), path.read_text(encoding="utf-8"))
            for path in sorted(FORMS_DIR.glob("*.json"))
            if path.name not in sanctioned
        ]
        if FORMS_LIB_DIR.is_dir():
            surfaces += [
                (str(path), path.read_text(encoding="utf-8"))
                for path in sorted(FORMS_LIB_DIR.rglob("*"))
                if path.suffix in {".ts", ".tsx"}
            ]
        for path_name, text in surfaces:
            match = PROGRAM_NAME_RE.search(text)
            if match is not None:
                self.fail(
                    f"{path_name} names a real program or jurisdiction "
                    f"({match.group(0)!r}); only official_source registry "
                    "entries may carry program names"
                )

    def test_sample_pdfs_stay_name_free(self):
        # Binary surface: raw bytes AND every decompressed stream of each
        # committed SAMPLE PDF (VAL-X2-004 scope note: grep output recorded
        # in the PR body for the milestone validation).
        sample_paths = [
            REPO_ROOT / self.entries[name]["pdf_path"]
            for name in ("sample-form-acroform.json", "sample-form-flat.json")
        ]
        self.assertEqual(len(sample_paths), 2, "both sample PDFs committed")
        for path in sample_paths:
            self.assertTrue(path.is_file(), f"missing fixture {path}")
            for chunk in pdf_scannable_chunks(path):
                match = PROGRAM_NAME_RE.search(chunk.decode("latin-1"))
                if match is not None:
                    self.fail(
                        f"{path.name} carries a real program or jurisdiction "
                        f"name ({match.group(0)!r}) in its content streams"
                    )

    def test_real_form_fixture_is_pinned_to_the_retrieved_bytes(self):
        # The real form's content streams ARE the state's own words — the
        # name-free scan does not apply to it. Its integrity is pinned by
        # the sha256 of the 2026-10-30 retrieval instead.
        path = REPO_ROOT / self.entries["dhb-5200.json"]["pdf_path"]
        self.assertTrue(path.is_file(), f"missing real-form fixture {path}")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        self.assertEqual(
            digest,
            REAL_FORM_SHA256,
            "the committed DHB-5200 fixture is not the bytes retrieved "
            "2026-10-30 — re-retrieve, re-verify the registry entry, and "
            "re-pin the hash",
        )


if __name__ == "__main__":
    unittest.main()
