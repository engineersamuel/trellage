#!/usr/bin/env python3
"""Fail on new advisories; allow only reviewed package-version exceptions."""

import datetime as dt
import json
from pathlib import Path

from quality_checks import ROOT, GateError, executable, files, run_command

EXCEPTIONS = ROOT / ".quality/advisory-exceptions.json"


def finding_keys(report: dict, root: Path = ROOT) -> set[str]:
    findings = set()
    for source in report["results"]:
        source_path = Path(source["source"]["path"])
        if not source_path.is_absolute():
            source_path = root / source_path
        path = str(source_path.resolve().relative_to(root.resolve()))
        for item in source["packages"]:
            package = item["package"]
            for vulnerability in item.get("vulnerabilities", []):
                findings.add(
                    f"{path}|{package['ecosystem']}|{package['name']}|{package['version']}|{vulnerability['id']}"
                )
    return findings


def review_findings(findings: set[str], exceptions: dict) -> bool:
    for key, entry in exceptions.items():
        if not entry.get("reason") or dt.date.fromisoformat(entry["reviewBy"]) < dt.date.today():
            raise GateError(f"Invalid or expired advisory exception: {key}")
    new = findings - exceptions.keys()
    for key in sorted(new):
        print(f"Unaccepted dependency advisory: {key}")
    accepted = findings & exceptions.keys()
    if accepted:
        print(
            f"WARNING: {len(accepted)} existing prototype advisories need the upgrades recorded in {EXCEPTIONS.name}."
        )
    return not new


def scan() -> bool:
    manifests = [path for path in files() if Path(path).name in {"bun.lock", "package-lock.json", "Cargo.lock"}]
    if not manifests:
        raise GateError("No supported lockfiles selected")
    report = ROOT / ".quality-results/advisories.json"
    report.parent.mkdir(exist_ok=True)
    report.unlink(missing_ok=True)
    args = [
        executable("osv-scanner"),
        "scan",
        "source",
        "--no-ignore",
        "--format",
        "json",
        "--output-file",
        str(report),
    ]
    for manifest in manifests:
        args.extend(["--lockfile", manifest])
    result = run_command("advisory-scan", args, timeout=900, review_code=1)
    if result["exitCode"] not in (0, 1) or not report.is_file():
        raise GateError("Dependency advisory scan did not complete; inspect its log.")
    findings = finding_keys(json.loads(report.read_text()))
    if result["exitCode"] and not findings:
        raise GateError("Advisory scanner failed without a complete finding report.")
    exceptions = json.loads(EXCEPTIONS.read_text()) if EXCEPTIONS.exists() else {}
    return review_findings(findings, exceptions)
