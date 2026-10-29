#!/usr/bin/env python3
"""Meta Model API smoke test (HACK-18) — proves the model rail is live.

Stdlib only. Two live steps against https://api.meta.ai/v1:
  1. GET  /models -> HTTP 200 with muse-spark-1.3 in the catalog
  2. POST /chat/completions on muse-spark-1.3 with max_tokens >= 512
     (reasoning tokens consume the completion budget) -> HTTP 200,
     non-null content, finish_reason "stop"

Writes evidence JSON (timestamp, model, latency, usage incl. reasoning_tokens,
content preview) to docs/meta-api-evidence.json, or prints it with --stdout.
The MODEL_API_KEY from the repo .env is only used in the Authorization header
and is never printed, logged, or written to evidence.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Sequence

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BASE_URL = "https://api.meta.ai/v1"
TARGET_MODEL = "muse-spark-1.3"
MIN_MAX_TOKENS = 512  # reasoning tokens consume the completion budget
DEFAULT_MAX_TOKENS = 512
DEFAULT_OUTPUT_REL = os.path.join("docs", "meta-api-evidence.json")
CONTENT_PREVIEW_CHARS = 240
HTTP_TIMEOUT_SECONDS = 90
USER_AGENT = "meta-hack-smoke/1.0"


class SmokeTestError(RuntimeError):
    """A smoke-step assertion failed; messages are safe to print."""


# --- env loading (offline logic) -------------------------------------------


def load_env_file(path: str) -> dict[str, str]:
    """Parse a dotenv-style file into a dict; a missing file yields {}."""
    env: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8") as handle:
            lines = handle.readlines()
    except FileNotFoundError:
        return env
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key:
            env[key] = value
    return env


def resolve_key(env: dict[str, str]) -> str | None:
    """The MODEL_API_KEY value, or None when absent/blank."""
    value = env.get("MODEL_API_KEY", "").strip()
    return value or None


# --- CLI --------------------------------------------------------------------


def _max_tokens_value(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"max-tokens must be an integer, got {raw!r}"
        ) from None
    if value < MIN_MAX_TOKENS:
        raise argparse.ArgumentTypeError(
            f"max-tokens must be >= {MIN_MAX_TOKENS} "
            "(reasoning tokens consume the completion budget)"
        )
    return value


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the Meta Model API smoke test (HACK-18).",
    )
    parser.add_argument(
        "--env",
        default=os.path.join(REPO_ROOT, ".env"),
        help="dotenv file holding MODEL_API_KEY (default: repo .env)",
    )
    parser.add_argument(
        "--output",
        default=os.path.join(REPO_ROOT, DEFAULT_OUTPUT_REL),
        help="evidence JSON path (default: docs/meta-api-evidence.json)",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="print the evidence JSON instead of writing the file",
    )
    parser.add_argument(
        "--base-url",
        default=BASE_URL,
        help=f"Meta Model API base URL (default: {BASE_URL})",
    )
    parser.add_argument(
        "--max-tokens",
        type=_max_tokens_value,
        default=DEFAULT_MAX_TOKENS,
        help=(
            f"completion budget (>= {MIN_MAX_TOKENS}; reasoning tokens "
            "count against it)"
        ),
    )
    return parser.parse_args(argv)


# --- evidence shaping (pure, offline logic) ---------------------------------


def shape_models_evidence(
    http_status: int, latency_ms: float, catalog: list[str]
) -> dict[str, Any]:
    return {
        "http_status": http_status,
        "latency_ms": round(latency_ms, 1),
        "catalog_size": len(catalog),
        "target_model_present": TARGET_MODEL in catalog,
    }


def shape_completion_evidence(
    http_status: int,
    latency_ms: float,
    payload: dict[str, Any],
    max_tokens: int,
) -> dict[str, Any]:
    choices = payload.get("choices") or []
    message = (choices[0].get("message") or {}) if choices else {}
    content = message.get("content")
    return {
        "http_status": http_status,
        "latency_ms": round(latency_ms, 1),
        "max_tokens": max_tokens,
        "finish_reason": choices[0].get("finish_reason") if choices else None,
        "content_present": bool(content) and str(content).strip() != "",
        "content_preview": str(content)[:CONTENT_PREVIEW_CHARS] if content else "",
        "usage": payload.get("usage") or {},
    }


def build_evidence(
    models_step: dict[str, Any],
    completion_step: dict[str, Any],
    base_url: str,
    model: str,
) -> dict[str, Any]:
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "base_url": base_url,
        "model": model,
        "steps": {"models_list": models_step, "chat_completion": completion_step},
    }


def render_evidence(evidence: dict[str, Any]) -> str:
    return json.dumps(evidence, indent=2, sort_keys=True) + "\n"


def assert_no_key_material(text: str, key: str) -> None:
    """Last-resort guard: refuse to emit anything containing the key."""
    if key and key in text:
        raise SystemExit(
            "smoke test: refusing to emit evidence containing key material"
        )


# --- step assertions ----------------------------------------------------------


def assert_models_step(
    step: dict[str, Any], target_model: str = TARGET_MODEL
) -> None:
    if step["http_status"] != 200:
        raise SmokeTestError(
            f"models list failed: HTTP {step['http_status']} (expected 200)"
        )
    if not step["target_model_present"]:
        raise SmokeTestError(
            f"models list succeeded but {target_model!r} is not in the catalog"
        )


def assert_completion_step(step: dict[str, Any]) -> None:
    if step["http_status"] != 200:
        raise SmokeTestError(
            f"chat completion failed: HTTP {step['http_status']} (expected 200)"
        )
    if not step["content_present"]:
        raise SmokeTestError(
            "chat completion returned null/empty content "
            f"(raise --max-tokens above {MIN_MAX_TOKENS}: reasoning tokens "
            "consume the completion budget)"
        )
    if step["finish_reason"] != "stop":
        raise SmokeTestError(
            f"chat completion finish_reason is {step['finish_reason']!r} "
            "(expected 'stop')"
        )


# --- network steps ------------------------------------------------------------


def _request_json(
    url: str,
    key: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> tuple[int, Any]:
    headers = {
        "Authorization": f"Bearer {key}",
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            status = response.status
            raw = response.read()
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw = exc.read()
    payload = json.loads(raw.decode("utf-8")) if raw else {}
    return status, payload


def run_models_step(key: str, base_url: str) -> dict[str, Any]:
    started = time.monotonic()
    status, payload = _request_json(f"{base_url}/models", key)
    latency_ms = (time.monotonic() - started) * 1000.0
    catalog = [
        entry.get("id", "")
        for entry in (payload.get("data") or [])
        if isinstance(entry, dict)
    ]
    return shape_models_evidence(status, latency_ms, catalog)


def run_completion_step(key: str, base_url: str, max_tokens: int) -> dict[str, Any]:
    body = {
        "model": TARGET_MODEL,
        "messages": [{"role": "user", "content": "Reply with exactly: OK"}],
        "max_tokens": max_tokens,
    }
    started = time.monotonic()
    status, payload = _request_json(
        f"{base_url}/chat/completions", key, method="POST", body=body
    )
    latency_ms = (time.monotonic() - started) * 1000.0
    return shape_completion_evidence(status, latency_ms, payload, max_tokens=max_tokens)


def run_smoke(
    key: str, base_url: str = BASE_URL, max_tokens: int = DEFAULT_MAX_TOKENS
) -> dict[str, Any]:
    models_step = run_models_step(key, base_url)
    assert_models_step(models_step, TARGET_MODEL)
    completion_step = run_completion_step(key, base_url, max_tokens)
    assert_completion_step(completion_step)
    return build_evidence(models_step, completion_step, base_url, TARGET_MODEL)


# --- entry point ---------------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    key = resolve_key(load_env_file(args.env))
    if key is None:
        print(
            "smoke test: MODEL_API_KEY not found — add it to .env "
            "(see .env.example); live steps require the key",
            file=sys.stderr,
        )
        return 1
    try:
        evidence = run_smoke(key=key, base_url=args.base_url, max_tokens=args.max_tokens)
    except SmokeTestError as exc:
        print(f"smoke test FAIL: {exc}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        # Network-level failure; reason carries no key material (headers are
        # never included in error strings).
        print(f"smoke test FAIL: network error: {exc.reason}", file=sys.stderr)
        return 1
    text = render_evidence(evidence)
    assert_no_key_material(text, key)
    if args.stdout:
        print(text)
    else:
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(text)
        print(f"smoke test: evidence written to {args.output}")
    models = evidence["steps"]["models_list"]
    completion = evidence["steps"]["chat_completion"]
    print(
        f"SMOKE PASS {TARGET_MODEL}: models HTTP {models['http_status']} "
        f"({models['catalog_size']} models), completion HTTP "
        f"{completion['http_status']} finish={completion['finish_reason']} "
        f"in {completion['latency_ms']}ms, "
        f"usage={json.dumps(completion['usage'], sort_keys=True)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
