"""Meta Model API smoke script checks: offline logic, plus live steps that
skip unless MODEL_API_KEY is present in the repo .env (so CI stays green).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "meta_smoke_test.py"
REPO_ENV_PATH = REPO_ROOT / ".env"


def _load_module():
    spec = importlib.util.spec_from_file_location("meta_smoke_test", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


smoke = _load_module()


def _live_key():
    if not REPO_ENV_PATH.exists():
        return None
    return smoke.resolve_key(smoke.load_env_file(str(REPO_ENV_PATH)))


FAKE_USAGE = {
    "prompt_tokens": 13,
    "completion_tokens": 148,
    "total_tokens": 161,
    "completion_tokens_details": {"reasoning_tokens": 138},
}


def _fake_completion_payload(content="OK", finish="stop", usage=None):
    return {
        "model": "muse-spark-1.3",
        "choices": [
            {
                "finish_reason": finish,
                "index": 0,
                "message": {"role": "assistant", "content": content},
            }
        ],
        "usage": FAKE_USAGE if usage is None else usage,
    }


class ParseArgsTests(unittest.TestCase):
    def test_defaults_are_budget_safe(self):
        args = smoke.parse_args([])
        self.assertGreaterEqual(args.max_tokens, 512)
        self.assertEqual(args.max_tokens, smoke.DEFAULT_MAX_TOKENS)
        self.assertEqual(
            args.output,
            str(REPO_ROOT / "docs" / "meta-api-evidence.json"),
        )
        self.assertEqual(args.env, str(REPO_ROOT / ".env"))
        self.assertFalse(args.stdout)
        self.assertEqual(args.base_url, smoke.BASE_URL)

    def test_max_tokens_below_budget_rejected(self):
        for raw in ("8", "128", "511"):
            with self.assertRaises(SystemExit):
                smoke.parse_args(["--max-tokens", raw])

    def test_max_tokens_requires_integer(self):
        with self.assertRaises(SystemExit):
            smoke.parse_args(["--max-tokens", "lots"])

    def test_flags_accepted(self):
        args = smoke.parse_args(
            ["--output", "/tmp/ev.json", "--env", "/tmp/env", "--stdout"]
        )
        self.assertEqual(args.output, "/tmp/ev.json")
        self.assertEqual(args.env, "/tmp/env")
        self.assertTrue(args.stdout)


class LoadEnvTests(unittest.TestCase):
    def test_parses_key_value_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".env"
            path.write_text(
                "# comment line\n"
                "\n"
                "MODEL_API_KEY=abc123\n"
                'QUOTED="quoted-value"\n'
                "DATABASE_URL=postgresql://user:pass@localhost:5432/db?opts=1\n",
                encoding="utf-8",
            )
            env = smoke.load_env_file(str(path))
        self.assertEqual(env["MODEL_API_KEY"], "abc123")
        self.assertEqual(env["QUOTED"], "quoted-value")
        self.assertEqual(
            env["DATABASE_URL"], "postgresql://user:pass@localhost:5432/db?opts=1"
        )

    def test_missing_file_returns_empty(self):
        self.assertEqual(smoke.load_env_file("/nonexistent/.env"), {})

    def test_resolve_key_absent_or_blank(self):
        self.assertIsNone(smoke.resolve_key({"OTHER": "x"}))
        self.assertIsNone(smoke.resolve_key({"MODEL_API_KEY": "   "}))
        self.assertEqual(smoke.resolve_key({"MODEL_API_KEY": "k"}), "k")


class ShapeCompletionTests(unittest.TestCase):
    def test_records_status_latency_usage_and_preview(self):
        step = smoke.shape_completion_evidence(
            200, 1234.5, _fake_completion_payload(), max_tokens=512
        )
        self.assertEqual(step["http_status"], 200)
        self.assertEqual(step["latency_ms"], 1234.5)
        self.assertEqual(step["max_tokens"], 512)
        self.assertEqual(step["finish_reason"], "stop")
        self.assertTrue(step["content_present"])
        self.assertEqual(step["content_preview"], "OK")
        self.assertEqual(
            step["usage"]["completion_tokens_details"]["reasoning_tokens"], 138
        )

    def test_content_preview_truncated(self):
        payload = _fake_completion_payload(content="x" * 1000)
        step = smoke.shape_completion_evidence(200, 10, payload, max_tokens=512)
        self.assertLessEqual(len(step["content_preview"]), smoke.CONTENT_PREVIEW_CHARS)

    def test_null_content_recorded_not_crashing(self):
        payload = _fake_completion_payload(content=None, finish="length")
        step = smoke.shape_completion_evidence(200, 10, payload, max_tokens=8)
        self.assertEqual(step["finish_reason"], "length")
        self.assertFalse(step["content_present"])
        self.assertEqual(step["content_preview"], "")

    def test_missing_usage_tolerated(self):
        payload = _fake_completion_payload(usage={})
        step = smoke.shape_completion_evidence(200, 10, payload, max_tokens=512)
        self.assertEqual(step["usage"], {})


class ShapeModelsTests(unittest.TestCase):
    def test_records_catalog_and_target_presence(self):
        step = smoke.shape_models_evidence(200, 55.0, ["muse-spark-1.3", "sam-3.1"])
        self.assertEqual(step["http_status"], 200)
        self.assertEqual(step["latency_ms"], 55.0)
        self.assertEqual(step["catalog_size"], 2)
        self.assertTrue(step["target_model_present"])

    def test_absent_target_recorded(self):
        step = smoke.shape_models_evidence(200, 55.0, ["other-model"])
        self.assertFalse(step["target_model_present"])


class StepAssertionTests(unittest.TestCase):
    def test_models_assertions_bite(self):
        with self.assertRaises(smoke.SmokeTestError):
            smoke.assert_models_step({"http_status": 500, "target_model_present": True})
        with self.assertRaises(smoke.SmokeTestError):
            smoke.assert_models_step(
                {"http_status": 200, "target_model_present": False}
            )
        smoke.assert_models_step(
            {"http_status": 200, "target_model_present": True}
        )

    def test_completion_assertions_bite(self):
        bad_steps = [
            {"http_status": 429, "content_present": True, "finish_reason": "stop"},
            {"http_status": 200, "content_present": False, "finish_reason": "stop"},
            {
                "http_status": 200,
                "content_present": True,
                "finish_reason": "length",
            },
        ]
        for step in bad_steps:
            with self.assertRaises(smoke.SmokeTestError):
                smoke.assert_completion_step(step)
        smoke.assert_completion_step(
            {"http_status": 200, "content_present": True, "finish_reason": "stop"}
        )


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.models_step = smoke.shape_models_evidence(
            200, 55.0, ["muse-spark-1.3"]
        )
        self.completion_step = smoke.shape_completion_evidence(
            200, 999.9, _fake_completion_payload(), max_tokens=512
        )

    def test_evidence_has_required_fields(self):
        evidence = smoke.build_evidence(
            models_step=self.models_step,
            completion_step=self.completion_step,
            base_url=smoke.BASE_URL,
            model=smoke.TARGET_MODEL,
        )
        for field in ("timestamp", "base_url", "model", "steps"):
            self.assertIn(field, evidence)
        self.assertEqual(evidence["model"], "muse-spark-1.3")
        self.assertIn("latency_ms", evidence["steps"]["models_list"])
        self.assertIn("latency_ms", evidence["steps"]["chat_completion"])
        self.assertIn("usage", evidence["steps"]["chat_completion"])

    def test_serialized_evidence_never_contains_key(self):
        key = "super-secret-key-value"
        evidence = smoke.build_evidence(
            models_step=self.models_step,
            completion_step=self.completion_step,
            base_url=smoke.BASE_URL,
            model=smoke.TARGET_MODEL,
        )
        text = smoke.render_evidence(evidence)
        smoke.assert_no_key_material(text, key)  # must not raise
        self.assertNotIn(key, text)
        with self.assertRaises(SystemExit):
            smoke.assert_no_key_material(json.dumps({"leaked": key}), key)


@unittest.skipUnless(
    _live_key(), "MODEL_API_KEY not available in repo .env; skipping live smoke"
)
class LiveSmokeTests(unittest.TestCase):
    def test_live_models_and_completion(self):
        key = _live_key()
        assert key is not None
        evidence = smoke.run_smoke(
            key=key, base_url=smoke.BASE_URL, max_tokens=smoke.DEFAULT_MAX_TOKENS
        )
        steps = evidence["steps"]
        self.assertEqual(steps["models_list"]["http_status"], 200)
        self.assertTrue(steps["models_list"]["target_model_present"])
        completion = steps["chat_completion"]
        self.assertEqual(completion["http_status"], 200)
        self.assertTrue(completion["content_present"])
        self.assertEqual(completion["finish_reason"], "stop")
        reasoning = (
            completion["usage"].get("completion_tokens_details", {}).get("reasoning_tokens")
        )
        self.assertIsNotNone(reasoning)
        self.assertGreater(reasoning, 0)
        self.assertNotIn(key, json.dumps(evidence))


if __name__ == "__main__":
    unittest.main()
