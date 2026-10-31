"""No real people's details in the repo (HACK-59, BN-37).

AGENTS.md (Legal) keeps real people's information out of this public repo,
so every fixture here is synthetic. The canonical persona is the
walkthrough's "Jamie Watts (fictional)", with the reserved number 555-0100
and the address jamie.watts@example.com (scripts/fixtures/walkthrough/).
This scan keeps the repo that way while a real pilot is under way. It reads
every git-tracked text file and fails on

- an SSN shape: three, two and four digits joined by dashes, or by spaces;
- a NANP phone number outside the fictional 555-0100 to 555-0199 range,
  written with its area code (dashes, dots, spaces or parentheses, with or
  without a leading 1 or +1, or +1 and ten digits) or as a seven-digit
  local number with a dash. A number whose exchange starts with 0 or 1 can
  never ring anyone (the fill-route fixtures use one), so the scan leaves
  it alone;
- an email address outside example.com, example.org and example.net (and
  their subdomains), names under .test and .invalid, and noreply.github.com
  (with its subdomains).

An escaped line break or tab (backslash n, r or t) counts as a space, so a
value right after one inside a string is still found. Lockfiles and binary
files (a binary file type, or a NUL byte) are not read, so a filled form
committed as a PDF, or an audio recording, is not checked here; those stay
synthetic by review.

ALLOWED names each value that is meant to be in a file, and why. A finding
is reported by file, line, column and kind, never by its value, so a real
detail that lands in a commit does not land in the CI log as well.
Property tests plant every kind of value in text and in files, and check
that the scan reports each one where it is, reads only the files it
should, and lets the fictional and reserved values through.
"""

from __future__ import annotations

import re
import string
import subprocess
import tempfile
import unittest
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Final, Iterable

from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

REPO_ROOT = Path(__file__).resolve().parents[1]
THIS_FILE = "tests/test_no_real_pii.py"

# Files the scan does not read by their name: lockfiles (generated, and full
# of hashes) and binary file types. Any other file with a NUL byte in it
# counts as binary too.
LOCKFILE_NAMES: Final = frozenset(
    {
        "pnpm-lock.yaml",
        "package-lock.json",
        "npm-shrinkwrap.json",
        "yarn.lock",
        "bun.lockb",
        "poetry.lock",
        "pipfile.lock",
        "uv.lock",
    }
)
BINARY_SUFFIXES: Final = frozenset(
    {
        ".pdf",
        ".png",
        ".jpg",
        ".jpeg",
        ".gif",
        ".webp",
        ".ico",
        ".wav",
        ".mp3",
        ".m4a",
        ".mp4",
        ".mov",
        ".webm",
        ".zip",
        ".gz",
        ".woff",
        ".woff2",
        ".ttf",
        ".otf",
    }
)

SSN: Final = re.compile(r"(?<![\w-])\d{3}([- ])\d{2}\1\d{4}(?![\w-])")
# A NANP area code or exchange: never 0 or 1 first.
_NXX = r"[2-9]\d{2}"
PHONE: Final = re.compile(
    r"(?<![\w+.-])(?:"
    rf"(?:\+?1[ .-]?)?(?:\({_NXX}\)[ .-]?|{_NXX}[ .-]){_NXX}[ .-]\d{{4}}"
    rf"|\+1{_NXX}{_NXX}\d{{4}}"
    rf"|{_NXX}-\d{{4}}"
    r")(?![\w-])"
)
EMAIL: Final = re.compile(r"(?<![\w.%+-])[A-Za-z0-9._%+-]+@(?P<domain>[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b")
# An escaped line break or tab inside a string literal.
_ESCAPE: Final = re.compile(r"\\[nrt]")

FICTIONAL_EMAIL_DOMAINS: Final = ("example.com", "example.org", "example.net", "noreply.github.com")
FICTIONAL_EMAIL_TLDS: Final = frozenset({"test", "invalid"})

# Each value that is meant to be in a file, and why. This file names each
# value once more, here, so the scan allows every listed value in it too.
ALLOWED: Final[dict[tuple[str, str], str]] = {
    ("tests/test_claude_review.py", "jane.doe@gmail.com"): (
        "The review bot's redactor fixture: an owner comment in a diff, which the bot must redact before the model sees it."
    ),
    ("tests/test_claude_review.py", "hunter2@db.internal"): (
        "The review bot's redactor fixture: the password and host of a made-up database URL, which the bot must redact."
    ),
    ("src/lib/telemetry.test.ts", "123-45-6789"): (
        "The log redactor's fixture: the well-known placeholder SSN, planted to prove a log line never carries it."
    ),
    ("src/lib/telemetry.test.ts", "hunter2@db.internal"): (
        "The log redactor's fixture: the password and host of a made-up database URL inside an error, which a log must never carry."
    ),
}


