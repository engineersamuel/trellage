#!/usr/bin/env python3
"""Run declared exhaustive scopes without mistaking partial coverage for completion."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
BUN = ["bun", "--no-install", "--no-env-file"]
PYTHON = [sys.executable]

# These are required by the task but do not yet have complete executable domains.
# Adding a bounded scope below does not discharge these requirements.
MISSING_COVERAGE = [
    "run: full option product through profile stacks, composition, lifecycle admission and launch",
    "guide: full ordinary-option product combined with modes, service handoffs and process behavior",
    "run and guide: full ordinary option/value domains combined with conflicting duplicates and missing-value syntax",
]


def scopes() -> dict:
    def valued(command: str) -> dict:
        return {
            "run": BUN + ["scripts/exhaustive-valued-arguments.ts", "--command", command],
            "verify": PYTHON + ["scripts/verify-valued-arguments.py", "{report}"],
            "json": True,
        }

    def covered(script: str, command: str, args: list | None = None) -> dict:
        return {
            "run": BUN + [f"scripts/{script}"] + (args or []),
            "verify": BUN + ["scripts/verify-exhaustive-coverage.ts", "--command", command, "{report}"],
            "json": True,
        }

    return {
        "basket": covered("exhaustive-guide-previews.ts", "basket", ["--command", "basket"]),
        "fork": covered("exhaustive-guide-previews.ts", "fork", ["--command", "fork"]),
        "guide-dispatch": covered("exhaustive-guide-dispatch.ts", "guide-dispatch"),
        "guide-process": {
            "run": PYTHON + ["scripts/exhaustive-guide-process.py"],
            "verify": PYTHON + ["scripts/exhaustive-guide-process.py", "--verify", "{report}"],
            "json": True,
        },
        "run-dispatch": {"run": BUN + ["scripts/exhaustive-run-dispatch.ts"], "json": True},
        "run-composition": {
            "run": BUN + ["scripts/exhaustive-run-composition.ts"],
            "verify": PYTHON + ["scripts/verify-run-composition.py", "{report}"],
            "json": True,
        },
        "clean-run": {"run": BUN + ["test", "scripts/exhaustive-clean-run-world.test.ts"], "json": False},
        **{f"{harness}-launch": {
            "run": BUN + ["scripts/exhaustive-native-launch.ts", harness],
            "verify": PYTHON + ["scripts/verify-native-launch.py", "{report}"],
            "json": True,
        } for harness in ("codex", "agency", "jcode", "fx", "headlong", "omp", "prime", "grok", "uji", "pi", "claude", "copilot")},
        "admission-mocks": {"run": BUN + ["test", "scripts/exhaustive-admission-mocks.test.ts", "scripts/exhaustive-host-admission.test.ts", "scripts/exhaustive-runtime-admission.test.ts", "scripts/exhaustive-github-bridge.test.ts", "scripts/exhaustive-firstmate.test.ts"], "json": False},
        "run-launch-values": {"run": BUN + ["test", "scripts/exhaustive-run-launch.test.ts"], "json": False},
        "run-dry-command": {"run": BUN + ["test", "scripts/exhaustive-run-dry-command.test.ts"], "json": False},
        "run-selection": {"run": BUN + ["test", "scripts/exhaustive-run-selection.test.ts"], "json": False},
        "guide-request": {"run": BUN + ["test", "scripts/exhaustive-guide-request.test.ts"], "json": False},
        "guide-services": {"run": BUN + ["test", "scripts/exhaustive-guide-services.test.ts"], "json": False},
        "guide-json": {"run": BUN + ["test", "scripts/exhaustive-guide-json.test.ts"], "json": False},
        "terminal-driver": {"run": PYTHON + ["-m", "unittest", "discover", "-s", "tests", "-p", "test_exhaustive_terminal.py"], "json": False},
        "run-oracle": {"run": BUN + ["test", "scripts/exhaustive-run-oracle.test.ts"], "json": False},
        "adhoc-fixtures": {"run": BUN + ["test", "scripts/exhaustive-adhoc-fixtures.test.ts"], "json": False},
        "run-valued": valued("run"),
        "guide-valued": valued("guide"),
        # No --count: each runner must execute its entire declared Cartesian product.
        "run-behavior": {"run": BUN + ["scripts/exhaustive-run-behavior.ts"], "verify": BUN + ["scripts/verify-run-behavior.ts", "{report}"], "json": True},
        "run-arguments": covered("exhaustive-run-arguments.ts", "run"),
        "guide-arguments": covered("exhaustive-guide-arguments.ts", "guide"),
    }


def write_summary(directory: Path, summary: dict) -> None:
    temporary = directory / "summary.json.tmp"
    temporary.write_text(json.dumps(summary, indent=2) + "\n")
    temporary.replace(directory / "summary.json")


def run_scope(name: str, scope: dict, directory: Path) -> dict:
    report = directory / f"{name}.json"
    stdout = report if scope["json"] else directory / f"{name}.stdout.log"
    stderr = directory / f"{name}.stderr.log"
    result = {"name": name, "command": scope["run"], "stdout": str(stdout), "stderr": str(stderr)}
    with stdout.open("x") as output, stderr.open("x") as errors:
        completed = subprocess.run(scope["run"], cwd=ROOT, stdout=output, stderr=errors)
    result["exitCode"] = completed.returncode
    if completed.returncode:
        result["status"] = "failed"
        return result
    if scope["json"]:
        parsed = json.loads(report.read_text())
        result["reportScope"] = parsed.get("scope")
    if "verify" in scope:
        command = [str(report) if word == "{report}" else word for word in scope["verify"]]
        result["verificationCommand"] = command
        with (directory / f"{name}.verified.json").open("x") as output, stderr.open("a") as errors:
            verified = subprocess.run(command, cwd=ROOT, stdout=output, stderr=errors)
        result["verificationExitCode"] = verified.returncode
        if verified.returncode:
            result["status"] = "verification-failed"
            return result
    result["status"] = "passed"
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", action="store_true", help="show the exact commands and current domain sizes without running tests")
    parser.add_argument("--scope", action="append", choices=list(scopes()), help="run only named scopes; never claims whole-command completeness")
    parser.add_argument("--output", type=Path, help="new evidence directory; existing directories are refused")
    args = parser.parse_args()
    selected = args.scope or list(scopes())
    if len(set(selected)) != len(selected):
        parser.error("a scope may be selected only once")
    if args.plan:
        domain_command = BUN + ["scripts/exhaustive-cli-domains.ts"]
        # Bun's large console output can be truncated when captured through a pipe.
        with tempfile.TemporaryFile(mode="w+") as output:
            subprocess.run(domain_command, cwd=ROOT, stdout=output, check=True)
            output.seek(0)
            domains = json.load(output)
        print(json.dumps({
            "selectedScopes": {name: scopes()[name] for name in selected},
            "declaredCliDomains": domains, "missingCoverage": MISSING_COVERAGE,
            "fullCompletionPossible": not MISSING_COVERAGE,
            "execution": "fresh processes, sequential scopes, full declared products; no range limits or pairwise substitution",
        }, indent=2))
        return 0
    if os.environ.get("TRELLAGE_TEST_OFFLINE") != "1" or not os.environ.get("TRELLAGE_DEV_SOURCES"):
        parser.error("run through bash scripts/test-offline.sh --native-sources")
    directory = (args.output or ROOT / "results" / ("exhaustive-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ"))).resolve()
    directory.mkdir(parents=True, exist_ok=False)
    summary = {
        "schema": 1, "startedAt": datetime.now(timezone.utc).isoformat(),
        "status": "running", "complete": False, "partialSelection": args.scope is not None,
        "selectedScopes": selected, "missingCoverage": MISSING_COVERAGE, "scopes": [],
    }
    write_summary(directory, summary)
    print(f"Exhaustive evidence: {directory}", flush=True)
    try:
        for name in selected:
            print(f"Running exhaustive scope: {name}", flush=True)
            result = run_scope(name, scopes()[name], directory)
            summary["scopes"].append(result)
            write_summary(directory, summary)
            if result["status"] != "passed":
                summary["status"] = "failed"
                print(f"Scope {name} failed; inspect {result['stderr']}", file=sys.stderr)
                return 1
        summary["complete"] = args.scope is None and not MISSING_COVERAGE
        summary["status"] = "complete" if summary["complete"] else "partial"
        if args.scope is None and MISSING_COVERAGE:
            print("Declared scopes passed, but required exhaustive behavior coverage is incomplete:", file=sys.stderr)
            for missing in MISSING_COVERAGE:
                print(f"  {missing}", file=sys.stderr)
            return 2
        return 0
    except BaseException as error:
        summary["status"] = "interrupted" if isinstance(error, KeyboardInterrupt) else "failed"
        summary["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        summary["finishedAt"] = datetime.now(timezone.utc).isoformat()
        write_summary(directory, summary)


if __name__ == "__main__":
    raise SystemExit(main())
