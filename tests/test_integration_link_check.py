"""Integration test: the link checker runs offline and exits clean."""

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_link_checker_offline_pass():
    result = subprocess.run(
        [sys.executable, "scripts/check_links.py", "--offline"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS" in result.stdout
