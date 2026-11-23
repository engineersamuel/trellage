#!/usr/bin/env python3
"""Validate rapture-top100 research data and render its charts."""

from __future__ import annotations

import argparse
from collections import Counter
import csv
import json
from pathlib import Path
import re
import sys
import unicodedata
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET


LABELS = (
    "pre-tribulation",
    "pre-wrath",
    "mid-tribulation",
    "post-tribulation",
    "preterist",
    "multiple views permitted",
    "other eschatology",
    "premillennial (timing not stated)",
    "imminent return (timing not stated)",
    "rapture named (timing not stated)",
)
TERMS = (
    "rapture",
    "imminent",
    "imminence",
    "tribulation",
    "pre-tribulation",
    "pretribulation",
    "pretribulational",
    "mid-tribulation",
    "midtribulation",
    "post-tribulation",
    "posttribulation",
    "posttribulational",
    "pre-wrath",
    "prewrath",
    "wrath of God",
    "God's wrath",
    "70th week",
    "seventieth week",
    "Daniel's week",
    "millennium",
    "millennial",
    "premillennial",
    "pre-millennial",
    "amillennial",
    "postmillennial",
    "preterist",
    "preterism",
)
COLORS = {
    "pre-tribulation": "#0072B2",
    "pre-wrath": "#E69F00",
    "mid-tribulation": "#009E73",
    "post-tribulation": "#CC79A7",
    "preterist": "#D55E00",
    "multiple views permitted": "#56B4E9",
    "other eschatology": "#F0E442",
    "premillennial (timing not stated)": "#8B5FBF",
    "imminent return (timing not stated)": "#999999",
    "rapture named (timing not stated)": "#A6761D",
}
KEPT_REQUIRED = {
    "rank",
    "ranking_source",
    "source_rank",
    "church",
    "statement_url",
    "passage",
    "label",
    "summary",
}
EXCLUDED_REQUIRED = {"rank", "ranking_source", "source_rank", "church", "reason"}
SVG_NAMESPACE = "http://www.w3.org/2000/svg"
TERM_PATTERN = re.compile(
    "|".join(
        re.escape(term).replace("'", "['\N{RIGHT SINGLE QUOTATION MARK}]")
        for term in sorted(TERMS, key=len, reverse=True)
    ),
    re.IGNORECASE,
)
ET.register_namespace("", SVG_NAMESPACE)


class ValidationError(Exception):
    """A user-visible research data contract failure."""


def element(parent: ET.Element, tag: str, **attrs: str) -> ET.Element:
    return ET.SubElement(parent, f"{{{SVG_NAMESPACE}}}{tag}", attrs)


def read_csv(path: Path, required: set[str]) -> list[dict[str, str]]:
    if not path.is_file():
        raise ValidationError(f"{path.name} is missing")
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = set(reader.fieldnames or ())
        missing = required - fields
        if missing:
            raise ValidationError(f"{path.name} is missing columns: {', '.join(sorted(missing))}")
        return list(reader)


def parse_rank(row: dict[str, str], source: str, index: int) -> int:
    value = row["rank"].strip()
    try:
        rank = int(value)
    except ValueError as error:
        raise ValidationError(f"{source} row {index} has invalid rank {value!r}") from error
    if rank <= 0 or str(rank) != value:
        raise ValidationError(f"{source} row {index} has invalid rank {value!r}")
    return rank


def normalize_church(name: str) -> str:
    normalized = unicodedata.normalize("NFKC", name).casefold()
    return "".join(character for character in normalized if not unicodedata.category(character).startswith("P"))


def statement_host(url: str, index: int) -> str:
    host = urlsplit(url).hostname
    if not host:
        raise ValidationError(f"kept.csv row {index} has invalid statement_url host")
    normalized = host.casefold()
    return normalized[4:] if normalized.startswith("www.") else normalized


