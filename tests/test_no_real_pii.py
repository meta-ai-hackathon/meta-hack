"""No real people's details in the repo (HACK-59, BN-37).

AGENTS.md (Legal) keeps real people's information out of this public repo,
so every fixture here is synthetic. The canonical persona is the
walkthrough's "Jamie Watts (fictional)", with the reserved number 555-0100
and the address jamie.watts@example.com (scripts/fixtures/walkthrough/).
This scan keeps the repo that way while a real pilot is under way. It reads
every git-tracked text file and fails on

- an SSN shape: three, two and four digits joined by dashes, by spaces,
  or by dots when no other dotted number runs on from it, as one would in
  a version.
  The SSA never issues area 000 or 666 or group 00, and no ITIN uses them,
  so a number with one of those can't be anyone's and the scan leaves it
  alone (the fill-route tests use one as a placeholder). Area 900 to 999
  still counts, since ITINs use it;
- a NANP phone number outside the fictional 555-0100 to 555-0199 range,
  written with its area code (dashes, dots, spaces or parentheses, with or
  without a leading 1 or +1, or +1 and ten digits) or as a seven-digit
  local number with a dash. A number whose exchange starts with 0 or 1 can
  never ring anyone (the fill-route fixtures use one), so the scan leaves
  it alone, and so it does a number right after a dollar sign, which is a
  sum of money ($500-2000). Write any other range of plain numbers with
  "to" (300 to 1500), or it reads as a local number;
- the same digits kept bare, the way an app payload or a transcript keeps
  them, after a word that names them on the same line: nine digits after
  "ssn" or "social", ten (maybe after 1 or +1) after "phone", "mobile",
  "tel", "cell" or "fax". The rest of the key after the word (its letters,
  digits and underscores, as in social_security_number, phone2 or
  alt_phone_1) and up to 24 other characters can stand between. The word
  has to start a word or a snake_case part, be a camelCase hump, or follow
  a known word in a key written in one case (homephone, OFFICEFAX,
  spousessn), so "microphone" and "automobile" don't count. A bare number
  with no such word is left alone, since ids and timestamps look the same.
  So is one written right against a key that ends in a digit, since the
  key's digit and the number read as one longer number;
- an email address outside example.com, example.org and example.net (and
  their subdomains), names under the reserved .test, .example, .invalid and
  .localhost, and noreply.github.com (with its subdomains). None of those
  can deliver to a person. The git user of an SSH remote, as in
  git@github.com:org/repo.git or ssh://git@github.com/org/repo.git, names
  a server rather than a person, so it passes. So does an image's file
  name, the way a retina variant is named (logo@2x.png), since no
  top-level domain is an image file type.

An escape inside a string counts as spaces: a line break, a tab or another
control character (backslash n, r, t, b, f or v), and a character written
by its code (backslash x and two hex digits, or backslash u and four), the
way Python's json.dumps writes an em dash, a curly quote or a no-break
space. So a value right after one inside a string is still found, and so is
one right after a regex word boundary. A no-break space or hyphen, and the
other spaces and hyphens that keep a typeset number on one line (the
figure, thin and narrow no-break spaces, the figure dash and the minus
sign), count as the plain ones, so a number pasted from a web page or a PDF
is still found, and its value and digest are written with the plain ones.
An en or em dash still ends a number, since ranges use them. A file saved
as UTF-16 or UTF-32 with its byte order mark is read in that encoding.
Lockfiles and binary file types are not read, so a filled form committed as
a PDF, or an audio recording, is not checked here; those stay synthetic by
review. Any other file with a NUL byte can't be read as text either (UTF-16
saved without its mark, say), so a test fails on it until a person saves it
as UTF-8 or adds its binary type to BINARY_SUFFIXES.

ALLOWED names each value that is meant to be in a file by its kind and its
SHA-256, with a reason that names the test it sits in, so the list doesn't
repeat the value in another file and a reviewer can still find it. The
digest hides nothing: an SSN, a phone number or a common email can be
recovered from it by trying every candidate. Never list a real person's
value, hashed or not. A finding is reported by file, line, column and kind,
never by its value, so a real detail that lands in a commit does not land in
the CI log as well.
Property tests plant every kind of value in text and in files, and check
that the scan reports each one where it is, reads only the files it
should, and lets the fictional and reserved values through.
"""

from __future__ import annotations

import codecs
import hashlib
import json
import re
import string
import subprocess
import tempfile
import unittest
from dataclasses import dataclass, field, replace
from unittest import mock
from pathlib import Path, PurePosixPath
from typing import Final, Iterable

from hypothesis import HealthCheck, assume, given, settings
from hypothesis import strategies as st

REPO_ROOT = Path(__file__).resolve().parents[1]

