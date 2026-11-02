"""Checks over the committed BN-38 evaluation record (HACK-60).

docs/evaluation-record.md is the output of scripts/eval-record.mjs. These
checks read it the way a reviewer would: it states its denominator, every
count row adds up (each category to its case count, the columns to the All
cases row, and that row to the denominator), the negatives section exists,
says "0 of N" outright when nothing went wrong and otherwise lists exactly as
many cases as the counts say are wrong, missed or over-refused, the not run
section agrees with its column, and the Nov 2 pilot section holds no data.
Every case's own outcome in the every case table also has to agree with the
counts and with exactly which cases the negatives and not run tables list.
The property tests change one number, one listed case or one outcome at a
time and check that the checker catches it, so a record whose numbers do
not add up can never pass.
"""

from __future__ import annotations

import re
import unittest
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from hypothesis import given, settings
from hypothesis import strategies as st

RECORD: Final = Path(__file__).resolve().parents[1] / "docs" / "evaluation-record.md"

OUTCOMES: Final = ("Right", "Wrong", "Missed", "Refused correctly", "Over-refused", "Not run")
NEGATIVE_OUTCOMES: Final = ("Wrong", "Missed", "Over-refused")
COUNTS_HEADER: Final = "| Category | Cases | " + " | ".join(OUTCOMES) + " |"
CATEGORIES: Final = ("Answer turns", "Should-refuse probes", "Should-answer probes")


@dataclass(frozen=True)
class CountsRow:
    label: str
    cases: int
    outcomes: dict[str, int]


def section(text: str, heading: str) -> str | None:
    """The body of one `## heading` section, or None when it is missing."""
    match = re.search(rf"^## {re.escape(heading)}\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    return match.group(1) if match else None


def denominator(text: str) -> int | None:
    match = re.search(r"^\| Denominator \| (\d+) cases? \|$", text, re.M)
    return int(match.group(1)) if match else None


def counts_rows(text: str) -> list[CountsRow] | None:
    """The rows of the counts table, or None when the table is missing or malformed."""
    lines = text.splitlines()
    if COUNTS_HEADER not in lines:
        return None
    rows: list[CountsRow] = []
    for line in lines[lines.index(COUNTS_HEADER) + 2 :]:
        if not line.startswith("| "):
            break
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) != 2 + len(OUTCOMES) or not all(cell.isdigit() for cell in cells[1:]):
            return None
        rows.append(CountsRow(cells[0], int(cells[1]), dict(zip(OUTCOMES, (int(cell) for cell in cells[2:])))))
    return rows


def table_case_ids(body: str) -> list[str]:
    return re.findall(r"^\| `([^`]+)` \|", body, re.M)


def table_cells(line: str) -> list[str]:
    """A table row's cells, split on the pipes no backslash escapes."""
    return [cell.strip() for cell in re.split(r"(?<!\\)\|", line.strip())[1:-1]]


def case_rows(body: str) -> list[list[str]]:
    """The cells of every row in a section's case table."""
    return [table_cells(line) for line in body.splitlines() if line.startswith("| `")]


def outcome_label(cell: str) -> str:
    """An Outcome cell without its note, as in "Right (answered from an earlier turn)"."""
    return cell.split(" (", 1)[0]