def validate_nonblank(row: dict[str, str], fields: set[str], source: str, index: int) -> None:
    for field in sorted(fields):
        if not row.get(field, "").strip():
            raise ValidationError(f"{source} row {index} field {field} must be non-whitespace")


def validate_kept(rows: list[dict[str, str]]) -> None:
    if len(rows) != 100:
        raise ValidationError(f"kept.csv must contain exactly 100 data rows (found {len(rows)})")
    churches: set[str] = set()
    hosts: set[str] = set()
    for index, row in enumerate(rows, start=2):
        validate_nonblank(row, KEPT_REQUIRED, "kept.csv", index)
        if row["label"] not in LABELS:
            raise ValidationError(f"kept.csv row {index} has invalid label {row['label']!r}")
        if not TERM_PATTERN.search(row["passage"]):
            raise ValidationError(f"kept.csv row {index} passage does not contain a TERMS match")
        church = normalize_church(row["church"])
        host = statement_host(row["statement_url"].strip(), index)
        if church in churches:
            raise ValidationError(f"kept.csv repeats church after normalization: {row['church']!r}")
        if host in hosts:
            raise ValidationError(f"kept.csv repeats statement_url host: {host}")
        churches.add(church)
        hosts.add(host)


def collect_rank_records(
    kept: list[dict[str, str]], excluded: list[dict[str, str]]
) -> list[tuple[int, str, dict[str, str], int]]:
    records: list[tuple[int, str, dict[str, str], int]] = []
    for source, rows in (("kept.csv", kept), ("excluded.csv", excluded)):
        required = KEPT_REQUIRED if source == "kept.csv" else EXCLUDED_REQUIRED
        for index, row in enumerate(rows, start=2):
            validate_nonblank(row, required, source, index)
            records.append((parse_rank(row, source, index), source, row, index))
    return records


def validate_rank_set(records: list[tuple[int, str, dict[str, str], int]]) -> None:
    ranks = [record[0] for record in records]
    if len(ranks) != len(set(ranks)):
        raise ValidationError("kept.csv and excluded.csv contain a duplicate rank")
    maximum = max((rank for rank, source, _, _ in records if source == "kept.csv"), default=0)
    if not maximum:
        raise ValidationError("kept.csv must contain ranks")
    expected = list(range(1, maximum + 1))
    if sorted(ranks) != expected:
        raise ValidationError(f"rank values must be exactly 1..{maximum} with no gaps or extras")


def validate_outreach_record(rank: int, source: str, row: dict[str, str], index: int) -> None:
    if row["ranking_source"] != "Outreach 100 2026":
        raise ValidationError(f"{source} row {index} rank {rank} must use Outreach 100 2026")
    if row["source_rank"].strip() != str(rank):
        raise ValidationError(f"{source} row {index} rank {rank} must have source_rank {rank}")


def validate_hartford_record(rank: int, source: str, row: dict[str, str], index: int, previous_source_rank: int) -> int:
    if row["ranking_source"] != "Hartford":
        raise ValidationError(f"{source} row {index} rank {rank} must use Hartford")
    try:
        source_rank = int(row["source_rank"].strip())
    except ValueError as error:
        raise ValidationError(f"{source} row {index} has invalid Hartford source_rank") from error
    if source_rank <= previous_source_rank:
        raise ValidationError("Hartford source_rank must be positive and strictly increasing with rank")
    return source_rank


def validate_ranks(kept: list[dict[str, str]], excluded: list[dict[str, str]]) -> dict[int, str]:
    records = collect_rank_records(kept, excluded)
    validate_rank_set(records)
    previous_source_rank = 0
    for rank, source, row, index in sorted(records):
        if rank <= 100:
            validate_outreach_record(rank, source, row, index)
        else:
            previous_source_rank = validate_hartford_record(rank, source, row, index, previous_source_rank)
    return {rank: source for rank, source, _, _ in records}