# Files the scan does not read by their name: lockfiles (generated, and full
# of hashes) and binary file types. Any other file with a NUL byte and no
# UTF-16 or UTF-32 byte order mark can't be read either, and a test fails on
# it so a person looks.
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
# UTF-32 and UTF-16 text holds NUL bytes, so a file that starts with one of
# their byte order marks is read in that encoding. A UTF-32 little-endian
# mark starts with the UTF-16 one, so the UTF-32 marks come first.
TEXT_BYTE_ORDER_MARKS: Final = (
    (codecs.BOM_UTF32_LE, "utf-32"),
    (codecs.BOM_UTF32_BE, "utf-32"),
    (codecs.BOM_UTF16_LE, "utf-16"),
    (codecs.BOM_UTF16_BE, "utf-16"),
)

SSN: Final = re.compile(r"(?<![\w-])\d{3}([- ])\d{2}\1\d{4}(?![\w-])|(?<![\w.-])\d{3}\.\d{2}\.\d{4}(?![\w-]|\.\d)")
# A NANP area code or exchange: never 0 or 1 first.
_NXX = r"[2-9]\d{2}"
PHONE: Final = re.compile(
    r"(?<![\w+.$-])(?:"
    rf"(?:\+?1[ .-]?)?(?:\({_NXX}\)[ .-]?|{_NXX}[ .-]){_NXX}[ .-]\d{{4}}"
    rf"|\+1{_NXX}{_NXX}\d{{4}}"
    rf"|{_NXX}-\d{{4}}"
    r")(?![\w-])"
)
# Bare digits after a word that names them, on the same line. The word
# starts a word or a snake_case part (no letter right before it) or is a
# camelCase hump, and the rest of the key (letters, digits and underscores,
# as in social_security_number or phone_1) is skipped along with it. tel,
# cell and fax must end there or go on as no, num or number, so telemetry,
# cellar and the like don't count. A key written in one case can join a
# known word before the naming word (homephone, OFFICEFAX, spousessn); any
# other letters before it, as in microphone, still don't count.
_NAMED = r"[A-Za-z0-9_]*[^\d\n]{0,24}?"
_PHONE_PREFIXES = "home|work|cell|tele|smart|day|evening|night|alt|other|primary|contact|business|office"
_SSN_PREFIXES = "spouse|member|applicant|child|user|client|primary"
_SSN_WORD = rf"(?:(?<![A-Za-z])(?i:(?:{_SSN_PREFIXES})?(?:ssn|social))|(?<=[a-z])(?:Ssn|SSN|Social))"
_PHONE_WORD = (
    rf"(?:(?<![A-Za-z])(?:(?i:(?:{_PHONE_PREFIXES})?(?:phone|mobile))"
    rf"|(?:{_PHONE_PREFIXES})?(?:tel|cell|fax)(?:no|num|number)?(?![a-z])|(?:Tel|Cell|Fax)(?![a-z])"
    rf"|(?:{_PHONE_PREFIXES.upper()})?(?:TEL|CELL|FAX)(?:NO|NUM|NUMBER)?(?![A-Za-z]))"
    r"|(?<=[a-z])(?:Phone|Mobile|(?:Tel|Cell|Fax)(?![a-z])))"
)
NAMED_SSN: Final = re.compile(rf"{_SSN_WORD}{_NAMED}(?<![\d+])(\d{{9}})(?!\d)")
NAMED_PHONE: Final = re.compile(rf"{_PHONE_WORD}{_NAMED}(?<![\d+])((?:\+?1)?{_NXX}{_NXX}\d{{4}})(?!\d)")
EMAIL: Final = re.compile(r"(?<![\w.%+-])(?P<local>[A-Za-z0-9._%+-]+)@(?P<domain>[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b")
# An escape inside a string literal: a control character (backslash n, r,
# t, b, f or v) or a character written by its code (backslash x and two hex
# digits, or u and four), as Python's json.dumps writes every one outside
# ASCII.
_ESCAPE: Final = re.compile(r"\\(?:[nrtbfv]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})")
# The spaces and hyphens that keep a typeset number on one line, read as the
# plain ones: the no-break, figure, thin and narrow no-break spaces, and the
# hyphen, no-break hyphen, figure dash and minus sign. Each is one character,
# like the one it reads as.
_TYPESET: Final = str.maketrans(
    {chr(code): " " for code in (0x00A0, 0x2007, 0x2009, 0x202F)} | {chr(code): "-" for code in (0x2010, 0x2011, 0x2012, 0x2212)}
)

