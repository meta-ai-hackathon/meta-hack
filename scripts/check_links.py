#!/usr/bin/env python3
"""Network link checker for all markdown files. Stdlib only.

Exits 1 on any non-transient failure (4xx except 429, or connection refused).
Run weekly from GitHub Actions (link-check.yml); --offline prints discovered link counts only.
"""

import argparse
import os
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Login-walled URLs already documented as un-extractable in info/links.md
ALLOWLIST_HOST_CONTAINS = ["cerebralvalley.ai"]
ALLOWLIST_PATH_CONTAINS = ["/details"]

LINK_RE = re.compile(r"https?://[^\s)>\"'\]]+")
TIMEOUT = 10
RETRIES = 1

USER_AGENT = "Mozilla/5.0 (compatible; meta-hack-link-checker/1.0)"


def is_transient(status):
    return status in (429, 500, 502, 503, 504) or status == 0


def is_allowlisted(url):
    parsed = urlparse(url)
    return any(host in parsed.netloc for host in ALLOWLIST_HOST_CONTAINS) and any(
        part in parsed.path for part in ALLOWLIST_PATH_CONTAINS
    )


def check_url(url):
    """Return (ok, detail). GET fallback after failed HEAD."""
    headers = {"User-Agent": USER_AGENT}
    last = ""
    for method in ("HEAD", "GET"):
        for attempt in range(RETRIES + 1):
            req = urllib.request.Request(url, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                    if resp.status < 400:
                        return True, f"HTTP {resp.status}"
                    last = f"HTTP {resp.status}"
            except urllib.error.HTTPError as exc:
                last = f"HTTP {exc.code}"
                if not is_transient(exc.code):
                    return False, last
            except Exception as exc:
                last = f"{type(exc).__name__}: {exc}"
    return (not is_allowlisted(url)), last


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="print link counts, skip network")
    args = parser.parse_args()

    failures = []
    for base, dirs, names in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".pytest_cache")]
        for name in names:
            if not name.endswith(".md"):
                continue
            path = os.path.join(base, name)
            rel = os.path.relpath(path, REPO_ROOT)
            with open(path, encoding="utf-8") as f:
                text = f.read()
            urls = sorted(set(LINK_RE.findall(text)))
            if args.offline:
                print(f"{rel}: {len(urls)} http(s) link(s)")
                continue
            bad = []
            for url in urls:
                ok, detail = check_url(url)
                print(f"  {rel} {url} -> {'OK' if ok else 'FAIL ' + detail}")
                if not ok:
                    bad.append((url, detail))
            status = "FAIL" if bad else "PASS"
            print(f"{status} {rel} ({len(urls)} link(s), {len(bad)} failed)")
            failures.extend((rel, url, detail) for url, detail in bad)

    if args.offline:
        print("OFFLINE PASS (no network checks run)")
        return 0

    for rel, url, detail in failures:
        print(f"FAILED: {rel} {url} ({detail})")
    print(f"{'FAIL' if failures else 'PASS'}: {len(failures)} broken link(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