def read_logs(path: Path) -> list[dict]:
    if not path.is_file():
        raise ValidationError("search-log.jsonl is missing")
    entries: list[dict] = []
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            raise ValidationError(f"search-log.jsonl line {number} is blank")
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValidationError(f"search-log.jsonl line {number} is not valid JSON") from error
        if not isinstance(entry, dict):
            raise ValidationError(f"search-log.jsonl line {number} is not a JSON object")
        entries.append(entry)
    return entries


def validate_string_list(entry: dict, field: str, rank: int) -> None:
    values = entry.get(field)
    if (
        not isinstance(values, list)
        or not values
        or any(not isinstance(value, str) or not value.strip() for value in values)
    ):
        raise ValidationError(f"search-log.jsonl rank {rank} has invalid {field}")


def index_logs(entries: list[dict]) -> dict[int, dict]:
    by_rank: dict[int, dict] = {}
    for entry in entries:
        rank = entry.get("rank")
        if type(rank) is not int:
            raise ValidationError("search-log.jsonl entries must have integer rank values")
        if rank in by_rank:
            raise ValidationError(f"search-log.jsonl repeats rank {rank}")
        by_rank[rank] = entry
        validate_string_list(entry, "urls_checked", rank)
        validate_string_list(entry, "terms_searched", rank)
    return by_rank


def validate_log_rank_set(by_rank: dict[int, dict], rank_sources: dict[int, str]) -> None:
    for rank in sorted(rank_sources):
        if rank not in by_rank:
            raise ValidationError(f"search-log.jsonl is missing rank {rank}")
    extras = sorted(set(by_rank) - set(rank_sources))
    if extras:
        raise ValidationError(f"search-log.jsonl has extra rank {extras[0]}")


def validate_excluded_steps(entry: dict, rank: int) -> None:
    steps = entry.get("steps")
    if not isinstance(steps, dict):
        raise ValidationError(f"search-log.jsonl rank {rank} is missing steps")
    for step in ("beliefs_page", "linked_pdfs", "adopted_confession", "site_search"):
        validate_string_list(steps, step, rank)


def validate_logs(entries: list[dict], rank_sources: dict[int, str]) -> None:
    by_rank = index_logs(entries)
    validate_log_rank_set(by_rank, rank_sources)
    for rank, source in rank_sources.items():
        if source == "excluded.csv":
            validate_excluded_steps(by_rank[rank], rank)


def load_data(root: Path) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    kept = read_csv(root / "kept.csv", KEPT_REQUIRED)
    excluded = read_csv(root / "excluded.csv", EXCLUDED_REQUIRED)
    validate_kept(kept)
    rank_sources = validate_ranks(kept, excluded)
    validate_logs(read_logs(root / "search-log.jsonl"), rank_sources)
    return kept, excluded


def add_svg_root(width: int, height: int, title: str, description: str) -> ET.Element:
    root = ET.Element(
        f"{{{SVG_NAMESPACE}}}svg",
        {"width": str(width), "height": str(height), "viewBox": f"0 0 {width} {height}", "role": "img"},
    )
    element(root, "title").text = title
    element(root, "desc").text = description
    return root


def svg_text(parent: ET.Element, content: str, **attrs: str) -> ET.Element:
    node = element(parent, "text", **attrs)
    node.text = content
    return node


def serialize_svg(root: ET.Element) -> bytes:
    return ET.tostring(root, encoding="utf-8", xml_declaration=True) + b"\n"


