#!/usr/bin/env python3
"""Reconstruct the complete declared valued-argument syntax product independently."""

import hashlib
import itertools
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
STATES = ["omitted", "single", "repeat-same", "repeat-conflict", "missing", "empty-split", "empty-inline", "inline", "next-flag"]
SOURCES = [
    "scripts/exhaustive-valued-arguments.ts",
    "packages/trellage-runtime/src/native-run/paths.ts",
    "packages/trellage-runtime/src/native-run/run.ts",
    "packages/trellage-launcher/src/guide-api.ts",
]


def verify(report: dict) -> dict:
    if not __debug__:
        raise RuntimeError("verification cannot run with Python assertions disabled")
    command = report["scope"].removesuffix("-valued-argument-syntax")
    assert command in ("run", "guide"), "unknown scope"
    if command == "run":
        source = (ROOT / SOURCES[2]).read_text()
        body = source.split("const parseValuedRunArgument =", 1)[1].split("const parseFlagRunArgument", 1)[0]
        flags = sorted(set(re.findall(r'argument(?: === |\.startsWith\()"(--[a-z-]+)=?"', body)))
    else:
        source = (ROOT / SOURCES[3]).read_text()
        names = dict(re.findall(r'const (\w+Flag) = "(--[a-z-]+)"', source))
        body = re.search(r"const valueFlags = new Set\(\[([^]]+)\]\)", source)
        assert body is not None, "missing valued flag registry"
        flags = sorted(names[name.strip()] for name in body.group(1).split(","))
    assert flags, "empty valued flag registry"
    contexts = [[]] if command == "run" else [[], ["--json"], ["--review"], ["--json", "--review"]]
    domain = report["domains"]
    assert domain["flags"] == flags and domain["states"] == STATES, "incomplete flag/state domain"
    assert domain["contexts"] == contexts and domain["orders"] == ["forward", "reverse"], "incomplete context/order domain"
    assert set(domain["examples"]) == set(flags)
    for values in domain["examples"].values():
        assert len(values) == 2 and all(isinstance(value, str) and value for value in values) and values[0] != values[1], "missing conflicting examples"
    digest = hashlib.sha256()
    executed = 0
    for ordinal, context, order in itertools.product(range(len(STATES) ** len(flags)), range(len(contexts)), ["forward", "reverse"]):
        digest.update(f"{ordinal}:{context}:{order}\n".encode())
        executed += 1
    assert report["expectedCases"] == report["executedCases"] == report["distinctTupleIds"] == executed, "incorrect product or execution counts"
    assert report["idSequenceSha256"] == digest.hexdigest(), "missing, duplicate, or reordered tuple IDs"
    assert report["completeWithinScope"] is True
    allowed = {"accepted", "usage"} if command == "run" else {"accepted", "GuideArgsError", "GuideValidationError"}
    assert set(report["outcomes"]) <= allowed
    assert all(type(value) is int and value >= 0 for value in report["outcomes"].values())
    assert sum(report["outcomes"].values()) == executed, "unclassified cases"
    assert set(report["sourceHashes"]) == set(SOURCES), "incomplete source identity"
    for name, digest in report["sourceHashes"].items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, f"stale source: {name}"
    return {"scope": report["scope"], "independentlyVerified": True, "cases": executed, "outcomes": report["outcomes"], "limitations": report["limitations"]}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify-valued-arguments.py REPORT.json")
    print(json.dumps(verify(json.loads(Path(sys.argv[1]).read_text())), indent=2))
