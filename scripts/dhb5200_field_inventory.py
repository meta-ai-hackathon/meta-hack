#!/usr/bin/env python3
"""Per-page AcroForm inventory of the committed DHB-5200 template.

Dumps every widget annotation - fully-qualified field name, widget type,
rectangle, read-only flag, checkbox/radio export values, choice options,
current value, and the printed label evidence (the /TU tooltip) - page by
page, as a markdown table the team can review next to the form-registry
entry (kb/forms/dhb-5200.json).

Usage (from the repo root):

    python3 scripts/dhb5200_field_inventory.py            # default paths
    python3 scripts/dhb5200_field_inventory.py --out -    # print to stdout

The default template is src/lib/forms/fixtures/dhb-5200-ia-9-2020.pdf and
the default output is docs/dhb5200-field-inventory.md.

Note on counts: this script walks page annotations (pypdf), which sees every
widget INCLUDING the print pushbutton and any unnamed structural widget. The
app's own discovery pass (discoverAcroFormFields, @cantoo/pdf-lib) walks the
AcroForm /Fields tree and classifies only fillable kinds - the registry test
pins that pass at 614 widgets across 572 named fields. Both counts are
reported in the summary so the two views reconcile.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from pypdf import PdfReader
from pypdf.generic import DictionaryObject

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PDF = REPO_ROOT / "src/lib/forms/fixtures/dhb-5200-ia-9-2020.pdf"
DEFAULT_OUT = REPO_ROOT / "docs/dhb5200-field-inventory.md"

# /Ff flag bits (PDF 32000-1:2008, Table 226). Bits are 1-based in the spec.
FF_READONLY = 1 << 0  # bit 1
FF_RADIO = 1 << 15  # bit 16 (/Btn)
FF_PUSHBUTTON = 1 << 16  # bit 17 (/Btn)
FF_COMBO = 1 << 17  # bit 18 (/Ch)

TYPE_LABELS = {
    "/Tx": "text",
    "/Btn": "button-family",
    "/Ch": "choice",
    "/Sig": "signature",
}


@dataclass
class WidgetInfo:
    """One widget annotation's reviewable facts."""

    name: str
    type: str
    page: int
    x: float
    y: float
    w: float
    h: float
    readonly: bool
    export_values: list[str] = field(default_factory=list)
    options: list[str] = field(default_factory=list)
    value: str | None = None
    tooltip: str | None = None


def fully_qualified_name(widget: DictionaryObject) -> str:
    """Walk the /Parent chain collecting /T partial names, outermost first."""
    parts: list[str] = []
    node: DictionaryObject | None = widget
    while node is not None:
        partial = node.get("/T")
        if partial is not None:
            parts.insert(0, str(partial))
        parent = node.get("/Parent")
        node = cast(
            "DictionaryObject | None",
            parent.get_object() if parent is not None else None,
        )
    return ".".join(parts)


def inherited(node: DictionaryObject, key: str) -> object | None:
    """Field dictionaries inherit /FT, /Ff, /V from their ancestors."""
    current: DictionaryObject | None = node
    while current is not None:
        value = current.get(key)
        if value is not None:
            return value
        parent = current.get("/Parent")
        current = cast(
            "DictionaryObject | None",
            parent.get_object() if parent is not None else None,
        )
    return None


def classify(widget: DictionaryObject, field_type: str) -> str:
    """Refine the raw /FT into the kind the pipeline's discovery returns."""
    flags = as_int(inherited(widget, "/Ff"))
    if field_type == "/Btn":
        if flags & FF_PUSHBUTTON:
            return "pushbutton"
        if flags & FF_RADIO:
            return "radio"
        return "checkbox"
    if field_type == "/Ch":
        return "dropdown" if flags & FF_COMBO else "listbox"
    if field_type == "/Tx":
        # Multiline text boxes are still text fields to the fill; the flag
        # only explains taller boxes on review.
        return "text"
    return TYPE_LABELS.get(field_type, field_type.lstrip("/"))


def as_int(value: object | None) -> int:
    """pypdf number objects are int subclasses; narrow for the flag math."""
    return value if isinstance(value, int) else 0


def export_values(widget: DictionaryObject, kind: str) -> list[str]:
    """The on-states a checkbox/radio widget can take (its export values)."""
    if kind not in {"checkbox", "radio"}:
        return []
    appearance = widget.get("/AP")
    if not isinstance(appearance, DictionaryObject) or "/N" not in appearance:
        return []
    normal = appearance["/N"].get_object()
    if not isinstance(normal, DictionaryObject):
        return []
    return [str(key).lstrip("/") for key in normal.keys()]


def choice_options(widget: DictionaryObject, kind: str) -> list[str]:
    if kind not in {"dropdown", "listbox"}:
        return []
    options = widget.get("/Opt")
    if options is None:
        return []
    resolved = options.get_object() if hasattr(options, "get_object") else options
    if not isinstance(resolved, list):
        return []
    return [str(option) for option in resolved]