def render_counts(rows: list[dict[str, str]]) -> bytes:
    counts = Counter(row["label"] for row in rows)
    used_labels = [label for label in LABELS if counts[label] > 0]
    root = add_svg_root(
        1000,
        110 + 44 * len(used_labels),
        "Rapture positioning among 100 churches",
        "Horizontal bar chart showing the number of kept churches assigned to each used label.",
    )
    svg_text(
        root,
        "Rapture positioning among 100 churches",
        x="40",
        y="38",
        **{"class": "chart-title", "font-size": "24", "font-weight": "bold"},
    )
    svg_text(root, "n = 100", x="40", y="66", **{"class": "sample-size", "font-size": "15"})
    maximum = max(counts.values())
    for index, label in enumerate(used_labels):
        y = 94 + index * 44
        width = 560.0 * counts[label] / maximum
        svg_text(
            root,
            label,
            x="40",
            y=f"{y + 20:.2f}",
            **{"class": "count-label", "data-label": label, "font-size": "15"},
        )
        element(
            root,
            "rect",
            x="380.00",
            y=f"{y:.2f}",
            width=f"{width:.2f}",
            height="28.00",
            fill=COLORS[label],
        )
        svg_text(
            root,
            str(counts[label]),
            x=f"{392 + width:.2f}",
            y=f"{y + 20:.2f}",
            **{
                "class": "count-value",
                "data-label": label,
                "data-count": str(counts[label]),
                "font-size": "15",
                "font-weight": "bold",
            },
        )
    source_y = 94 + len(used_labels) * 44 + 12
    svg_text(
        root,
        "Source: church statements classified under the rapture-top100 rules.",
        x="40",
        y=f"{source_y:.2f}",
        **{"class": "source", "font-size": "13"},
    )
    return serialize_svg(root)


def render_churches(rows: list[dict[str, str]]) -> bytes:
    ordered = sorted(rows, key=lambda row: int(row["rank"]))
    root = add_svg_root(
        1600,
        1710,
        "All 100 kept churches by walk rank",
        "Two-column list of church name, walk rank, and assigned label; row colour identifies the label.",
    )
    svg_text(
        root,
        "All 100 kept churches by walk rank",
        x="40",
        y="38",
        **{"class": "chart-title", "font-size": "24", "font-weight": "bold"},
    )
    used_labels = [label for label in LABELS if any(row["label"] == label for row in rows)]
    for index, label in enumerate(used_labels):
        x = 40 + index % 3 * 510
        y = 70 + index // 3 * 24
        element(root, "rect", x=f"{x:.2f}", y=f"{y - 13:.2f}", width="14.00", height="14.00", fill=COLORS[label])
        svg_text(root, label, x=f"{x + 22:.2f}", y=f"{y:.2f}", **{"class": "legend-label", "font-size": "13"})
    for index, row in enumerate(ordered):
        column = index // 50
        row_index = index % 50
        x = 40 + column * 790
        y = 190 + row_index * 28
        color = COLORS[row["label"]]
        text = svg_text(
            root,
            "",
            x=f"{x:.2f}",
            y=f"{y:.2f}",
            fill=color,
            **{
                "class": "church-row",
                "data-rank": row["rank"].strip(),
                "data-church": row["church"],
                "data-label": row["label"],
                "font-size": "12",
            },
        )
        rank = element(text, "tspan", x=f"{x:.2f}", **{"font-weight": "bold"})
        rank.text = f"{int(row['rank']):>3}. "
        church = element(
            text,
            "tspan",
            x=f"{x + 42:.2f}",
            textLength="380.00",
            lengthAdjust="spacingAndGlyphs",
        )
        church.text = row["church"]
        label = element(
            text,
            "tspan",
            x=f"{x + 440:.2f}",
            textLength="310.00",
            lengthAdjust="spacingAndGlyphs",
        )
        label.text = f" - {row['label']}"
    svg_text(
        root,
        "Source: kept church statements; labels follow the rapture-top100 rules.",
        x="40",
        y="1670.00",
        **{"class": "source", "font-size": "13"},
    )
    return serialize_svg(root)


def render(root: Path) -> tuple[bytes, bytes]:
    kept, _ = load_data(root)
    return render_counts(kept), render_churches(kept)


def parse_svg(content: bytes, filename: str) -> ET.Element:
    try:
        return ET.fromstring(content)
    except ET.ParseError as error:
        raise ValidationError(f"{filename} is not valid SVG XML") from error


