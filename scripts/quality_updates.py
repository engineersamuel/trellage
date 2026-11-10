#!/usr/bin/env python3
"""Report tool updates without changing pins or updating agent harnesses."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tomllib

from quality_checks import ROOT, command_environment


def main() -> None:
    pins = tomllib.loads((ROOT / "mise.toml").read_text())["tools"]
    tools = [name for name, version in pins.items() if isinstance(version, str) and version[0].isdigit()]
    result = subprocess.run(
        ["mise", "outdated", "--bump", "--no-global", "--json", *tools],
        cwd=ROOT,
        env=command_environment(),
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
    )
    updates = json.loads(result.stdout)
    directory = ROOT / ".quality-results"
    directory.mkdir(exist_ok=True)
    (directory / "tool-updates.json").write_text(json.dumps(updates, indent=2) + "\n")
    lines = ["### Pinned tool updates", "", "| Tool | Installed | Available |", "|---|---|---|"]
    for name, value in updates.items():
        lines.append(f"| {name} | {value['current']} | {value.get('bump') or value['latest']} |")
    if not updates:
        lines.append("\nAll pinned quality tools are current.")
    report = "\n".join(lines) + "\n"
    print(report)
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(summary).open("a") as output:
            output.write(report)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"tool update report failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
