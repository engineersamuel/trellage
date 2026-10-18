#!/usr/bin/env python3
"""Independently audit a complete composition-preparation report against this checkout."""

import collections
import hashlib
import itertools
import json
from pathlib import Path
import re
import sys
import tomllib


def verify(report_path: Path) -> dict:
    root = Path(__file__).resolve().parent.parent
    report = json.loads(report_path.read_text())
    assert report["scope"] == "run-composition-preparation"
    catalog = tomllib.loads((root / "config.example.toml").read_text())["native"]["profiles"]
    presets = (root / "packages/trellage-runtime/src/native-run/presets.ts").read_text()
    block = presets.split("export const nativeHarnessPresets = {", 1)[1].split("} as const", 1)[0]
    aliases = re.findall(r'"([^"]+)"', block)
    shared = re.search(r"nativeSharedPresets[^=]+= \[([^]]+)\]", presets)
    assert shared is not None, "shared preset registry was not found"
    aliases += re.findall(r'"([^"]+)"', shared.group(1))
    adapters = (root / "packages/trellage-runtime/src/native-run/adapters.ts").read_text()
    adapters = adapters.split("export const adapters", 1)[1]
    harnesses = sorted(re.findall(r"^  (\w+): \w+Adapter,", adapters, re.M))
    assert harnesses, "adapter registry was not found"
    profiles = [None] + sorted(set(catalog) | set(aliases) | {"fixture-unknown-profile"})
    assert report["domains"] == {
        "harnesses": harnesses, "profiles": profiles,
        "noAlways": [False, True], "plan": [False, True],
    }
    assert report["selectedHarnesses"] == harnesses, "a partition is not complete coverage"
    expected = set(itertools.product(harnesses, profiles, [False, True], [False, True]))
    actual = [tuple(json.loads(row["id"])) for row in report["results"]]
    assert set(actual) == expected, "missing or unexpected cases"
    assert len(actual) == len(expected) == report["executed"] == report["fullProduct"] == report["expected"], "duplicate cases or incorrect totals"
    required_hashes = {
        "config.example.toml", "scripts/exhaustive-run-composition.ts", "scripts/exhaustive-clean-run-world.ts",
        "tests/helpers/native-source-fixtures.ts", "packages/trellage-runtime/src/native-config.ts",
    } | {str(file.relative_to(root)) for file in (root / "packages/trellage-runtime/src/native-run").rglob("*") if file.is_file()}
    assert set(report["sourceHashes"]) == required_hashes, "incomplete source identity"
    for name, digest in report["sourceHashes"].items():
        assert hashlib.sha256((root / name).read_bytes()).hexdigest() == digest, f"stale source: {name}"
    for row in report["results"]:
        harness, profile, _, _ = json.loads(row["id"])
        resolved = profile if profile in catalog else f"preset-{harness}-{profile}"
        definition = catalog.get(resolved)
        if profile is None:
            outcome = "prepared"
        elif definition is None:
            outcome = "unknown-profile"
        elif "harnesses" in definition and harness not in definition["harnesses"]:
            outcome = "unsupported"
        else:
            outcome = "prepared"
        assert row["outcome"] == outcome, row
    return {
        "scope": report["scope"], "independentRegistryExtraction": True,
        "expected": len(expected), "executed": len(actual), "distinct": len(set(actual)),
        "currentSourceHashesVerified": len(required_hashes),
        "outcomes": dict(collections.Counter(row["outcome"] for row in report["results"])),
        "limitations": report["limitations"],
    }


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify-run-composition.py REPORT.json")
    print(json.dumps(verify(Path(sys.argv[1])), indent=2))