def fictional_phone(value: str) -> bool:
    """Whether a phone number is in the fictional range: exchange 555, line 0100 to 0199."""
    digits = re.sub(r"\D", "", value)
    return digits[-7:-4] == "555" and 100 <= int(digits[-4:]) <= 199


def fictional_email(domain: str) -> bool:
    """Whether an email's domain is one that never delivers to a person."""
    domain = domain.lower()
    if domain.rsplit(".", 1)[-1] in FICTIONAL_EMAIL_TLDS:
        return True
    return any(domain == known or domain.endswith("." + known) for known in FICTIONAL_EMAIL_DOMAINS)


def find_pii(text: str) -> list[tuple[int, str, str]]:
    """Each real-looking detail in text, in order: where it starts, its kind and its value."""
    text = _ESCAPE.sub("  ", text)
    found = [(match.start(), "ssn", match.group()) for match in SSN.finditer(text)]
    found += [(match.start(), "phone number", match.group()) for match in PHONE.finditer(text) if not fictional_phone(match.group())]
    found += [(match.start(), "email", match.group()) for match in EMAIL.finditer(text) if not fictional_email(match.group("domain"))]
    return sorted(found)


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    column: int
    kind: str
    value: str

    def where(self) -> str:
        """Where the finding is and what kind it is, without its value."""
        return f"{self.path}:{self.line}:{self.column}: {self.kind}"


def read_text(root: Path, path: str) -> str | None:
    """A tracked file's text, or None when the scan does not read it: a
    lockfile, a binary file type or a file with a NUL byte, a symlink, or
    a path that is no file in the working tree."""
    file = root / path
    name = PurePosixPath(path)
    if name.name.lower() in LOCKFILE_NAMES or name.suffix.lower() in BINARY_SUFFIXES:
        return None
    if file.is_symlink() or not file.is_file():
        return None
    data = file.read_bytes()
    if b"\0" in data:
        return None
    return data.decode("utf-8", errors="replace")


def scan(root: Path, paths: Iterable[str]) -> list[Finding]:
    """Every real-looking detail in the files at paths under root."""
    findings: list[Finding] = []
    for path in paths:
        text = read_text(root, path)
        if text is None:
            continue
        for offset, kind, value in find_pii(text):
            line_start = text.rfind("\n", 0, offset) + 1
            findings.append(Finding(path, text.count("\n", 0, offset) + 1, offset - line_start + 1, kind, value))
    return findings


def tracked_files(root: Path) -> list[str]:
    """Every file git tracks under root."""
    listing = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True)
    return [path for path in listing.stdout.decode("utf-8").split("\0") if path]


def allowed(finding: Finding) -> bool:
    """Whether a finding is on the reviewed list."""
    if (finding.path, finding.value) in ALLOWED:
        return True
    return finding.path == THIS_FILE and finding.value in {value for _path, value in ALLOWED}


class RepoScanTests(unittest.TestCase):
    paths: list[str]
    findings: list[Finding]

    @classmethod
    def setUpClass(cls) -> None:
        cls.paths = tracked_files(REPO_ROOT)
        cls.findings = scan(REPO_ROOT, cls.paths)

    def test_no_tracked_file_holds_a_real_looking_detail(self) -> None:
        unexpected = [finding.where() for finding in self.findings if not allowed(finding)]
        self.assertEqual(
            unexpected,
            [],
            "Use a fictional value instead (a number from 555-0100 to 555-0199, an address at example.com), "
            "or, when the value has to be there, add it to ALLOWED with the reason.",
        )

    def test_every_allowed_value_is_still_in_its_file(self) -> None:
        # The list stays short: an entry goes when its value does.
        present = {(finding.path, finding.value) for finding in self.findings}
        self.assertEqual([entry for entry in ALLOWED if entry not in present], [])

    def test_the_scan_reads_the_tracked_text_files_and_skips_the_rest(self) -> None:
        persona = "scripts/fixtures/walkthrough/v2-response-shapes.json"
        self.assertIn(persona, self.paths)
        persona_text = read_text(REPO_ROOT, persona)
        assert persona_text is not None
        # The persona's values are read, and pass as fictional.
        self.assertIn("jamie.watts@example.com", persona_text)
        self.assertIn("555-0100", persona_text)
        self.assertEqual(find_pii(persona_text), [])
        for skipped in ("pnpm-lock.yaml", "src/lib/forms/fixtures/dhb-5200-ia-9-2020.pdf", "specs/fixtures/voice/its-for-myself-16k.wav"):
            self.assertIn(skipped, self.paths)
            self.assertIsNone(read_text(REPO_ROOT, skipped), skipped)

    def test_only_listed_values_pass_and_only_where_listed(self) -> None:
        for (path, value), why in ALLOWED.items():
            self.assertTrue(why)
            kind = find_pii(value)[0][1]
            self.assertTrue(allowed(Finding(path, 1, 1, kind, value)))
            self.assertTrue(allowed(Finding(THIS_FILE, 1, 1, kind, value)))
            self.assertFalse(allowed(Finding("src/lib/other.ts", 1, 1, kind, value)))
        self.assertFalse(allowed(Finding(THIS_FILE, 1, 1, "email", "someone@" + "gmail.com")))


