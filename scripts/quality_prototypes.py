#!/usr/bin/env python3
"""Run independent prototype contracts only when their inputs change."""

import argparse
import platform
import subprocess
import sys

from quality_checks import ROOT, GateError, digest, run_command, write_report

PATHS = {
    "rust": "prototypes/simd-binary-search",
    "swift": "pocs/herdr-trx-guide/macos-overlay",
    "web-foldkit": "prototypes/software-factory/web-foldkit",
    "coordinator": "prototypes/software-factory/coordinator",
}


def commands(name: str) -> list[tuple[str, list[str], bool]]:
    if name == "rust":
        target = str(ROOT / ".quality-results/prototype-builds/rust")
        return [
            ("prepare", ["mise", "install", "rust"], False),
            ("components", ["mise", "exec", "--", "rustup", "component", "add", "rustfmt", "clippy"], False),
            ("dependencies", ["mise", "exec", "--", "cargo", "fetch", "--locked"], False),
            ("format", ["mise", "exec", "--", "cargo", "fmt", "--check"], True),
            (
                "lint",
                [
                    "mise",
                    "exec",
                    "--",
                    "cargo",
                    "clippy",
                    "--target-dir",
                    target,
                    "--locked",
                    "--offline",
                    "--all-targets",
                    "--",
                    "-D",
                    "warnings",
                ],
                True,
            ),
            ("test", ["mise", "exec", "--", "cargo", "test", "--target-dir", target, "--locked", "--offline"], True),
        ]
    if name == "swift":
        if platform.system() != "Darwin":
            raise GateError("The Swift overlay requires macOS; CI runs it on macos-15.")
        return [
            # SwiftPM cannot nest its manifest sandbox inside the enforced offline sandbox.
            ("build", ["swift", "build", "--build-system", "native", "--disable-sandbox"], True),
            ("test", ["bash", "scripts/test.sh", "--disable-sandbox"], True),
        ]
    if name == "coordinator":
        return [
            ("prepare", ["bun", "install", "--frozen-lockfile"], False),
            ("types", ["bun", "run", "check"], True),
            ("test", ["bun", "test"], True),
            ("shared-test", ["bun", "test", "../shared/test"], True),
        ]
    result = [
        ("prepare", ["npm", "ci", "--no-audit", "--no-fund"], False),
        ("types", ["npm", "run", "check"], True),
        ("test", ["npm", "run", "test"], True),
        ("build", ["npm", "exec", "--no", "--", "vite", "build"], True),
    ]
    if name == "web-foldkit":
        result.insert(2, ("lint", ["npm", "run", "lint"], True))
    return result


def run(name: str) -> bool:
    root = ROOT / PATHS[name]
    lock_names = (
        "package.json",
        "package-lock.json",
        "bun.lock",
        "Cargo.toml",
        "Cargo.lock",
        "Package.swift",
        "Package.resolved",
    )
    before = {name: digest(root / name) for name in lock_names if (root / name).is_file()}
    results = []
    for label, args, offline in commands(name):
        if offline:
            args = [sys.executable, str(ROOT / "scripts/test-offline.py"), "--", *args]
        result = run_command(f"{name}-{label}", args, root, timeout=900)
        results.append(result)
        if result["exitCode"]:
            break
    after = {name: digest(root / name) for name in lock_names if (root / name).is_file()}
    if after != before:
        raise GateError(f"{name} validation changed dependency manifests or lockfiles")
    write_report(results, f"prototype-{name}")
    return all(result["exitCode"] == 0 for result in results)


def run_local(names: list[str]) -> bool:
    for name in names:
        if name == "swift" and platform.system() != "Darwin":
            print("[quality] swift: requires macOS; the selected CI lane must run this check.")
        elif not run(name):
            return False
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prototype", choices=PATHS)
    args = parser.parse_args()
    try:
        raise SystemExit(0 if run(args.prototype) else 1)
    except (GateError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"prototype quality: {error}", file=sys.stderr)
        raise SystemExit(1) from error
