"""Repo markdown checks: Obsidian syntax, relative links, README map, leaderboard."""

import os
import re
import unittest
from urllib.parse import unquote

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def repo_files():
    result = []
    for base, dirs, names in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".pytest_cache", "node_modules")]
        for name in names:
            if name.endswith(".md"):
                result.append(os.path.join(base, name))
    return result


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def outside_code_blocks(text):
    """Yield lines of text that are not inside fenced code blocks."""
    in_fence = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            yield line


class TestRepoMarkdown(unittest.TestCase):
    def test_no_obsidian_syntax(self):
        pattern = re.compile(r"==[^=\n]+==|\[\[[^\]\n]+\]\]")
        for path in repo_files():
            rel = os.path.relpath(path, REPO_ROOT)
            if rel.replace(os.sep, "/") == "skills/evaluate-idea/SKILL.md":
                lines = list(outside_code_blocks(read(path)))
            else:
                lines = read(path).splitlines()
            # inline code spans mention syntax by name, not use it
            offenders = [l for l in lines if pattern.search(re.sub(r"`[^`]*`", "", l))]
            self.assertEqual(offenders, [], f"{rel}: Obsidian-only syntax found")

    def test_relative_links_resolve(self):
        link = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
        for path in repo_files():
            text = read(path)
            base = os.path.dirname(path)
            for target in link.findall(text):
                if target.startswith(("http://", "https://", "mailto:", "#")):
                    continue
                target = unquote(target.split("#", 1)[0])
                if not target:
                    continue
                self.assertTrue(
                    os.path.exists(os.path.join(base, target)),
                    f"{os.path.relpath(path, REPO_ROOT)}: broken link -> {target}",
                )

    def test_readme_repo_map_paths_exist(self):
        rows = re.findall(r"^\| `([^`]+)` \|", read(os.path.join(REPO_ROOT, "README.md")), re.M)
        self.assertTrue(rows, "README repo map table not found")
        for row in rows:
            self.assertTrue(
                os.path.exists(os.path.join(REPO_ROOT, row.replace("/", os.sep))),
                f"README repo map path missing on disk: {row}",
            )

    def test_leaderboard_rows_consistent(self):
        path = os.path.join(REPO_ROOT, "ideas", "evaluated.md")
        table = []
        for line in read(path).splitlines():
            cells = line.strip().strip("|").split("|") if line.strip().startswith("|") else None
            if cells is not None:
                table.append([c.strip() for c in cells])
        header = next(i for i, cells in enumerate(table) if cells[0] == "Idea")
        width = len(table[header])
        for cells in table[header + 1:]:
            if all(re.fullmatch(r":?-+:?", c) for c in cells if c != ""):
                continue  # delimiter row
            self.assertEqual(len(cells), width, f"row width mismatch: {cells}")
            weighted = cells[5].replace("≈", "").replace("**", "").strip()
            self.assertIsInstance(float(weighted), float, f"bad weighted value: {cells[5]}")


if __name__ == "__main__":
    unittest.main()