# --- property tests ---------------------------------------------------------------

PBT = settings(database=None, deadline=None, max_examples=150, suppress_health_check=[HealthCheck.too_slow])
# Text around a value: letters and spaces, then one of the marks a value
# stands next to in code or prose, escaped line breaks and tabs included.
FILLER = st.text(alphabet=string.ascii_letters + " ", max_size=20)
MARKS = st.sampled_from([" ", "\n", "\r\n", "\t", "(", ")", '"', "'", "`", ": ", ", ", "=", "<", ">", "[", "]", "\\n", "\\t"])
SURROUNDINGS = st.tuples(FILLER, MARKS, MARKS, FILLER)

SSNS = st.builds(
    lambda area, group, serial, mark: f"{area:03d}{mark}{group:02d}{mark}{serial:04d}",
    st.integers(0, 999),
    st.integers(0, 99),
    st.integers(0, 9999),
    st.sampled_from(["-", " "]),
)
# Phone numbers as (area code, exchange, line), written in every form the scan reads.
AREA_CODES = st.integers(200, 999)
EXCHANGES_BUT_555 = st.integers(200, 998).map(lambda exchange: exchange + (exchange >= 555))
LINES_OUTSIDE_THE_FICTIONAL_RANGE = st.integers(0, 9899).map(lambda line: line + 100 * (line >= 100))
REAL_NUMBERS = st.tuples(AREA_CODES, EXCHANGES_BUT_555, st.integers(0, 9999)) | st.tuples(
    AREA_CODES, st.just(555), LINES_OUTSIDE_THE_FICTIONAL_RANGE
)
FICTIONAL_NUMBERS = st.tuples(AREA_CODES, st.just(555), st.integers(100, 199))
PHONE_FORMS = st.sampled_from(
    [
        "{area}-{exchange}-{line}",
        "{area}.{exchange}.{line}",
        "{area} {exchange} {line}",
        "({area}) {exchange}-{line}",
        "({area}){exchange}-{line}",
        "1-{area}-{exchange}-{line}",
        "1 ({area}) {exchange}-{line}",
        "+1 {area} {exchange} {line}",
        "+1 ({area}) {exchange}-{line}",
        "+1-{area}-{exchange}-{line}",
        "+1{area}{exchange}{line}",
        "{exchange}-{line}",
    ]
)
# Numbers whose exchange starts with 0 or 1, which no phone can have.
IMPOSSIBLE_EXCHANGE_NUMBERS = st.tuples(AREA_CODES, st.integers(0, 199), st.integers(0, 9999))


def phone(number: tuple[int, int, int], form: str) -> str:
    area, exchange, line = number
    return form.format(area=f"{area:03d}", exchange=f"{exchange:03d}", line=f"{line:04d}")


LOCAL_PARTS = st.from_regex(r"[a-z0-9][a-z0-9._%+-]{0,15}", fullmatch=True)
REAL_DOMAINS = st.one_of(
    st.sampled_from(["gmail.com", "outlook.com", "yahoo.com", "icloud.com", "proton.me", "cornell.edu", "dhhs.nc.gov", "github.com"]),
    # Names that only look like the fictional ones.
    st.from_regex(r"[a-z]{1,8}(example|mail)\.(com|org|net|io)", fullmatch=True),
    st.sampled_from(["example.com.mail.net", "test.com", "invalid.org", "example.co", "noreply.github.com.mail.io", "github.com.test.net"]),
)
FICTIONAL_DOMAINS = st.one_of(
    st.builds(
        lambda sub, base: sub + base,
        st.sampled_from(["", "mail.", "users.", "a.b."]),
        st.sampled_from(["example.com", "example.org", "example.net", "Example.Com", "EXAMPLE.NET", "noreply.github.com"]),
    ),
    st.from_regex(r"([a-z]{1,8}\.){0,2}[a-z]{1,8}\.(test|invalid|TEST|Invalid)", fullmatch=True),
)


