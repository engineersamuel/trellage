#!/usr/bin/env python3
"""Tests for the rapture-top100 data and chart contract."""

from __future__ import annotations

import csv
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET


BUILD = Path(__file__).with_name("build.py")
KEPT_FIELDS = (
    "rank",
    "ranking_source",
    "source_rank",
    "church",
    "statement_url",
    "passage",
    "label",
    "summary",
)
EXCLUDED_FIELDS = ("rank", "ranking_source", "source_rank", "church", "reason")
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


class BuildTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        shutil.copyfile(BUILD, self.root / "build.py")
        spec = importlib.util.spec_from_file_location("rapture_top100_build", BUILD)
        if spec is None or spec.loader is None:
            raise RuntimeError("could not load build.py")
        self.build = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.build)
        self.build.__file__ = str(self.root / "build.py")
        self.write_fixture()

    def tearDown(self) -> None:
        self.temp.cleanup()

    def write_fixture(self) -> None:
        ranks = [*range(1, 100), 101]
        self.kept = [
            {
                "rank": str(rank),
                "ranking_source": "Outreach 100 2026" if rank <= 100 else "Hartford",
                "source_rank": str(rank if rank <= 100 else rank - 100),
                "church": f"Church {rank}",
                "statement_url": f"https://church{rank}.example/beliefs",
                "passage": "The church teaches the rapture in an end-times article.",
                "label": LABELS[(rank - 1) % len(LABELS)],
                "summary": "The church names an end-times position.",
            }
            for rank in ranks
        ]
        self.write_csv("kept.csv", KEPT_FIELDS, self.kept)
        self.write_csv(
            "excluded.csv",
            EXCLUDED_FIELDS,
            [
                {
                    "rank": "100",
                    "ranking_source": "Outreach 100 2026",
                    "source_rank": "100",
                    "church": "Excluded Church 100",
                    "reason": "No qualifying term in an end-times passage.",
                }
            ],
        )
        self.logs = [
            {
                "rank": rank,
                "urls_checked": [f"https://church{rank}.example/beliefs"],
                "terms_searched": ["rapture"],
            }
            for rank in ranks
        ]
        self.logs.append(
            {
                "rank": 100,
                "urls_checked": ["https://excluded.example/beliefs"],
                "terms_searched": ["rapture"],
                "steps": {
                    "beliefs_page": ["none found: checked official beliefs page"],
                    "linked_pdfs": ["none found: no linked PDFs"],
                    "adopted_confession": ["none found: no adopted confession"],
                    "site_search": ["none found: searched rapture"],
                },
            }
        )
        self.write_logs()

    def write_csv(self, name: str, fields: tuple[str, ...], rows: list[dict[str, str]]) -> None:
        with (self.root / name).open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)

    def write_logs(self) -> None:
        content = "".join(json.dumps(item, sort_keys=True) + "\n" for item in self.logs)
        (self.root / "search-log.jsonl").write_text(content, encoding="utf-8")

    def run_build(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(self.root / "build.py"), *args],
            cwd=self.root,
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_fails(self, expected: str) -> None:
        with self.assertRaises(self.build.ValidationError):
            self.build.check(self.root)
        result = self.run_build("--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(expected, result.stdout + result.stderr)

    def test_valid_set_passes(self) -> None:
        self.build.write_charts(self.root)
        self.build.check(self.root)
        with mock.patch.object(sys, "argv", ["build.py"]), redirect_stdout(io.StringIO()):
            self.assertEqual(self.build.main(), 0)
        with mock.patch.object(sys, "argv", ["build.py", "--check"]), redirect_stdout(io.StringIO()):
            self.assertEqual(self.build.main(), 0)

    def test_charts_are_deterministic_and_have_fixed_layout(self) -> None:
        counts = self.build.render_counts(self.kept)
        churches = self.build.render_churches(self.kept)
        self.assertEqual(counts, self.build.render_counts(self.kept))
        self.assertEqual(churches, self.build.render_churches(self.kept))
        self.assertTrue(counts.startswith(b"<?xml version='1.0' encoding='utf-8'?>\n"))
        self.assertTrue(counts.endswith(b"</svg>\n"))

        counts_root = ET.fromstring(counts)
        self.assertEqual(counts_root.attrib["width"], "1000")
        self.assertEqual(counts_root.attrib["height"], "550")
        bars = [node for node in counts_root if node.tag.endswith("rect")]
        expected_widths = ["560.00", *(["509.09"] * 8), "458.18"]
        self.assertEqual([node.attrib["width"] for node in bars], expected_widths)
        self.assertEqual([node.attrib["y"] for node in bars], [f"{94 + 44 * index:.2f}" for index in range(10)])
        self.assertEqual(
            [(node.attrib["x"], node.attrib["y"]) for node in self.build.svg_nodes(counts_root, "count-label")[:2]],
            [("40", "114.00"), ("40", "158.00")],
        )
        count_nodes = self.build.svg_nodes(counts_root, "count-value")
        self.assertEqual(
            [(node.attrib["x"], node.attrib["y"]) for node in count_nodes[:2]],
            [("952.00", "114.00"), ("901.09", "158.00")],
        )
        self.assertEqual(self.build.svg_nodes(counts_root, "source")[0].attrib["y"], "546.00")

        churches_root = ET.fromstring(churches)
        self.assertEqual(churches_root.attrib["width"], "1600")
        self.assertEqual(churches_root.attrib["height"], "1710")
        legend_rects = [
            node for node in churches_root if node.tag.endswith("rect") and node.attrib.get("class") is None
        ]
        self.assertEqual(
            [(node.attrib["x"], node.attrib["y"]) for node in legend_rects],
            [
                ("40.00", "57.00"),
                ("550.00", "57.00"),
                ("1060.00", "57.00"),
                ("40.00", "81.00"),
                ("550.00", "81.00"),
                ("1060.00", "81.00"),
                ("40.00", "105.00"),
                ("550.00", "105.00"),
                ("1060.00", "105.00"),
                ("40.00", "129.00"),
            ],
        )
        self.assertEqual(
            [
                (node.text, node.attrib["x"], node.attrib["y"])
                for node in self.build.svg_nodes(churches_root, "legend-label")
            ],
            [
                (label, f"{40 + index % 3 * 510 + 22:.2f}", f"{70 + index // 3 * 24:.2f}")
                for index, label in enumerate(LABELS)
            ],
        )
        rows = [
            node for node in churches_root if node.tag.endswith("text") and node.attrib.get("class") == "church-row"
        ]
        self.assertEqual((rows[0].attrib["x"], rows[0].attrib["y"]), ("40.00", "190.00"))
        self.assertEqual((rows[49].attrib["x"], rows[49].attrib["y"]), ("40.00", "1562.00"))
        self.assertEqual((rows[50].attrib["x"], rows[50].attrib["y"]), ("830.00", "190.00"))
        self.assertEqual((rows[-1].attrib["x"], rows[-1].attrib["y"]), ("830.00", "1562.00"))
        self.assertEqual([child.attrib["x"] for child in rows[0]], ["40.00", "82.00", "480.00"])
        self.assertEqual([child.attrib["x"] for child in rows[50]], ["830.00", "872.00", "1270.00"])
        self.assertEqual(rows[0].attrib["fill"], self.build.COLORS[self.kept[0]["label"]])

    def test_single_count_label_remains_visible(self) -> None:
        counts_root = ET.fromstring(self.build.render_counts([self.kept[0]]))
        self.assertEqual(counts_root.attrib["height"], "154")
        labels = self.build.svg_nodes(counts_root, "count-label")
        self.assertEqual(
            [(node.text, node.attrib["data-label"]) for node in labels], [("pre-tribulation", "pre-tribulation")]
        )
        self.assertEqual(self.build.svg_nodes(counts_root, "count-value")[0].attrib["data-count"], "1")
        same_label = [{**self.kept[0], "label": "pre-tribulation"} for _ in range(100)]
        same_label_root = ET.fromstring(self.build.render_counts(same_label))
        self.build.validate_counts_chart(same_label_root, same_label)
        two_labels = [{**self.kept[0], "label": "pre-tribulation" if index else "pre-wrath"} for index in range(100)]
        self.build.validate_counts_chart(ET.fromstring(self.build.render_counts(two_labels)), two_labels)
        church_root = ET.fromstring(self.build.render_churches([self.kept[0]]))
        self.assertEqual([node.text for node in self.build.svg_nodes(church_root, "legend-label")], ["pre-tribulation"])

    def test_chart_validators_reject_corruption(self) -> None:
        counts_root = ET.fromstring(self.build.render_counts(self.kept))
        counts_root.remove(self.build.svg_nodes(counts_root, "count-label")[0])
        with self.assertRaises(self.build.ValidationError):
            self.build.validate_counts_chart(counts_root, self.kept)

        counts_root = ET.fromstring(self.build.render_counts(self.kept))
        count_nodes = self.build.svg_nodes(counts_root, "count-value")
        count_nodes[0].attrib["data-count"] = "10"
        count_nodes[1].attrib["data-count"] = "11"
        with self.assertRaises(self.build.ValidationError):
            self.build.validate_counts_chart(counts_root, self.kept)

        churches_root = ET.fromstring(self.build.render_churches(self.kept))
        church_rows = self.build.svg_nodes(churches_root, "church-row")
        church_rows[1].attrib["y"] = church_rows[0].attrib["y"]
        with self.assertRaises(self.build.ValidationError):
            self.build.validate_church_chart(churches_root, self.kept)

        churches_root = ET.fromstring(self.build.render_churches(self.kept))
        duplicate = deepcopy(self.build.svg_nodes(churches_root, "church-row")[0])
        duplicate.attrib["x"] = "1000.00"
        churches_root.append(duplicate)
        with self.assertRaises(self.build.ValidationError):
            self.build.validate_church_chart(churches_root, self.kept)

        churches_root = ET.fromstring(self.build.render_churches(self.kept))
        church_rows = self.build.svg_nodes(churches_root, "church-row")
        churches_root.remove(church_rows[0])
        with self.assertRaises(self.build.ValidationError):
            self.build.validate_church_chart(churches_root, self.kept)

        churches_root = ET.fromstring(self.build.render_churches(self.kept))
        self.build.svg_nodes(churches_root, "church-row")[0].attrib["data-church"] = "Wrong Church"
        with self.assertRaises(self.build.ValidationError):
            self.build.validate_church_chart(churches_root, self.kept)

        with self.assertRaises(self.build.ValidationError):
            self.build.parse_svg(b"<svg", "broken.svg")
        self.assertEqual(self.build.local_name(ET.fromstring("<text />")), "text")

    def test_101_rows_fail(self) -> None:
        self.kept.append(
            {
                **self.kept[0],
                "rank": "102",
                "source_rank": "1",
                "ranking_source": "Hartford",
                "church": "Extra Church",
                "statement_url": "https://extra.example/beliefs",
            }
        )
        self.write_csv("kept.csv", KEPT_FIELDS, self.kept)
        self.assert_fails("exactly 100 data rows")

    def test_passage_without_term_fails(self) -> None:
        self.kept[0]["passage"] = "Jesus is Lord."
        self.write_csv("kept.csv", KEPT_FIELDS, self.kept)
        self.assert_fails("does not contain a TERMS match")

    def test_bad_label_fails(self) -> None:
        self.kept[0]["label"] = "timing-not-specified"
        self.write_csv("kept.csv", KEPT_FIELDS, self.kept)
        self.assert_fails("invalid label")

    def test_rank_gap_fails(self) -> None:
        self.kept[-1]["rank"] = "102"
        self.kept[-1]["ranking_source"] = "Hartford"
        self.kept[-1]["source_rank"] = "2"
        self.write_csv("kept.csv", KEPT_FIELDS, self.kept)
        self.assert_fails("rank values must be exactly")

    def test_no_kept_ranks_fails(self) -> None:
        with self.assertRaisesRegex(self.build.ValidationError, "kept.csv must contain ranks"):
            self.build.validate_rank_set([(100, "excluded.csv", self.kept[0], 2)])

    def test_zero_rank_fails(self) -> None:
        self.kept[0]["rank"] = "0"
        self.kept[0]["source_rank"] = "0"
        self.write_csv("kept.csv", KEPT_FIELDS, self.kept)
        self.assert_fails("invalid rank")

    def test_zero_hartford_source_rank_fails(self) -> None:
        self.kept[-1]["source_rank"] = "0"
        self.write_csv("kept.csv", KEPT_FIELDS, self.kept)
        self.assert_fails("strictly increasing")

    def test_duplicate_church_fails(self) -> None:
        self.kept[1]["church"] = "Church, 1!"
        self.write_csv("kept.csv", KEPT_FIELDS, self.kept)
        self.assert_fails("repeats church")

    def test_duplicate_church_across_sources_fails(self) -> None:
        self.kept[-1]["church"] = "Excluded Church 100"
        self.write_csv("kept.csv", KEPT_FIELDS, self.kept)
        with self.assertRaisesRegex(self.build.ValidationError, "appears in both Outreach and Hartford populations"):
            self.build.load_data(self.root)

    def test_duplicate_statement_host_fails(self) -> None:
        self.kept[1]["statement_url"] = "https://www.CHURCH1.example/another-page"
        self.write_csv("kept.csv", KEPT_FIELDS, self.kept)
        self.assert_fails("repeats statement_url host")

    def test_missing_log_entry_fails(self) -> None:
        self.logs.pop()
        self.write_logs()
        self.assert_fails("missing rank 100")

    def test_non_string_log_value_fails(self) -> None:
        self.logs[0]["terms_searched"] = ["rapture", 7]
        self.write_logs()
        self.assert_fails("invalid terms_searched")

    def test_empty_log_list_fails(self) -> None:
        self.logs[0]["urls_checked"] = []
        self.write_logs()
        self.assert_fails("invalid urls_checked")

    def test_excluded_log_without_steps_fails(self) -> None:
        excluded_log = next(entry for entry in self.logs if entry["rank"] == 100)
        excluded_log.pop("steps")
        self.write_logs()
        self.assert_fails("missing steps")

    def test_excluded_null_beliefs_page_fails(self) -> None:
        excluded_log = next(entry for entry in self.logs if entry["rank"] == 100)
        excluded_log["steps"]["beliefs_page"] = None
        self.write_logs()
        self.assert_fails("invalid beliefs_page")

    def test_excluded_empty_linked_pdfs_fails(self) -> None:
        excluded_log = next(entry for entry in self.logs if entry["rank"] == 100)
        excluded_log["steps"]["linked_pdfs"] = []
        self.write_logs()
        self.assert_fails("invalid linked_pdfs")

    def test_excluded_whitespace_site_search_fails(self) -> None:
        excluded_log = next(entry for entry in self.logs if entry["rank"] == 100)
        excluded_log["steps"]["site_search"] = ["  "]
        self.write_logs()
        self.assert_fails("invalid site_search")

    def test_extra_log_rank_fails(self) -> None:
        self.logs.append(
            {
                "rank": 999,
                "urls_checked": ["https://extra.example/beliefs"],
                "terms_searched": ["rapture"],
            }
        )
        self.write_logs()
        self.assert_fails("extra rank 999")

    def test_duplicate_log_rank_fails(self) -> None:
        self.logs.append(
            {
                "rank": 1,
                "urls_checked": ["https://duplicate.example/beliefs"],
                "terms_searched": ["rapture"],
            }
        )
        self.write_logs()
        self.assert_fails("repeats rank 1")

    def test_non_integer_log_rank_fails(self) -> None:
        self.logs[0]["rank"] = "1"
        self.write_logs()
        self.assert_fails("integer rank values")

    def test_invalid_log_json_reports_line(self) -> None:
        (self.root / "search-log.jsonl").write_text("{broken\n", encoding="utf-8")
        with self.assertRaisesRegex(self.build.ValidationError, "line 1"):
            self.build.read_logs(self.root / "search-log.jsonl")

    def test_stale_svg_fails(self) -> None:
        self.assertEqual(self.run_build().returncode, 0)
        path = self.root / "chart-counts.svg"
        path.write_bytes(path.read_bytes() + b"<!-- stale -->\n")
        self.assert_fails("stale chart-counts.svg")


if __name__ == "__main__":
    unittest.main()