def local_name(element_node: ET.Element) -> str:
    return element_node.tag.rsplit("}", 1)[-1]


def svg_nodes(root: ET.Element, css_class: str) -> list[ET.Element]:
    return [node for node in root.iter() if local_name(node) == "text" and node.attrib.get("class") == css_class]


def validate_counts_chart(root: ET.Element, rows: list[dict[str, str]]) -> None:
    counts = Counter(row["label"] for row in rows)
    visible_labels = [(node.attrib["data-label"], node.text) for node in svg_nodes(root, "count-label")]
    values = {
        node.attrib["data-label"]: (int(node.attrib["data-count"]), node.text)
        for node in svg_nodes(root, "count-value")
    }
    expected = {label: counts[label] for label in LABELS if counts[label] > 0}
    if visible_labels != [(label, label) for label in expected]:
        raise ValidationError("chart-counts.svg visible labels do not match kept.csv")
    if {label: value[0] for label, value in values.items()} != expected or any(
        str(expected[label]) != value[1] for label, value in values.items()
    ):
        raise ValidationError("chart-counts.svg visible counts do not match kept.csv")
    if sum(value[0] for value in values.values()) != 100:
        raise ValidationError("chart-counts.svg visible counts do not sum to 100")


def validate_church_row(node: ET.Element, expected: set[tuple[str, str, str]]) -> None:
    visible = "".join(node.itertext())
    key = (
        node.attrib["data-rank"],
        node.attrib["data-church"],
        node.attrib["data-label"],
    )
    if key not in expected:
        raise ValidationError("chart-churches.svg has an unexpected church row")
    if not all(value in visible for value in key):
        raise ValidationError("chart-churches.svg church-row text is not visible")


def validate_church_chart(root: ET.Element, rows: list[dict[str, str]]) -> None:
    nodes = svg_nodes(root, "church-row")
    actual = {
        (node.attrib.get("data-rank"), node.attrib.get("data-church"), node.attrib.get("data-label")) for node in nodes
    }
    expected = {(row["rank"].strip(), row["church"], row["label"]) for row in rows}
    if actual != expected or len(nodes) != 100:
        raise ValidationError("chart-churches.svg visible rows do not match all 100 kept churches")
    rows_by_column: dict[float, list[float]] = {}
    for node in nodes:
        validate_church_row(node, expected)
        rows_by_column.setdefault(float(node.attrib["x"]), []).append(float(node.attrib["y"]))
    for positions in rows_by_column.values():
        ordered = sorted(positions)
        if any(right - left < 28.0 for left, right in zip(ordered, ordered[1:], strict=False)):
            raise ValidationError("chart-churches.svg has overlapping text rows")


def check(root: Path) -> None:
    kept, _ = load_data(root)
    expected = {
        "chart-counts.svg": render_counts(kept),
        "chart-churches.svg": render_churches(kept),
    }
    for filename, expected_bytes in expected.items():
        path = root / filename
        if not path.is_file():
            raise ValidationError(f"{filename} is missing; run build.py")
        actual_bytes = path.read_bytes()
        if actual_bytes != expected_bytes:
            raise ValidationError(f"stale {filename}; run build.py")
    counts_root = parse_svg((root / "chart-counts.svg").read_bytes(), "chart-counts.svg")
    churches_root = parse_svg((root / "chart-churches.svg").read_bytes(), "chart-churches.svg")
    validate_counts_chart(counts_root, kept)
    validate_church_chart(churches_root, kept)


def write_charts(root: Path) -> None:
    counts, churches = render(root)
    (root / "chart-counts.svg").write_bytes(counts)
    (root / "chart-churches.svg").write_bytes(churches)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="validate data and committed charts without writing")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    try:
        if args.check:
            check(root)
            print("rapture-top100 check passed")
        else:
            write_charts(root)
            print("wrote chart-counts.svg and chart-churches.svg")
    except ValidationError as error:
        print(f"rapture-top100 check failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