def surround(value: str, around: tuple[str, str, str, str]) -> str:
    before, left, right, after = around
    return before + left + value + right + after


class FinderProperties(unittest.TestCase):
    @PBT
    @given(SSNS, SURROUNDINGS)
    def test_an_ssn_shape_is_always_found(self, ssn: str, around: tuple[str, str, str, str]) -> None:
        self.assertEqual([(kind, value) for _offset, kind, value in find_pii(surround(ssn, around))], [("ssn", ssn)])

    @PBT
    @given(REAL_NUMBERS, PHONE_FORMS, SURROUNDINGS)
    def test_a_phone_number_outside_the_fictional_range_is_always_found(
        self, number: tuple[int, int, int], form: str, around: tuple[str, str, str, str]
    ) -> None:
        value = phone(number, form)
        self.assertEqual([(kind, found) for _offset, kind, found in find_pii(surround(value, around))], [("phone number", value)])

    @PBT
    @given(FICTIONAL_NUMBERS | IMPOSSIBLE_EXCHANGE_NUMBERS, PHONE_FORMS, SURROUNDINGS)
    def test_fictional_numbers_and_impossible_exchanges_pass(
        self, number: tuple[int, int, int], form: str, around: tuple[str, str, str, str]
    ) -> None:
        self.assertEqual(find_pii(surround(phone(number, form), around)), [])

    @PBT
    @given(LOCAL_PARTS, REAL_DOMAINS, SURROUNDINGS)
    def test_an_email_outside_the_fictional_domains_is_always_found(
        self, local: str, domain: str, around: tuple[str, str, str, str]
    ) -> None:
        value = f"{local}@{domain}"
        self.assertEqual([(kind, found) for _offset, kind, found in find_pii(surround(value, around))], [("email", value)])

    @PBT
    @given(LOCAL_PARTS, FICTIONAL_DOMAINS, SURROUNDINGS)
    def test_an_email_at_a_fictional_domain_passes(self, local: str, domain: str, around: tuple[str, str, str, str]) -> None:
        self.assertEqual(find_pii(surround(f"{local}@{domain}", around)), [])

    @PBT
    @given(
        st.lists(
            st.one_of(SSNS, st.builds(phone, REAL_NUMBERS, PHONE_FORMS), st.builds("{}@{}".format, LOCAL_PARTS, REAL_DOMAINS)),
            min_size=1,
            max_size=4,
        ),
        st.lists(st.sampled_from([".ts", ".md", ".json", ".py", ".txt", ""]), min_size=4, max_size=4),
        st.integers(0, 3),
    )
    def test_a_planted_value_is_found_where_it_is_in_any_text_file_and_never_shown(
        self, values: list[str], suffixes: list[str], blank_lines: int
    ) -> None:
        # Each value on its own line of a tracked text file, after a few
        # other lines; the same values in a lockfile, a binary file type
        # and a file with a NUL byte are not read.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            expected = []
            paths = []
            for index, value in enumerate(values):
                path = f"dir{index}/fixture{index}{suffixes[index]}"
                paths.append(path)
                (root / path).parent.mkdir(parents=True)
                (root / path).write_text("first line\n" + "\n" * blank_lines + f"  value = '{value}'\n", encoding="utf-8")
                kind = find_pii(value)[0][1]
                expected.append((path, 2 + blank_lines, 12, kind, value))
            text = "".join(f"value = '{value}'\n" for value in values)
            for path, data in (
                ("pnpm-lock.yaml", text.encode()),
                ("sub/package-lock.json", text.encode()),
                ("form.pdf", text.encode()),
                ("recording.WAV", text.encode()),
                ("blob.dat", b"\0" + text.encode()),
            ):
                paths.append(path)
                (root / path).parent.mkdir(parents=True, exist_ok=True)
                (root / path).write_bytes(data)
            paths.append("missing/file.ts")
            findings = scan(root, paths)
            self.assertEqual([(f.path, f.line, f.column, f.kind, f.value) for f in findings], expected)
            for finding in findings:
                self.assertNotIn(finding.value, finding.where())
                self.assertFalse(allowed(finding))


if __name__ == "__main__":
    unittest.main()
