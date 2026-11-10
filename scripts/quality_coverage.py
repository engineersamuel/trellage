#!/usr/bin/env python3
"""Collect source-only LCOV and enforce measured, explicitly reviewed floors."""

import json
import os
from pathlib import Path
import sys

from quality_checks import ROOT, GateError, run_command, write_report

PACKAGES = ("guide-core", "launcher", "runtime", "conversation-source")
BASELINE = ROOT / ".quality/coverage-baseline.json"
COUNTERS = {
    "LF": ("lines", "total"),
    "LH": ("lines", "covered"),
    "FNF": ("functions", "total"),
    "FNH": ("functions", "covered"),
    "BRF": ("branches", "total"),
    "BRH": ("branches", "covered"),
}


def source_file(name: str, package: str) -> bool:
    path = Path(name)
    if not path.is_absolute():
        path = ROOT / f"packages/trellage-{package}" / path
    return path.resolve().is_relative_to(ROOT / f"packages/trellage-{package}/src")


def read_lcov(path: Path, package: str) -> dict:
    counts = {name: {"covered": 0, "total": 0} for name in ("lines", "functions", "branches")}
    included = False
    for line in path.read_text().splitlines():
        key, _, value = line.partition(":")
        if key == "SF":
            included = source_file(value, package)
        elif included and key in COUNTERS:
            metric, counter = COUNTERS[key]
            counts[metric][counter] += int(value)
    if counts["lines"]["total"] == 0:
        raise GateError(f"No maintained {package} source coverage in {path}")
    for value in counts.values():
        value["percent"] = round(100 * value["covered"] / value["total"], 2) if value["total"] else None
    return counts


def enforce_floors(metrics: dict, baseline: dict) -> bool:
    if not isinstance(baseline.get("packages"), dict) or not baseline["packages"]:
        raise GateError("Coverage baseline must contain measured package floors")
    ok = True
    for package, floors in baseline["packages"].items():
        if package not in metrics or not isinstance(floors, dict) or not floors:
            raise GateError(f"Missing measured coverage or floors for {package}")
        for metric, minimum in floors.items():
            if not check_floor(metrics[package], package, metric, minimum):
                ok = False
    return ok


def check_floor(counts: dict, package: str, metric: str, minimum: float) -> bool:
    if metric not in {"lines", "functions", "branches"} or type(minimum) not in {int, float} or not 0 <= minimum <= 100:
        raise GateError(f"Invalid coverage floor: {package} {metric}")
    observed = counts.get(metric, {}).get("percent")
    if observed is None or not minimum <= observed <= 100:
        print(f"coverage regression: {package} {metric}: {observed}% < {minimum}%", file=sys.stderr)
        return False
    return True


def coverage_args(package: str, directory: Path) -> list[str]:
    if package in {"guide-core", "launcher"}:
        return [
            "--coverage.enabled",
            "--coverage.provider=istanbul",
            "--coverage.include=src/**",
            "--coverage.reporter=json-summary",
            "--coverage.reporter=lcov",
            f"--coverage.reportsDirectory={directory}",
        ]
    return ["--coverage", "--coverage-reporter=lcov", f"--coverage-dir={directory}"]


def collect() -> bool:
    metrics = {}
    results = []
    for package in PACKAGES:
        directory = ROOT / ".quality-results/coverage" / package
        directory.mkdir(parents=True, exist_ok=True)
        report = directory / "lcov.info"
        report.unlink(missing_ok=True)
        args = [
            sys.executable,
            str(ROOT / "scripts/test-offline.py"),
            "--",
            "bun",
            "run",
            "test",
            *coverage_args(package, directory),
        ]
        result = run_command(f"coverage-{package}", args, ROOT / f"packages/trellage-{package}", timeout=900)
        results.append(result)
        if result["exitCode"]:
            write_report(results, "coverage")
            return False
        metrics[package] = read_lcov(report, package)
    (ROOT / ".quality-results/coverage/summary.json").write_text(json.dumps(metrics, indent=2) + "\n")
    write_report(results, "coverage")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(summary).open("a") as output:
            output.write("### Source coverage\n\n| Package | Lines | Functions | Branches |\n|---|---:|---:|---:|\n")
            for package, counts in metrics.items():
                values = [
                    str(counts[name]["percent"]) if counts[name]["percent"] is not None else "not reported"
                    for name in ("lines", "functions", "branches")
                ]
                output.write(f"| {package} | {' | '.join(values)} |\n")
    if not BASELINE.exists():
        raise GateError(
            "Coverage measured. Review .quality-results/coverage/summary.json and set the coverage baseline."
        )
    return enforce_floors(metrics, json.loads(BASELINE.read_text()))
