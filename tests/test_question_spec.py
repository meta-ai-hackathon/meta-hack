"""Question spec checks: unique ids, resolvable skips, options, PII rules."""

import json
import os
import unittest

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPEC_PATH = os.path.join(REPO_ROOT, "specs", "question-spec", "generic-questions.json")

VALID_OPERATORS = {"equals", "not_equals", "in", "not_in", "gt"}


def load_spec():
    with open(SPEC_PATH, encoding="utf-8") as f:
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


if __name__ == "__main__":
    unittest.main()