def check_record(text: str) -> list[str]:
    """Every way the record fails to state and add up its own numbers."""
    problems: list[str] = []
    total = denominator(text)
    if total is None:
        return ["no denominator row in the run table"]
    rows = counts_rows(text)
    if rows is None:
        return ["no well-formed counts table"]
    labels = [row.label for row in rows]
    if labels != [*CATEGORIES, "All cases"]:
        return [f"counts table rows are {labels}"]
    *categories, overall = rows
    for row in rows:
        if sum(row.outcomes.values()) != row.cases:
            problems.append(f"{row.label}: outcomes add up to {sum(row.outcomes.values())}, not {row.cases}")
    if overall.cases != total:
        problems.append(f"All cases says {overall.cases} cases, the denominator is {total}")
    if sum(row.cases for row in categories) != total:
        problems.append("the categories' case counts do not add up to the denominator")
    for outcome in OUTCOMES:
        if sum(row.outcomes[outcome] for row in categories) != overall.outcomes[outcome]:
            problems.append(f"{outcome}: the categories do not add up to the All cases row")

    negatives = section(text, "Negatives")
    expected_negatives = sum(overall.outcomes[outcome] for outcome in NEGATIVE_OUTCOMES)
    if negatives is None:
        problems.append("no negatives section")
    else:
        line = re.search(r"^Negatives: (\d+) of (\d+) cases\.$", negatives, re.M)
        listed = table_case_ids(negatives)
        if line is None:
            problems.append("the negatives section does not say how many of the denominator are negative")
        elif (int(line.group(1)), int(line.group(2))) != (expected_negatives, total):
            problems.append(f"the negatives line says {line.group(0)!r}, the counts say {expected_negatives} of {total}")
        if len(listed) != expected_negatives or len(set(listed)) != len(listed):
            problems.append(f"the negatives table lists {len(listed)} cases, the counts say {expected_negatives}")
        if expected_negatives == 0 and f"Negatives: 0 of {total} cases." not in negatives:
            problems.append("an empty negatives section must say 0 of N outright")

    not_run = section(text, "Not run")
    if not_run is None:
        problems.append("no not run section")
    else:
        line = re.search(r"^Not run: (\d+) of (\d+) cases\.$", not_run, re.M)
        if line is None or (int(line.group(1)), int(line.group(2))) != (overall.outcomes["Not run"], total):
            problems.append("the not run line does not match the counts")
        if len(table_case_ids(not_run)) != overall.outcomes["Not run"]:
            problems.append("the not run table does not list every not run case")

    every_case = section(text, "Every case")
    if every_case is None or len(table_case_ids(every_case)) != total:
        problems.append("the every case table does not list the denominator's cases")
        return problems
    # Every case's own outcome has to agree with the counts and with the
    # negatives and not run tables, so a swapped id or an edited cell can't
    # hide behind totals that still add up.
    outcomes = {row[0].strip("`"): outcome_label(row[-1]) for row in case_rows(every_case)}
    for outcome in OUTCOMES:
        listed_with = sum(1 for label in outcomes.values() if label == outcome)
        if listed_with != overall.outcomes[outcome]:
            problems.append(f"{outcome}: the every case table lists {listed_with}, the counts say {overall.outcomes[outcome]}")
    if negatives is not None:
        expected_rows = {case: label for case, label in outcomes.items() if label in NEGATIVE_OUTCOMES}
        listed_rows = {row[0].strip("`"): row[2] for row in case_rows(negatives) if len(row) >= 3}
        if listed_rows != expected_rows:
            problems.append("the negatives table does not list exactly the wrong, missed and over-refused cases")
    if not_run is not None:
        expected_ids = sorted(case for case, label in outcomes.items() if label == "Not run")
        if sorted(table_case_ids(not_run)) != expected_ids:
            problems.append("the not run table does not list exactly the not run cases")
    return problems


def read_record() -> str:
    return RECORD.read_text(encoding="utf-8")


class EvaluationRecordTests(unittest.TestCase):
    def test_the_record_states_its_denominator(self) -> None:
        total = denominator(read_record())
        self.assertIsNotNone(total, "the run table needs a | Denominator | N cases | row")
        assert total is not None
        self.assertGreater(total, 0)

    def test_the_counts_add_up_and_every_negative_is_listed(self) -> None:
        self.assertEqual(check_record(read_record()), [])

    def test_the_negatives_section_says_0_of_n_when_it_is_empty(self) -> None:
        text = read_record()
        negatives = section(text, "Negatives")
        self.assertIsNotNone(negatives)
        assert negatives is not None
        if not table_case_ids(negatives):
            self.assertIn(f"Negatives: 0 of {denominator(text)} cases.", negatives)

    def test_the_pilot_section_holds_no_data_yet(self) -> None:
        pilot = section(read_record(), "Nov 2 pilot")
        self.assertIsNotNone(pilot)
        assert pilot is not None
        self.assertTrue(pilot.strip().startswith("Not recorded yet."))
        # No counts and no table until HACK-58 consent is documented; the
        # ticket id is the only number the section may carry.
        self.assertNotRegex(re.sub(r"HACK-\d+", "", pilot), r"\d")
        self.assertNotIn("|", pilot)


def counts_cells(text: str) -> list[tuple[int, int]]:
    """(line index, cell index) of every number in the counts table."""
    lines = text.splitlines()
    start = lines.index(COUNTS_HEADER) + 2
    cells: list[tuple[int, int]] = []
    for offset, line in enumerate(lines[start:]):
        if not line.startswith("| "):
            break
        cells.extend((start + offset, index) for index in range(1, 2 + len(OUTCOMES)))
    return cells


