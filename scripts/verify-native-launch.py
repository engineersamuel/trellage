#!/usr/bin/env python3
"""Verify native launch coverage against the current CLI domains and shipped catalog."""

import collections
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parent.parent


def verify(report: dict) -> dict:
    if not __debug__:
        raise RuntimeError("verification cannot run with Python assertions disabled")
    harness = report["harness"]
    assert harness in ("codex", "agency", "jcode", "fx", "headlong", "omp", "prime", "grok", "uji", "pi", "claude", "copilot")
    assert report["scope"] == f"{harness}-run-profile-boolean-product"
    with tempfile.TemporaryFile(mode="w+") as output:
        subprocess.run(["bun", "--no-install", "--no-env-file", "scripts/exhaustive-cli-domains.ts"], cwd=ROOT, stdout=output, check=True)
        output.seek(0)
        domains = json.load(output)
    dimensions = domains["matrices"]["run"]["dimensions"]
    profiles = next(domain["values"] for domain in dimensions if domain["name"] == "profiles")
    flags = [domain["name"] for domain in dimensions if domain["name"].startswith("--") and len(domain["values"]) == 2 and len(domain["values"][1]["argv"]) == 1]
    if harness != "copilot":
        profiles = [profile for profile in profiles if profile["id"] in ("omitted", "base")]
    assert profiles == report["profiles"], "incomplete or changed profile inputs"
    assert flags == report["flags"], "incomplete or changed boolean flags"
    assert len(flags) == 7, "audit changed boolean registry before accepting coverage"
    catalog = tomllib.loads((ROOT / "config.example.toml").read_text())["native"]["profiles"]
    outcomes = collections.Counter()
    digest = hashlib.sha256()
    count = 0
    for profile_index, profile in enumerate(profiles):
        argv = profile["argv"]
        resolved = {name if name in catalog else f"preset-{harness}-{name}" if f"preset-{harness}-{name}" in catalog else name for name in argv}
        for mask in [0] + [1 << index for index in range(len(flags))]:
            selected = {flag for index, flag in enumerate(flags) if mask & (1 << index)}
            dry = "--dry-run" in selected
            strict = "--require-proven-isolation" in selected and "--allow-unproven-isolation" not in selected
            if harness not in ("codex", "grok", "uji", "pi", "claude", "copilot") and selected & {"--resume", "--continue"}:
                outcome = "unsupported"
            elif "clean" in argv:
                outcome = "usage" if len(argv) > 1 else "unsupported" if harness not in ("codex", "pi", "claude", "copilot") else "dry-run" if dry else "launched"
            elif any(name in catalog and "harnesses" in catalog[name] and harness not in catalog[name]["harnesses"] for name in resolved):
                outcome = "unsupported"
            elif any(name not in catalog for name in resolved):
                outcome = "unknown-profile"
            elif dry:
                outcome = "dry-run"
            elif harness == "copilot" and "--resume" in selected:
                outcome = "no-session"
            elif strict and harness != "pi":
                outcome = "isolation"
            else:
                outcome = "launched"
            if harness == "copilot" and "--resume" in selected and not dry and outcome in ("launched", "isolation"):
                outcome = "no-session"
            outcomes[outcome] += 1
            digest.update(f"{profile_index}:{mask}\n".encode())
            count += 1
    assert report["expectedCases"] == report["executedCases"] == report["distinctTupleIds"] == count, "incorrect case counts"
    assert report["idSequenceSha256"] == digest.hexdigest(), "omitted, duplicate, or reordered cases"
    assert report["outcomes"] == dict(outcomes), "incorrect expected launch/rejection outcomes"
    required = set(domains["sourceHashes"]) | {
        "scripts/exhaustive-native-launch.ts", "scripts/exhaustive-clean-run-world.ts", "scripts/exhaustive-admission-mocks.ts", "scripts/exhaustive-host-admission.ts", "scripts/exhaustive-runtime-admission.ts", "scripts/exhaustive-github-bridge.ts", "scripts/exhaustive-firstmate.ts", "scripts/trellage-statusline.sh", "tests/helpers/native-source-fixtures.ts",
    } | {str(file.relative_to(ROOT)) for file in (ROOT / "packages/trellage-runtime/src/native-run").rglob("*") if file.is_file()}
    assert set(report["sourceHashes"]) == required, "incomplete source identity"
    for name, expected in report["sourceHashes"].items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == expected, f"stale source: {name}"
    return {"scope": report["scope"], "independentlyVerified": True, "cases": count, "outcomes": dict(outcomes), "sourceFiles": len(required), "limitations": report["limitations"]}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify-native-launch.py REPORT.json")
    print(json.dumps(verify(json.loads(Path(sys.argv[1]).read_text())), indent=2))