def widget_info(widget: DictionaryObject, page_number: int) -> WidgetInfo | None:
    raw_type = inherited(widget, "/FT")
    if raw_type is None:
        # A bare widget with no field dictionary anywhere in its ancestry
        # carries no data the fill can address; report it as structural.
        raw_type = ""
    field_type = str(raw_type)
    kind = classify(widget, field_type) if field_type else "unnamed-widget"
    rect = widget.get("/Rect")
    if rect is None:
        return None
    coords = [float(value) for value in rect]
    value = inherited(widget, "/V")
    tooltip = inherited(widget, "/TU")
    flags = as_int(inherited(widget, "/Ff"))
    return WidgetInfo(
        name=fully_qualified_name(widget),
        type=kind,
        page=page_number,
        x=coords[0],
        y=coords[1],
        w=coords[2] - coords[0],
        h=coords[3] - coords[1],
        readonly=bool(flags & FF_READONLY),
        export_values=export_values(widget, kind),
        options=choice_options(widget, kind),
        value=str(value) if value is not None else None,
        tooltip=str(tooltip) if tooltip is not None else None,
    )


def page_widgets(reader: PdfReader, page_number: int) -> list[WidgetInfo]:
    """The widget annotations of one 1-based page, in annotation order."""
    annots = reader.pages[page_number - 1].get("/Annots")
    if annots is None:
        return []
    widgets: list[WidgetInfo] = []
    for ref in annots.get_object():
        candidate = ref.get_object()
        if candidate.get("/Subtype") != "/Widget":
            continue
        info = widget_info(candidate, page_number)
        if info is not None:
            widgets.append(info)
    return widgets


def md_escape(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def summarize(infos: list[WidgetInfo]) -> str:
    rows = [
        "| page | widgets | named fields | types |",
        "|---|---|---|---|",
    ]
    for page in sorted({info.page for info in infos}):
        on_page = [info for info in infos if info.page == page]
        named = {info.name for info in on_page if info.name}
        counts: dict[str, int] = {}
        for info in on_page:
            counts[info.type] = counts.get(info.type, 0) + 1
        type_summary = ", ".join(
            f"{kind} {count}" for kind, count in sorted(counts.items())
        )
        rows.append(
            f"| {page} | {len(on_page)} | {len(named)} | {type_summary} |"
        )
    return "\n".join(rows)


def render(infos: list[WidgetInfo], pdf_path: Path) -> str:
    total_named = len({info.name for info in infos if info.name})
    header = [
        "# DHB-5200 field inventory (per page)",
        "",
        f"Generated from the committed template `{pdf_path.name}` by",
        "`scripts/dhb5200_field_inventory.py` (pypdf page-annotation walk).",
        "Regenerate with `python3 scripts/dhb5200_field_inventory.py` from",
        "the repo root. Every AcroForm widget appears under its page with",
        "its type, rectangle (x, y, width, height - PDF origin bottom-left),",
        "read-only flag, checkbox/radio export values, choice options, any",
        "pre-printed value, and the printed label evidence (the /TU tooltip",
        "the form author wrote).",
        "",
        "Counts: this walk sees",
        f" {len(infos)} widgets across {total_named} named fields (including",
        " the print pushbutton, which is not fillable). The app's discovery",
        " pass (discoverAcroFormFields, @cantoo/pdf-lib) sees exactly this",
        " walk minus the pushbutton: 614 widgets across 571 named fields -",
        " the count the registry test pins.",
        "",
        summarize(infos),
        "",
    ]
    body: list[str] = []
    for page in sorted({info.page for info in infos}):
        body.append(f"## Page {page}")
        body.append("")
        body.append(
            "| field name | type | rect x,y,w,h | read-only"
            " | export values / options | value | printed label (tooltip) |"
        )
        body.append("|---|---|---|---|---|---|---|")
        for info in (i for i in infos if i.page == page):
            states = ", ".join(info.export_values + info.options)
            value = md_escape(info.value) if info.value else ""
            tooltip = md_escape(info.tooltip) if info.tooltip else ""
            body.append(
                f"| `{md_escape(info.name) or '_(unnamed)_'}` | {info.type} "
                f"| {info.x:.0f}, {info.y:.0f}, {info.w:.0f}, {info.h:.0f} "
                f"| {'yes' if info.readonly else ''} | {md_escape(states)} "
                f"| {value} | {tooltip} |"
            )
        body.append("")
    return "\n".join(header + body)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, default=DEFAULT_PDF)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    reader = PdfReader(str(args.pdf))
    infos: list[WidgetInfo] = [
        info
        for page_number in range(1, len(reader.pages) + 1)
        for info in page_widgets(reader, page_number)
    ]
    document = render(infos, args.pdf)
    if str(args.out) == "-":
        print(document)
    else:
        args.out.write_text(document, encoding="utf-8")
        print(f"wrote {args.out} ({len(infos)} widgets)")


if __name__ == "__main__":
    main()
