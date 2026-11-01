"""Program-requirements spec checks (quick-questions milestone): VAL-QQ-003.

The program-requirements layer is a committed, reviewed decision: which
question-spec ids each program's application actually needs. The layer
SELECTS from specs/question-spec/generic-questions.json — the single
source of truth for question definitions — and links the committed form
registries whose ``spec_question_id`` fields also name spec questions.
These checks pin the data discipline: ids resolve, registries resolve,
and the derived per-program required universe only ever references
question ids present in the question spec.
"""

import json
import unittest
from pathlib import Path
from typing import Any

from jsonschema import Draft7Validator

REPO_ROOT = Path(__file__).resolve().parents[1]
SPEC_DIR = REPO_ROOT / "specs" / "question-spec"
REQUIREMENTS_PATH = SPEC_DIR / "program-requirements.json"
REQUIREMENTS_SCHEMA_PATH = SPEC_DIR / "program-requirements.schema.json"
QUESTION_SPEC_PATH = SPEC_DIR / "generic-questions.json"
FORMS_DIR = REPO_ROOT / "kb" / "forms"


def load_requirements() -> dict[str, Any]:
    with open(REQUIREMENTS_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def load_schema() -> dict[str, Any]:
    with open(REQUIREMENTS_SCHEMA_PATH, encoding="utf-8") as handle:
        schema = json.load(handle)
    Draft7Validator.check_schema(schema)
    return schema


def load_question_spec() -> dict[str, Any]:
    with open(QUESTION_SPEC_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def load_form_registries() -> dict[str, dict[str, Any]]:
    registries: dict[str, dict[str, Any]] = {}
    for path in sorted(FORMS_DIR.glob("*.json")):
        if path.name == "schema.json":
            continue
        with open(path, encoding="utf-8") as handle:
            registries[path.stem] = json.load(handle)
    return registries


def registry_link_ids(entry: dict[str, Any]) -> set[str]:
    """The spec question ids a form registry's fields link to."""
    return {
        field["spec_question_id"]
        for field in entry["fields"]
        if field["spec_question_id"] is not None
    }


class TestProgramRequirementsSpec(unittest.TestCase):
    def setUp(self) -> None:
        self.schema = load_schema()
        self.validator = Draft7Validator(self.schema)
        self.document = load_requirements()
        self.question_spec = load_question_spec()
        self.spec_ids = {q["id"] for q in self.question_spec["questions"]}
        self.registries = load_form_registries()
        self.programs = self.document["programs"]
        self.programs_by_id = {p["id"]: p for p in self.programs}

    def assertValid(self, instance: object) -> None:
        errors = sorted(self.validator.iter_errors(instance), key=lambda e: e.path)
        self.assertEqual(errors, [], f"failed schema validation: {errors}")

    def test_schema_is_valid_draft07(self):
        Draft7Validator.check_schema(self.schema)

    def test_document_validates(self):
        self.assertValid(self.document)

    def test_program_ids_are_unique(self):
        ids = [p["id"] for p in self.programs]
        self.assertEqual(len(ids), len(self.programs_by_id), "duplicate program ids")

    def test_default_programs_resolve(self):
        for program_id in self.document["default_programs"]:
            self.assertIn(
                program_id,
                self.programs_by_id,
                f"default program {program_id!r} is not defined in programs",
            )

    def test_required_question_ids_resolve_to_spec_questions(self):
        # The requirements layer selects from the question spec — it never
        # defines questions of its own (VAL-QQ-003).
        for program in self.programs:
            for question_id in program["required_question_ids"]:
                self.assertIn(
                    question_id,
                    self.spec_ids,
                    f"{program['id']}: required id {question_id!r} is not a "
                    "generic-questions.json question id",
                )

    def test_form_registry_ids_resolve_to_committed_registries(self):
        for program in self.programs:
            for registry_id in program["form_registry_ids"]:
                self.assertIn(
                    registry_id,
                    self.registries,
                    f"{program['id']}: form registry {registry_id!r} is not "
                    "committed under kb/forms/",
                )

    def test_derived_universe_references_only_spec_question_ids(self):
        # The engine derives each program's universe as the union of the
        # committed list and the linked registries' spec_question_id links.
        # Every id in that union must be a question the spec defines, so the
        # flow engine can always resolve it (VAL-QQ-003).
        for program in self.programs:
            derived = set(program["required_question_ids"])
            for registry_id in program["form_registry_ids"]:
                derived |= registry_link_ids(self.registries[registry_id])
            unexpected = derived - self.spec_ids
            self.assertEqual(
                unexpected,
                set(),
                f"{program['id']}: derived universe references ids outside "
                f"the question spec: {sorted(unexpected)}",
            )


if __name__ == "__main__":
    unittest.main()