FICTIONAL_EMAIL_DOMAINS: Final = ("example.com", "example.org", "example.net", "noreply.github.com")
# The names RFC 2606 and RFC 6761 reserve, which no mail ever reaches.
FICTIONAL_EMAIL_TLDS: Final = frozenset({"test", "example", "invalid", "localhost"})
# The file types an image is saved as. None is a top-level domain, so a match
# that ends in one is a file name like logo@2x.png, never an address.
IMAGE_FILE_TYPES: Final = frozenset({"png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "tif", "tiff", "heic"})

# Each value that is meant to be in a file, by the file, the kind and the
# value's SHA-256, and why it is there. The reason names the test the value
# sits in, so a reviewer can check an entry against the file without seeing
# the value here. The digest only avoids a second copy; it does not hide the
# value, so only synthetic or public values belong here.
ALLOWED: Final[dict[tuple[str, str, str], str]] = {
    ("tests/test_claude_review.py", "email", "831f6494ad6be4fcb3a724c3d5fef22d3ceffa3c62ef3a7984e45a0ea177f982"): (
        "In test_withheld_and_redacted_content_never_reaches_the_prompt: the review bot's redactor fixture, an owner's "
        "email in a code comment, at a real mail provider, which the bot must redact before the model sees the diff."
    ),
    ("tests/test_claude_review.py", "email", "5bd07c9b8bab0050610547c944c143dff1221f8e5a6577a55ceb74410352e2f8"): (
        "In test_url_credentials_and_private_keys: the review bot's redactor fixture, the password and host of a made-up "
        "database URL, which the bot must redact."
    ),
    ("src/lib/telemetry.test.ts", "ssn", "01a54629efb952287e554eb23ef69c52097a75aecc0e3a93ca0855ab6d7a31a0"): (
        "In the identity-key tests (\"strips the known identity keys and their common variants\" and \"matches camelCase "
        "spellings and identity aliases\"): the log redactor's fixture, the well-known placeholder SSN, planted to prove a "
        "log line never carries it."
    ),
    ("src/lib/telemetry.test.ts", "email", "5bd07c9b8bab0050610547c944c143dff1221f8e5a6577a55ceb74410352e2f8"): (
        "In \"unknown errors log error_code=internal with zero detail leakage\": the log redactor's fixture, the password and "
        "host of a made-up database URL inside an error, which a log must never carry."
    ),
}


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def fictional_phone(value: str) -> bool:
    """Whether a phone number is in the fictional range: exchange 555, line 0100 to 0199."""
    digits = re.sub(r"\D", "", value)
    return digits[-7:-4] == "555" and 100 <= int(digits[-4:]) <= 199


def issuable_ssn(value: str) -> bool:
    """Whether an SSN shape could be someone's number: never area 000 or 666
    or group 00, which the SSA doesn't issue and no ITIN uses."""
    digits = re.sub(r"\D", "", value)
    return digits[:3] not in ("000", "666") and digits[3:5] != "00"


def fictional_email(domain: str) -> bool:
    """Whether an email's domain is one that never delivers to a person."""
    domain = domain.lower()
    if domain.rsplit(".", 1)[-1] in FICTIONAL_EMAIL_TLDS:
        return True
    return any(domain == known or domain.endswith("." + known) for known in FICTIONAL_EMAIL_DOMAINS)


def ssh_remote(text: str, match: re.Match[str]) -> bool:
    """Whether an email match is the git user and host of an SSH remote, as
    in git@github.com:org/repo.git or ssh://git@github.com/org/repo.git."""
    return match.group("local") == "git" and text[match.end() : match.end() + 1] in (":", "/")


def image_file(domain: str) -> bool:
    """Whether an email match is an image's file name, as in logo@2x.png."""
    return domain.rsplit(".", 1)[-1].lower() in IMAGE_FILE_TYPES


def find_pii(text: str) -> list[tuple[int, str, str]]:
    """Each real-looking detail in text, in order: where it starts, its kind and its value."""
    # Spaces as long as the escape, and a plain space or hyphen for a typeset
    # one, so every offset stays where it was.
    text = _ESCAPE.sub(lambda escape: " " * len(escape.group()), text).translate(_TYPESET)
    found = {(match.start(), "ssn", match.group()) for match in SSN.finditer(text) if issuable_ssn(match.group())}
    found |= {(match.start(1), "ssn", match.group(1)) for match in NAMED_SSN.finditer(text) if issuable_ssn(match.group(1))}
    for pattern, group in ((PHONE, 0), (NAMED_PHONE, 1)):
        found |= {(match.start(group), "phone number", match.group(group)) for match in pattern.finditer(text) if not fictional_phone(match.group(group))}
    found |= {
        (match.start(), "email", match.group())
        for match in EMAIL.finditer(text)
        if not fictional_email(match.group("domain")) and not ssh_remote(text, match) and not image_file(match.group("domain"))
    }
    return sorted(found)


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    column: int
    kind: str
    # Never in the repr, so no test output (pytest -l included) can show it.
    value: str = field(repr=False)

    def where(self) -> str:
        """Where the finding is and what kind it is, without its value."""
        return f"{self.path}:{self.line}:{self.column}: {self.kind}"


def skipped_by_name(path: str) -> bool:
    """Whether the scan leaves a file unread by its name: a lockfile or a binary file type."""
    name = PurePosixPath(path)
    return name.name.lower() in LOCKFILE_NAMES or name.suffix.lower() in BINARY_SUFFIXES


def read_text(root: Path, path: str) -> str | None:
    """A tracked file's text, or None when the scan does not read it: a
    lockfile or a binary file type, a file with a NUL byte and no UTF-16 or
    UTF-32 byte order mark, a symlink, or a path that is no file in the
    working tree."""
    file = root / path
    if skipped_by_name(path) or file.is_symlink() or not file.is_file():
        return None
    data = file.read_bytes()
    for mark, codec in TEXT_BYTE_ORDER_MARKS:
        if data.startswith(mark):
            return data.decode(codec, errors="replace")
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
    return (finding.path, finding.kind, digest(finding.value)) in ALLOWED


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
            "Use a fictional value instead (a number from 555-0100 to 555-0199, an address at example.com), and write "
            'a range of plain numbers with "to" (300 to 1500) so it does not read as a phone number. When a public '
            "value has to be there, like an agency's published number, add (path, kind, digest(value)) to ALLOWED "
            'with a reason that starts with "In " and names the test or entry it sits in. The value is the exact '
            "text find_pii() matches on that line. Look at it on your own machine, since this message never shows it.",
        )

    def test_every_allowed_value_is_still_in_its_file(self) -> None:
        # The list stays short: an entry goes when its value does. Only the
        # allowed findings' digests are kept, so a failure shown with its
        # locals (pytest -l) holds no digest of any other value.
        present = {(finding.path, finding.kind, digest(finding.value)) for finding in self.findings if allowed(finding)}
        self.assertEqual([entry for entry in ALLOWED if entry not in present], [], "Remove each entry whose value left its file.")
        # Every reason says which test the value sits in.
        self.assertEqual([why for why in ALLOWED.values() if not why.startswith("In ")], [])

    def test_every_tracked_text_file_is_read(self) -> None:
        # Only lockfiles and binaries are skipped, so no source, test,
        # fixture or doc goes unread.
        text_suffixes = (".md", ".ts", ".tsx", ".mjs", ".js", ".py", ".json", ".yml", ".yaml", ".sql", ".css", ".txt", ".tsv", ".sh")
        texts = [path for path in self.paths if path.endswith(text_suffixes) and PurePosixPath(path).name.lower() not in LOCKFILE_NAMES]
        self.assertTrue(texts)
        self.assertEqual([path for path in texts if read_text(REPO_ROOT, path) is None], [])

    def test_only_lockfiles_and_binary_file_types_go_unread(self) -> None:
        # Any other tracked file with a NUL byte, such as UTF-16 text saved
        # without its byte order mark, can't be read as text. Save it as
        # UTF-8, or add its binary type to BINARY_SUFFIXES once a person has
        # looked at it.
        files = [path for path in self.paths if not skipped_by_name(path) and (REPO_ROOT / path).is_file() and not (REPO_ROOT / path).is_symlink()]
        self.assertTrue(files)
        self.assertEqual(
            [path for path in files if read_text(REPO_ROOT, path) is None],
            [],
            "These files hold a NUL byte and no UTF-16 or UTF-32 byte order mark, so the scan can't read them. Save "
            "a text file as UTF-8, or add its binary type to BINARY_SUFFIXES once a person has looked at it.",
        )

    def test_a_listed_value_passes_only_where_it_is_listed(self) -> None:
        # The allowed findings are exactly the listed entries, which holds
        # for an empty list too, and an entry of any kind, a published phone
        # number included, passes nothing of another kind.
        listed = [finding for finding in self.findings if allowed(finding)]
        self.assertEqual({(finding.path, finding.kind, digest(finding.value)) for finding in listed}, set(ALLOWED))
        for finding in listed:
            self.assertFalse(allowed(replace(finding, path="src/lib/other.ts")))
            self.assertFalse(allowed(replace(finding, value=finding.value + "0")))
            for kind in {"ssn", "phone number", "email"} - {finding.kind}:
                self.assertFalse(allowed(replace(finding, kind=kind)))


# --- property tests ---------------------------------------------------------------

PBT = settings(database=None, deadline=None, max_examples=150, suppress_health_check=[HealthCheck.too_slow])
# Text around a value: letters and spaces, then one of the marks a value
# stands next to in code or prose, escapes included (a line break, a tab, a
# regex word boundary, a form feed, and a no-break space or a curly quote
# written by its code).
FILLER = st.text(alphabet=string.ascii_letters + " ", max_size=20)
MARKS = st.sampled_from(
    [" ", "\n", "\r\n", "\t", "(", ")", '"', "'", "`", ": ", ", ", "=", "<", ">", "[", "]", "\\n", "\\t", "\\b", "\\f", "\\xa0", "\\u201c"]
)
SURROUNDINGS = st.tuples(FILLER, MARKS, MARKS, FILLER)
# Punctuation outside ASCII that a transcript puts right next to a value
# (dashes, curly quotes, a no-break space, an ellipsis, guillemets), which
# Python's json.dumps writes only as an escape.
WIDE_MARKS = st.sampled_from([chr(code) for code in (0x2014, 0x2013, 0x201C, 0x201D, 0x2019, 0x00A0, 0x2026, 0x00AB, 0x00BB)])
# The spaces and hyphens that keep a typeset number on one line.
TYPESET_SPACES = st.sampled_from([chr(code) for code in (0x00A0, 0x2007, 0x2009, 0x202F)])
TYPESET_HYPHENS = st.sampled_from([chr(code) for code in (0x2010, 0x2011, 0x2012, 0x2212)])

# SSNs as (area, group, serial): any the SSA could issue (area 900 to 999
# included, which ITINs use), and the shapes it never issues.
ISSUABLE_SSN_PARTS = st.tuples(st.integers(1, 998).map(lambda area: area + (area >= 666)), st.integers(1, 99), st.integers(0, 9999))
NEVER_ISSUED_SSN_PARTS = st.tuples(st.sampled_from([0, 666]), st.integers(0, 99), st.integers(0, 9999)) | st.tuples(
    st.integers(0, 999), st.just(0), st.integers(0, 9999)
)
SSN_MARKS = st.sampled_from(["-", " ", "."])


def ssn(parts: tuple[int, int, int], mark: str) -> str:
    area, group, serial = parts
    return f"{area:03d}{mark}{group:02d}{mark}{serial:04d}"


SSNS = st.builds(ssn, ISSUABLE_SSN_PARTS, SSN_MARKS)
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


MONEY_RANGES = st.builds(lambda low, high: f"${low}-{high}", st.integers(200, 999), st.integers(1000, 9999))
# Bare digits after a word that names them, as a payload or a transcript
# keeps them: the word, what stands between, and the digits.
SSN_WORD_LIST: Final = (
    "ssn",
    "SSN",
    "ssn_full",
    "user_ssn",
    "userSSN",
    "ssn_2",
    "spouseSsn1",
    "spousessn",
    "APPLICANTSSN",
    "social",
    "Social Security",
    "social_security_number",
    "socialSecurityNumber",
)
PHONE_WORD_LIST: Final = (
    "phone",
    "Phone",
    "PHONE",
    "phone_contact",
    "contactPhone",
    "home_phone",
    "phone2",
    "phone_1",
    "alt_phone_1",
    "mobile2Number",
    "cellphone",
    "telephone",
    "homephone",
    "WORKPHONE",
    "altphone",
    "tel",
    "TEL",
    "telNumber",
    "TEL_NUMBER",
    "telno",
    "TELNUM",
    "mobile",
    "workMobile",
    "cell",
    "fax",
    "office_fax",
    "officefax",
    "HOMEFAX",
    "faxnumber",
    "FAX_2",
)
SSN_WORDS = st.sampled_from(SSN_WORD_LIST)
PHONE_WORDS = st.sampled_from(PHONE_WORD_LIST)
NAMED_GAPS = st.sampled_from(["", " ", ": ", "=", '": "', "': '", '":"', " = '", ", ", " is ", " number is ", " (home) "])
BARE_SSNS = st.builds(ssn, ISSUABLE_SSN_PARTS, st.just(""))
NINE_DIGITS = st.integers(0, 999_999_999).map("{:09d}".format)
BARE_PREFIXES = st.sampled_from(["", "1", "+1"])
# Words that name no such value, some of them only looking like one, and
# filler that can't spell one.
OTHER_WORD_LIST: Final = (
    "id",
    "count",
    "total",
    "amount",
    "zip",
    "page",
    "timestamp",
    "version",
    "telemetry",
    "TELEMETRY",
    "hotel",
    "cancelled",
    "Fairfax",
    "microphone",
    "MICROPHONE",
    "headphone",
    "saxophone",
    "automobile",
    "antisocial",
    "assn",
    "telnet",
    "cellular",
    "CELLULAR",
    "faxes",
)
OTHER_WORDS = st.sampled_from(OTHER_WORD_LIST)
KEYLESS_FILLER = st.text(alphabet="dgjkqruvwyz ", max_size=20)


LOCAL_PARTS = st.from_regex(r"[a-z0-9][a-z0-9._%+-]{0,15}", fullmatch=True)
REAL_DOMAINS = st.one_of(
    st.sampled_from(["gmail.com", "outlook.com", "yahoo.com", "icloud.com", "proton.me", "cornell.edu", "dhhs.nc.gov", "github.com"]),
    # Names that only look like the fictional ones.
    st.from_regex(r"[a-z]{1,8}(example|mail)\.(com|org|net|io)", fullmatch=True),
    st.sampled_from(
        ["example.com.mail.net", "test.com", "invalid.org", "example.co", "localhost.net", "mail.contest", "noreply.github.com.mail.io", "github.com.test.net"]
    ),
    # Names that only look like an image's file name.
    st.sampled_from(["2x.com", "img.png.io", "photos.jpg.net"]),
)
# Image file names the way a retina variant is named: a name, a density and
# an image file type, in any letter case.
IMAGE_NAMES = st.builds(
    "{}@{}x.{}".format,
    st.from_regex(r"[a-z][a-z0-9_-]{0,12}", fullmatch=True),
    st.sampled_from(["1", "1.5", "2", "3", "4"]),
    st.sampled_from(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp", "tif", "tiff", "heic", "PNG", "Jpg", "WEBP"]),
)
FICTIONAL_DOMAINS = st.one_of(
    st.builds(
        lambda sub, base: sub + base,
        st.sampled_from(["", "mail.", "users.", "a.b."]),
        st.sampled_from(["example.com", "example.org", "example.net", "Example.Com", "EXAMPLE.NET", "noreply.github.com"]),
    ),
    st.from_regex(r"([a-z]{1,8}\.){0,2}[a-z]{1,8}\.(test|example|invalid|localhost|TEST|Example|Invalid|LOCALHOST)", fullmatch=True),
)
# SSH remotes in the forms git and package manifests write them, with a
# repo path that holds no other value.
SSH_REMOTE_FORMS = st.sampled_from(
    [
        "git@{host}:{path}.git",
        "ssh://git@{host}/{path}.git",
        "ssh://git@{host}:22/{path}.git",
        "git+ssh://git@{host}/{path}.git",
        "git+ssh://git@{host}:{path}.git",
    ]
)
REPO_PATHS = st.from_regex(r"[a-z]{1,10}/[a-z][a-z-]{0,12}", fullmatch=True)


def surround(value: str, around: tuple[str, str, str, str]) -> str:
    before, left, right, after = around
    return before + left + value + right + after


# The ways a text file can be saved that the scan still reads: UTF-8 with or
# without its mark, and UTF-16 or UTF-32 in either byte order with theirs.
ENCODINGS = st.sampled_from(["utf-8", "utf-8-sig", "utf-16-le", "utf-16-be", "utf-32-le", "utf-32-be"])
_MARK_FOR: Final = {
    "utf-16-le": codecs.BOM_UTF16_LE,
    "utf-16-be": codecs.BOM_UTF16_BE,
    "utf-32-le": codecs.BOM_UTF32_LE,
    "utf-32-be": codecs.BOM_UTF32_BE,
}


def saved(text: str, encoding: str) -> bytes:
    """text as a file saved in encoding, with its byte order mark."""
    return _MARK_FOR.get(encoding, b"") + text.encode(encoding)


class FinderProperties(unittest.TestCase):
    @PBT
    @given(SSNS, SURROUNDINGS)
    def test_an_ssn_shape_that_could_be_issued_is_always_found(self, value: str, around: tuple[str, str, str, str]) -> None:
        self.assertEqual([(kind, found) for _offset, kind, found in find_pii(surround(value, around))], [("ssn", value)])

    @PBT
    @given(NEVER_ISSUED_SSN_PARTS, SSN_MARKS, SSN_WORDS, NAMED_GAPS, SURROUNDINGS)
    def test_an_ssn_the_ssa_never_issues_passes(
        self, parts: tuple[int, int, int], mark: str, word: str, gap: str, around: tuple[str, str, str, str]
    ) -> None:
        # Written as an SSN, or kept bare after a word that names it.
        assume(gap or not word[-1].isdigit())
        for text in (ssn(parts, mark), word + gap + ssn(parts, "")):
            self.assertEqual(find_pii(surround(text, around)), [])

    @PBT
    @given(ISSUABLE_SSN_PARTS, st.integers(0, 9999), st.booleans(), SURROUNDINGS)
    def test_a_longer_dotted_number_is_no_ssn(self, parts: tuple[int, int, int], other: int, first: bool, around: tuple[str, str, str, str]) -> None:
        # A version or an address, with another dotted number before or after.
        value = ssn(parts, ".")
        self.assertEqual(find_pii(surround(f"{other}.{value}" if first else f"{value}.{other}", around)), [])

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
    @given(st.one_of(SSNS, st.builds(phone, REAL_NUMBERS, PHONE_FORMS)), TYPESET_SPACES, TYPESET_HYPHENS, SURROUNDINGS)
    def test_a_typeset_number_is_found_like_the_plain_one(
        self, value: str, space: str, hyphen: str, around: tuple[str, str, str, str]
    ) -> None:
        # Pasted from a web page or a PDF with each space or hyphen in it
        # typeset, it is found where the plain one is, as the plain value.
        plain = find_pii(surround(value, around))
        self.assertTrue(plain)
        self.assertEqual(find_pii(surround(value.replace(" ", space).replace("-", hyphen), around)), plain)

    @PBT
    @given(MONEY_RANGES, SURROUNDINGS)
    def test_a_sum_of_money_is_no_phone_number(self, money: str, around: tuple[str, str, str, str]) -> None:
        self.assertEqual(find_pii(surround(money + "/month", around)), [])

    @PBT
    @given(SSN_WORDS, NAMED_GAPS, BARE_SSNS, SURROUNDINGS)
    def test_bare_ssn_digits_after_a_word_that_names_them_are_found(
        self, word: str, gap: str, digits: str, around: tuple[str, str, str, str]
    ) -> None:
        # A key that ends in a digit, right against the digits, reads as
        # one longer number.
        assume(gap or not word[-1].isdigit())
        found = [(kind, value) for _offset, kind, value in find_pii(surround(word + gap + digits, around))]
        self.assertEqual(found, [("ssn", digits)])

    @PBT
    @given(PHONE_WORDS, NAMED_GAPS, BARE_PREFIXES, REAL_NUMBERS | FICTIONAL_NUMBERS, SURROUNDINGS)
    def test_bare_phone_digits_after_a_word_that_names_them_are_found_unless_fictional(
        self, word: str, gap: str, prefix: str, number: tuple[int, int, int], around: tuple[str, str, str, str]
    ) -> None:
        assume(gap or not word[-1].isdigit())
        digits = prefix + phone(number, "{area}{exchange}{line}")
        found = [(kind, value) for _offset, kind, value in find_pii(surround(word + gap + digits, around))]
        self.assertEqual(found, [] if fictional_phone(digits) else [("phone number", digits)])

    @PBT
    @given(KEYLESS_FILLER, OTHER_WORDS, NAMED_GAPS, NINE_DIGITS | st.builds(phone, REAL_NUMBERS, st.just("{area}{exchange}{line}")))
    def test_bare_numbers_without_such_a_word_pass(self, before: str, word: str, gap: str, digits: str) -> None:
        # Ids, counts and timestamps look like bare digits too, and so do
        # words that only contain a key word, standing on their own.
        self.assertEqual(find_pii(before + " " + word + gap + digits), [])

    def test_every_listed_word_names_bare_digits_or_not(self) -> None:
        # Each word once, so none of them rests on what a run happens to draw.
        bare = {"ssn": ssn((234, 56, 7890), ""), "phone number": phone((704, 234, 5678), "{area}{exchange}{line}")}
        for kind, words in (("ssn", SSN_WORD_LIST), ("phone number", PHONE_WORD_LIST)):
            for word in words:
                with self.subTest(word=word):
                    self.assertEqual([(found, value) for _offset, found, value in find_pii(f"{word}: {bare[kind]}")], [(kind, bare[kind])])
        for word in OTHER_WORD_LIST:
            for value in bare.values():
                with self.subTest(word=word):
                    self.assertEqual(find_pii(f"{word}: {value}"), [])

    @PBT
    @given(LOCAL_PARTS, REAL_DOMAINS, SURROUNDINGS)
    def test_an_email_outside_the_fictional_domains_is_always_found(
        self, local: str, domain: str, around: tuple[str, str, str, str]
    ) -> None:
        # git@ right before a colon is an SSH remote, tested below.
        assume(not (local == "git" and around[2].startswith(":")))
        value = f"{local}@{domain}"
        self.assertEqual([(kind, found) for _offset, kind, found in find_pii(surround(value, around))], [("email", value)])

    @PBT
    @given(LOCAL_PARTS, FICTIONAL_DOMAINS, SURROUNDINGS)
    def test_an_email_at_a_fictional_domain_passes(self, local: str, domain: str, around: tuple[str, str, str, str]) -> None:
        self.assertEqual(find_pii(surround(f"{local}@{domain}", around)), [])

    @PBT
    @given(IMAGE_NAMES, SURROUNDINGS)
    def test_an_image_file_name_is_no_email(self, name: str, around: tuple[str, str, str, str]) -> None:
        # As in an import of ./logo@2x.png or a srcSet entry.
        self.assertEqual(find_pii(surround(name, around)), [])

    @PBT
    @given(SSH_REMOTE_FORMS, REAL_DOMAINS, REPO_PATHS, SURROUNDINGS)
    def test_the_git_user_of_an_ssh_remote_passes(self, form: str, host: str, path: str, around: tuple[str, str, str, str]) -> None:
        self.assertEqual(find_pii(surround(form.format(host=host, path=path), around)), [])

    @PBT
    @given(LOCAL_PARTS.filter(lambda local: local != "git"), REAL_DOMAINS, st.sampled_from([":", "/"]), REPO_PATHS, SURROUNDINGS)
    def test_another_user_before_a_colon_or_a_slash_is_still_an_email(
        self, local: str, host: str, follow: str, path: str, around: tuple[str, str, str, str]
    ) -> None:
        value = f"{local}@{host}"
        found = find_pii(surround(value + follow + path, around))
        self.assertEqual([(kind, email) for _offset, kind, email in found], [("email", value)])

    @PBT
    @given(REAL_DOMAINS, SURROUNDINGS)
    def test_the_git_user_before_anything_else_is_still_an_email(self, host: str, around: tuple[str, str, str, str]) -> None:
        # At the end of the text too.
        assume(not around[2].startswith(":"))
        value = f"git@{host}"
        for text in (surround(value, around), value):
            self.assertEqual([(kind, email) for _offset, kind, email in find_pii(text)], [("email", value)])

    @PBT
    @given(st.one_of(SSNS, st.builds(phone, REAL_NUMBERS, PHONE_FORMS), st.builds("{}@{}".format, LOCAL_PARTS, REAL_DOMAINS)))
    def test_the_listed_value_check_holds_for_an_entry_of_any_kind(self, value: str) -> None:
        # The repo check run on a list that holds one entry of the value's
        # kind, like an agency's published phone number in kb/.
        finding = Finding("kb/entries/fixture.json", 1, 1, find_pii(value)[0][1], value)
        checks = RepoScanTests("test_a_listed_value_passes_only_where_it_is_listed")
        checks.findings = [finding]
        with mock.patch.dict(ALLOWED, {(finding.path, finding.kind, digest(value)): "In a fixture."}, clear=True):
            checks.test_a_listed_value_passes_only_where_it_is_listed()

    @PBT
    @given(
        st.one_of(SSNS, st.builds(phone, REAL_NUMBERS, PHONE_FORMS), st.builds("{}@{}".format, LOCAL_PARTS, REAL_DOMAINS)),
        FILLER,
        WIDE_MARKS,
        WIDE_MARKS,
        FILLER,
    )
    def test_a_value_next_to_punctuation_is_found_in_json_that_escapes_it(
        self, value: str, before: str, left: str, right: str, after: str
    ) -> None:
        # The same text as it is, and as json.dumps saves it, alone or inside
        # a payload, where each mark is only an escape.
        expected = [(kind, found) for _offset, kind, found in find_pii(value)]
        self.assertTrue(expected)
        text = before + left + value + right + after
        for written in (text, json.dumps(text), json.dumps({"turns": [{"text": text}]})):
            self.assertEqual([(kind, found) for _offset, kind, found in find_pii(written)], expected)

    @PBT
    @given(
        st.lists(
            st.one_of(SSNS, st.builds(phone, REAL_NUMBERS, PHONE_FORMS), st.builds("{}@{}".format, LOCAL_PARTS, REAL_DOMAINS)),
            min_size=1,
            max_size=4,
        ),
        st.lists(st.sampled_from([".ts", ".md", ".json", ".py", ".txt", ""]), min_size=4, max_size=4),
        st.lists(ENCODINGS, min_size=4, max_size=4),
        st.integers(0, 3),
        st.sampled_from(["", "\\n", "\\xa0", "\\u2014"]),
    )
    def test_a_planted_value_is_found_where_it_is_in_any_text_file_and_never_shown(
        self, values: list[str], suffixes: list[str], encodings: list[str], blank_lines: int, escape: str
    ) -> None:
        # Each value on its own line of a tracked text file, saved in any
        # encoding the scan reads, after a few other lines and maybe an
        # escape, which moves its column by the escape's length; the same
        # values in a lockfile, a binary file type, a file with a NUL byte
        # and UTF-16 without its mark are not read.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            expected = []
            paths = []
            for index, value in enumerate(values):
                path = f"dir{index}/fixture{index}{suffixes[index]}"
                paths.append(path)
                (root / path).parent.mkdir(parents=True)
                line = f"  value = '{escape}{value}'\n"
                (root / path).write_bytes(saved("first line\n" + "\n" * blank_lines + line, encodings[index]))
                kind = find_pii(value)[0][1]
                expected.append((path, 2 + blank_lines, 12 + len(escape), kind, value))
            text = "".join(f"value = '{value}'\n" for value in values)
            for path, data in (
                ("pnpm-lock.yaml", text.encode()),
                ("sub/package-lock.json", text.encode()),
                ("form.pdf", text.encode()),
                ("recording.WAV", text.encode()),
                ("blob.dat", b"\0" + text.encode()),
                ("transcript.csv", text.encode("utf-16-le")),
            ):
                paths.append(path)
                (root / path).parent.mkdir(parents=True, exist_ok=True)
                (root / path).write_bytes(data)
            paths.append("missing/file.ts")
            findings = scan(root, paths)
            self.assertEqual([(f.path, f.line, f.column, f.kind, f.value) for f in findings], expected)
            for finding in findings:
                self.assertNotIn(finding.value, finding.where())
                self.assertNotIn(finding.value, repr(finding))
                self.assertFalse(allowed(finding))


if __name__ == "__main__":
    unittest.main()
