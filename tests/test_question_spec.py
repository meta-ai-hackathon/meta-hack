"""Question spec checks: unique ids, resolvable skips, options, PII rules."""

import json
import os
import unittest

from jsonschema import Draft7Validator

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC_DIR = os.path.join(REPO_ROOT, "specs", "question-spec")
SPEC_PATH = os.path.join(SPEC_DIR, "generic-questions.json")
SCHEMA_PATH = os.path.join(SPEC_DIR, "schema.json")

VALID_OPERATORS = {"equals", "not_equals", "in", "not_in", "gt"}

# The work-requirements questions (milestone work-requirements, VAL-WR-001):
# Civilla's user-tested Medicaid work-requirements questions, adopted as
# QUESTIONS ONLY from the published plain-language insert
# (https://civilla.org/work/hr1/ +
# https://civilla.org/assets/files/Paper_Application_Insert_V1.pdf,
# retrieved 2026-11-01) for the CMS interim final rule of June 1, 2026
# (work requirements effective 2027-01-01). The canonical id list, in the
# order the questions appear in the spec.
WORK_REQUIREMENTS_IDS = [
    "wr_exempt_situations",
    "wr_pregnant",
    "wr_drug_alcohol_treatment",
    "wr_drug_alcohol_disorder",
    "wr_disability_hard_work",
    "wr_mental_health_hard_work",
    "wr_serious_health_condition",
    "wr_jail_prison_past_4_months",
    "wr_foster_care_under_26",
    "wr_veteran_100_disabled",
    "wr_applied_last_month",
    "wr_applied_last_month_which",
    "wr_medical_travel_1hr",
    "wr_hospital_care_24hr",
    "wr_student_enrolled",
    "wr_income_580",
    "wr_work_activity_who",
    "wr_work_activity_types",
    "wr_work_activity_hours",
]

# The reporting section of the Civilla two-section design: these three ask
# who did work activities, what kinds, and how many hours last month —
# and are hidden by the spec whenever an exemption, income, or student
# path applies (VAL-WR-004; the engine tests prove both directions).
WORK_ACTIVITY_IDS = [
    "wr_work_activity_who",
    "wr_work_activity_types",
    "wr_work_activity_hours",
]

# Health/disability/drug-alcohol/mental-health/pregnancy/incarceration/
# veteran/foster answers are sensitive: the questions carrying them are
# pii:true (encrypted vault path only). The which-situations follow-up
# reveals the same facts, and the medical-travel and hospital-care rows
# reveal health conditions — all pii:true. The who field is a text
# question (text is always pii per the schema).
SENSITIVE_WORK_REQUIREMENTS_IDS = [
    "wr_pregnant",
    "wr_drug_alcohol_treatment",
    "wr_drug_alcohol_disorder",
    "wr_disability_hard_work",
    "wr_mental_health_hard_work",
    "wr_serious_health_condition",
    "wr_jail_prison_past_4_months",
    "wr_foster_care_under_26",
    "wr_veteran_100_disabled",
    "wr_applied_last_month_which",
    "wr_medical_travel_1hr",
    "wr_hospital_care_24hr",
    "wr_work_activity_who",
]

# The work-requirements questions that carry no sensitive fact: household
# roles, past-month applicability, student enrollment, the household
# income screen, activity types, and hours.
NONSENSITIVE_WORK_REQUIREMENTS_IDS = [
    "wr_exempt_situations",
    "wr_applied_last_month",
    "wr_student_enrolled",
    "wr_income_580",
    "wr_work_activity_types",
    "wr_work_activity_hours",
]