def with_cell(text: str, line_index: int, cell_index: int, delta: int) -> str:
    lines = text.splitlines()
    cells = lines[line_index].strip().strip("|").split("|")
    cells[cell_index] = f" {max(0, int(cells[cell_index]) + delta)} "
    lines[line_index] = "|" + "|".join(cells) + "|"
    return "\n".join(lines) + "\n"


class CheckerProperties(unittest.TestCase):
    """The checker catches any single number that stops adding up."""

    @settings(max_examples=150, deadline=None)
    @given(st.data())
    def test_changing_any_one_count_breaks_the_check(self, data: st.DataObject) -> None:
        text = read_record()
        line_index, cell_index = data.draw(st.sampled_from(counts_cells(text)))
        delta = data.draw(st.integers(min_value=1, max_value=50))
        changed = with_cell(text, line_index, cell_index, delta)
        self.assertNotEqual(check_record(changed), [])

    @settings(max_examples=50, deadline=None)
    @given(st.integers(min_value=1, max_value=500))
    def test_a_wrong_denominator_breaks_the_check(self, other: int) -> None:
        text = read_record()
        total = denominator(text)
        assert total is not None
        if other == total:
            other += 1
        changed = text.replace(f"| Denominator | {total} cases |", f"| Denominator | {other} cases |")
        self.assertNotEqual(check_record(changed), [])

    def test_a_missing_or_vague_negatives_line_breaks_the_check(self) -> None:
        text = read_record()
        total = denominator(text)
        line = re.search(r"^Negatives: \d+ of \d+ cases\.$", text, re.M)
        assert line is not None
        self.assertNotEqual(check_record(text.replace(line.group(0), "Negatives: none.")), [])
        self.assertNotEqual(check_record(text.replace(line.group(0), f"Negatives: 99 of {total} cases.")), [])
        self.assertNotEqual(check_record(text.replace("\n## Negatives\n", "\n## Misses\n")), [])

    @settings(max_examples=60, deadline=None)
    @given(st.data())
    def test_swapping_a_listed_case_or_editing_an_outcome_breaks_the_check(self, data: st.DataObject) -> None:
        text = read_record()
        every_case = section(text, "Every case")
        assert every_case is not None
        rows = case_rows(every_case)
        outcomes = {row[0].strip("`"): outcome_label(row[-1]) for row in rows}
        negatives = section(text, "Negatives")
        assert negatives is not None
        listed = table_case_ids(negatives)
        others = [case for case, label in outcomes.items() if label not in NEGATIVE_OUTCOMES]
        if listed and others:
            # A negatives row that names a case the run scored as fine.
            swapped = data.draw(st.sampled_from(listed))
            fine = data.draw(st.sampled_from(others))
            changed = text.replace(f"| `{swapped}` | ", f"| `{fine}` | ", 1)
            self.assertNotEqual(check_record(changed), [])
        # An every case Outcome cell changed to any other outcome.
        row = data.draw(st.sampled_from(rows))
        other = data.draw(st.sampled_from([label for label in OUTCOMES if label != outcome_label(row[-1])]))
        old_line = next(line for line in every_case.splitlines() if line.startswith(f"| {row[0]} |"))
        new_line = old_line[: old_line.rstrip().rstrip("|").rstrip().rfind("|") + 1] + f" {other} |"
        self.assertNotEqual(check_record(text.replace(old_line, new_line, 1)), [])

    def test_dropping_or_adding_a_negative_row_breaks_the_check(self) -> None:
        text = read_record()
        negatives = section(text, "Negatives")
        assert negatives is not None
        rows = [line for line in negatives.splitlines() if line.startswith("| `")]
        for row in rows:
            self.assertNotEqual(check_record(text.replace(row + "\n", "", 1)), [])
        line = re.search(r"^Negatives: \d+ of \d+ cases\.$", text, re.M)
        assert line is not None
        extra = "| `turn.extra` | Answer turns | Wrong | none | An extra row |"
        self.assertNotEqual(check_record(text.replace(line.group(0), f"{line.group(0)}\n\n{extra}", 1)), [])


if __name__ == "__main__":
    unittest.main()