def load_spec():
    with open(SPEC_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_schema():
    with open(SCHEMA_PATH, encoding="utf-8") as f:
        return json.load(f)


class TestQuestionSpec(unittest.TestCase):
    def setUp(self):
        self.questions = load_spec()["questions"]
        self.by_id = {q["id"]: q for q in self.questions}

    def test_question_ids_unique(self):
        ids = [q["id"] for q in self.questions]
        self.assertEqual(len(ids), len(self.by_id), "duplicate question ids found")

    def test_skip_condition_question_ids_resolve(self):
        for q in self.questions:
            for cond in q.get("skip_conditions", []):
                self.assertIn(
                    cond["question_id"],
                    self.by_id,
                    f"{q['id']}: skip references unknown question {cond['question_id']}",
                )

    def test_select_questions_have_options(self):
        for q in self.questions:
            if q["type"] in ("single_select", "multi_select"):
                options = q.get("options", [])
                self.assertTrue(options, f"{q['id']}: select question has no options")
                values = [o["value"] for o in options]
                self.assertEqual(
                    len(values), len(set(values)), f"{q['id']}: duplicate option values"
                )
            else:
                self.assertNotIn(
                    "options", q, f"{q['id']}: non-select question has options"
                )

    def test_skip_values_reference_defined_options(self):
        for q in self.questions:
            for cond in q.get("skip_conditions", []):
                target = self.by_id[cond["question_id"]]
                if target["type"] not in ("single_select", "multi_select"):
                    continue
                allowed = {o["value"] for o in target["options"]}
                for value in str(cond["value"]).split(","):
                    self.assertIn(
                        value,
                        allowed,
                        f"{q['id']}: skip value '{value}' not an option of "
                        f"{cond['question_id']}",
                    )

    def test_pii_is_boolean(self):
        for q in self.questions:
            self.assertIsInstance(
                q["pii"], bool, f"{q['id']}: pii is not a boolean"
            )

    def test_text_and_address_questions_are_pii(self):
        for q in self.questions:
            if q["type"] in ("text", "address"):
                self.assertTrue(
                    q["pii"],
                    f"{q['id']}: free-text question of type {q['type']} must be pii: true",
                )

    def test_operators_are_valid(self):
        for q in self.questions:
            for cond in q.get("skip_conditions", []):
                self.assertIn(
                    cond["operator"],
                    VALID_OPERATORS,
                    f"{q['id']}: unknown operator {cond['operator']}",
                )

    def test_document_validates_against_schema(self):
        # The whole document (not just the manual checks above) validates
        # against specs/question-spec/schema.json — the VAL-WR-001 gate:
        # every question, option value, and skip condition is
        # schema-conformant by construction.
        schema = load_schema()
        Draft7Validator.check_schema(schema)
        validator = Draft7Validator(schema)
        errors = sorted(
            validator.iter_errors(load_spec()), key=lambda e: list(e.path)
        )
        self.assertEqual(
            errors,
            [],
            f"question spec failed schema validation: {errors}",
        )

    def test_skip_condition_references_come_earlier_in_spec_order(self):
        # Strengthening of the resolvability check: the schema describes a
        # skip condition as reading "an earlier question" — referenced ids
        # must appear before the question that skips on them, so the flow
        # never reads an answer that cannot exist yet.
        seen = set()
        for q in self.questions:
            for cond in q.get("skip_conditions", []):
                self.assertIn(
                    cond["question_id"],
                    seen,
                    f"{q['id']}: skip reads {cond['question_id']}, which is "
                    "not an earlier question in the spec order",
                )
            seen.add(q["id"])


class TestWorkRequirementsQuestions(unittest.TestCase):
    """The adopted work-requirements questions (VAL-WR-001/002).

    The Civilla-derived screen questions exist, are schema-conformant, are
    PII-classified per the owner directive, and encode the two-section
    design (exemptions first; work-activity reporting only when no
    exemption, income, or student path applies) in the spec's own
    skip_conditions.
    """

    def setUp(self):
        self.questions = load_spec()["questions"]
        self.by_id = {q["id"]: q for q in self.questions}

    def test_work_requirements_ids_exist_in_canonical_order(self):
        # Every Civilla-derived id is present, and appears in the same
        # relative order as this canonical list (the screen's own order).
        ids = [q["id"] for q in self.questions]
        positions = []
        for question_id in WORK_REQUIREMENTS_IDS:
            self.assertIn(
                question_id,
                self.by_id,
                f"missing work-requirements question {question_id}",
            )
            positions.append(ids.index(question_id))
        self.assertEqual(
            positions,
            sorted(positions),
            "work-requirements questions appear out of canonical order",
        )

    def test_spec_addition_is_purely_additive(self):
        # The 37 pre-existing questions are untouched: same ids, same
        # order — the work-requirements questions were appended after them.
        ids = [q["id"] for q in self.questions]
        preexisting = [
            qid for qid in ids if qid not in set(WORK_REQUIREMENTS_IDS)
        ]
        self.assertEqual(
            len(preexisting), 37, "pre-existing question ids changed"
        )
        self.assertEqual(
            ids[-len(WORK_REQUIREMENTS_IDS):],
            WORK_REQUIREMENTS_IDS,
            "work-requirements questions were not appended at the end",
        )

    def test_sensitive_work_requirements_questions_are_pii(self):
        for question_id in SENSITIVE_WORK_REQUIREMENTS_IDS:
            self.assertTrue(
                self.by_id[question_id]["pii"],
                f"{question_id}: sensitive work-requirements question must "
                "be pii: true",
            )

    def test_nonsensitive_work_requirements_questions_are_not_pii(self):
        for question_id in NONSENSITIVE_WORK_REQUIREMENTS_IDS:
            self.assertFalse(
                self.by_id[question_id]["pii"],
                f"{question_id}: household-role/income question carries no "
                "sensitive fact and must stay pii: false",
            )

    def test_work_activity_reporting_skips_encode_every_path(self):
        # The two-section design in spec data: each work-activity question
        # carries skip conditions covering the exemption screen (the
        # check-all-that-apply group AND each sensitive yes question), the
        # past-month rule, the other-situations rows, the $580 income
        # screen, and the student path (VAL-WR-004).
        expected_refs = {
            "wr_exempt_situations",
            "wr_pregnant",
            "wr_drug_alcohol_treatment",
            "wr_drug_alcohol_disorder",
            "wr_disability_hard_work",
            "wr_mental_health_hard_work",
            "wr_serious_health_condition",
            "wr_jail_prison_past_4_months",
            "wr_foster_care_under_26",
            "wr_veteran_100_disabled",
            "wr_applied_last_month",
            "wr_medical_travel_1hr",
            "wr_hospital_care_24hr",
            "wr_income_580",
            "wr_student_enrolled",
        }
        for question_id in WORK_ACTIVITY_IDS:
            conditions = self.by_id[question_id].get("skip_conditions", [])
            refs = {cond["question_id"] for cond in conditions}
            missing = expected_refs - refs
            self.assertEqual(
                missing,
                set(),
                f"{question_id}: work-activity reporting is missing skip "
                f"chains for {sorted(missing)}",
            )
            # Every hiding path keys on the affirmative answer only — the
            # exemption screen must never hide reporting by default. The
            # two multi-value conditions are the two check-all-that-apply
            # paths: the household-situations group and the student path.
            for cond in conditions:
                if cond["operator"] == "in":
                    self.assertIn(
                        cond["question_id"],
                        {"wr_exempt_situations", "wr_student_enrolled"},
                        f"{question_id}: multi-value skip condition on "
                        f"{cond['question_id']}",
                    )
                else:
                    self.assertEqual(
                        cond["value"],
                        "yes",
                        f"{question_id}: skip condition on "
                        f"{cond['question_id']} must key on the affirmative "
                        "answer",
                    )

    def test_which_situations_followup_skips_unless_applied_last_month(self):
        # The "which" follow-up only makes sense when the past-month
        # question was answered yes (fail-open keeps it asked otherwise).
        conditions = self.by_id["wr_applied_last_month_which"][
            "skip_conditions"
        ]
        self.assertEqual(
            conditions,
            [
                {
                    "question_id": "wr_applied_last_month",
                    "operator": "equals",
                    "value": "no",
                }
            ],
        )

    def test_income_580_screen_stays_askable_and_correctable(self):
        # The $580 screen carries no skip condition of its own: it is
        # asked directly when income was not captured, and pre-answered
        # ("Matched for you", person-correctable) by the deterministic
        # rule when it was — never skipped, never decided by an LLM.
        self.assertEqual(self.by_id["wr_income_580"]["skip_conditions"], [])
        self.assertTrue(self.by_id["wr_income_580"]["required"])


if __name__ == "__main__":
    unittest.main()
