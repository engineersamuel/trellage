#!/usr/bin/env python3
"""Shared, read-only static gates. Legacy exceptions match exact file contents."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
from functools import lru_cache
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import tomllib

ROOT = Path(__file__).resolve().parents[1]
BASELINE = Path(".quality/baseline.json")
EXCLUDED = (
    "prototypes/software-factory/web-foldkit/repos/",
    "reports/",
    ".quality-results/",
)
CONFIGS = {
    "oxlint": ".eslintrc.json",
    "oxfmt": ".prettierrc.json",
    "ruff": "ruff.toml",
    "ruff-format": "ruff.toml",
    "typos": "_typos.toml",
    "rumdl": ".rumdl.toml",
    "knip": "knip.json",
    "architecture": ".dependency-cruiser.cjs",
    "syncpack": ".syncpackrc.json",
}
TOOLS = {
    "oxlint": "oxlint",
    "oxfmt": "oxfmt",
    "ruff": "ruff",
    "ruff-format": "ruff",
    "shellcheck": "shellcheck",
    "jactionlint": "github:jdx/jactionlint",
    "agnix": "github:agent-sh/agnix",
    "typos": "typos",
    "rumdl": "github:rvben/rumdl",
    "hadolint": "hadolint",
    "knip": "knip",
    "architecture": "dependency-cruiser",
    "syncpack": "npm:syncpack",
}
STATIC = (
    "oxlint",
    "oxfmt",
    "ruff",
    "ruff-format",
    "shellcheck",
    "jactionlint",
    "agnix",
    "typos",
    "rumdl",
    "hadolint",
    "syntax",
    "config",
)
BASELINABLE = set(STATIC) - {"syntax", "config", "jactionlint"}


class GateError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def git_local_variables() -> tuple[str, ...]:
    result = subprocess.run(
        ["git", "rev-parse", "--local-env-vars"],
        check=True,
        capture_output=True,
        text=True,
    )
    return tuple(result.stdout.splitlines())


def command_environment(*, index: bool = False) -> dict[str, str]:
    env = os.environ.copy()
    for key in git_local_variables():
        if key != "GIT_INDEX_FILE" or not index:
            env.pop(key, None)
    return env


def git(
    root: Path, *args: str, check: bool = True, index: bool = False, input: bytes | None = None
) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(root), *args],
        env=command_environment(index=index),
        input=input,
        check=check,
        capture_output=True,
    )


def owned(path: str) -> bool:
    parts = Path(path).parts
    return (
        not path.startswith(EXCLUDED)
        and not any(part in {"node_modules", ".git", "dist", "coverage", ".vitest"} for part in parts)
        and not path.startswith(".quality/")
        and not any(part.startswith(".contract-") for part in parts)
    )


def files(root: Path = ROOT, *, owned_only: bool = True) -> list[str]:
    result = git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")
    return sorted(
        {
            path
            for path in os.fsdecode(result.stdout).split("\0")
            if path and (not owned_only or owned(path)) and (root / path).is_file() and not (root / path).is_symlink()
        }
    )


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def settings_digest(root: Path, name: str) -> str:
    tool = TOOLS.get(name, name)
    pins = tomllib.loads((root / "mise.toml").read_text())["tools"]
    package = json.loads((root / "package.json").read_text())
    version = package["devDependencies"].get(tool, pins.get(tool))
    if version is None:
        raise GateError(f"No version pin for {name}")
    config = root / CONFIGS[name] if name in CONFIGS else None
    return hashlib.sha256(str(version).encode() + (config.read_bytes() if config is not None else b"")).hexdigest()


def read_baseline(root: Path) -> dict:
    path = root / BASELINE
    if not path.exists():
        return {"version": 1, "checks": {}}
    value = json.loads(path.read_text())
    if value.get("version") != 1 or not isinstance(value.get("checks"), dict):
        raise GateError(f"Invalid baseline: {path}")
    for name, group in value["checks"].items():
        if name not in BASELINABLE | {"knip", "architecture"}:
            raise GateError(f"Baselines are not permitted for {name}")
        for entry in group.get("files", {}).values():
            validate_baseline_entry(name, entry)
    return value


def validate_baseline_entry(name: str, entry: dict) -> None:
    if not entry.get("reason") or not re.fullmatch(r"[a-f0-9]{64}", entry.get("sha256", "")):
        raise GateError(f"Invalid {name} baseline entry")
    if "reviewBy" in entry and dt.date.fromisoformat(entry["reviewBy"]) < dt.date.today():
        raise GateError(f"{name} baseline review expired on {entry['reviewBy']}")


def baseline_files(root: Path, name: str, paths: list[str], baseline: dict) -> tuple[list[str], int]:
    group = baseline["checks"].get(name, {})
    if group.get("settings") != settings_digest(root, name):
        return paths, 0
    accepted = group.get("files", {})
    remaining = [path for path in paths if accepted.get(path, {}).get("sha256") != digest(root / path)]
    return remaining, len(paths) - len(remaining)


def shell(root: Path, path: str) -> str | None:
    with (root / path).open("rb") as source:
        first = source.readline(4096).rstrip(b"\r\n").decode("utf-8", errors="replace")
    if first in ("#!/bin/sh", "#!/usr/bin/env sh"):
        return "sh"
    if first in ("#!/bin/bash", "#!/usr/bin/env bash") or path.endswith(".sh"):
        return "bash"
    return None


def selected(root: Path, name: str, paths: list[str]) -> list[str]:
    def matches(path: str) -> bool:
        suffix = Path(path).suffix
        if name == "oxlint":
            return suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
        if name == "oxfmt":
            return suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"} and Path(
                path
            ).name not in {
                "package-lock.json",
                "npm-shrinkwrap.json",
            }
        if name in {"ruff", "ruff-format"}:
            return suffix == ".py"
        if name in {"shellcheck", "syntax"}:
            return shell(root, path) is not None
        if name == "jactionlint":
            return path.startswith((".github/workflows/", ".github/actions/")) or path == ".github/dependabot.yml"
        if name == "agnix":
            return Path(path).name in {"AGENTS.md", "SKILL.md"} or path in {
                ".agents/mcp_config.json",
                ".github/mcp.json",
            }
        if name == "typos":
            return suffix in {".md", ".py", ".sh", ".ts", ".tsx", ".yml", ".yaml", ".toml"}
        if name == "rumdl":
            return suffix == ".md"
        if name == "hadolint":
            return Path(path).name.startswith("Dockerfile")
        if name == "config":
            return suffix in {".json", ".toml"}
        raise GateError(f"Unknown check: {name}")

    return [path for path in paths if owned(path) and matches(path)]


def executable(name: str, tools_root: Path = ROOT) -> str:
    if name in {"oxlint", "oxfmt", "depcruise", "knip"}:
        candidate = tools_root / "node_modules/.bin" / name
        found = str(candidate) if candidate.is_file() else None
    else:
        found = shutil.which(name)
    if found:
        return found
    raise GateError(f"{name} is missing. Run mise run quality:setup.")


def command(root: Path, name: str, paths: list[str], tools_root: Path = ROOT) -> list[str]:
    arguments = [f"./{path}" for path in paths]
    if name == "oxlint":
        return [executable(name, tools_root), "-c", str(root / CONFIGS[name]), "--deny-warnings", *arguments]
    if name == "oxfmt":
        return [executable(name, tools_root), "--check", "--config", str(root / CONFIGS[name]), *arguments]
    if name == "ruff":
        return [executable("ruff"), "check", "--config", str(root / "ruff.toml"), *arguments]
    if name == "ruff-format":
        return [executable("ruff"), "format", "--check", "--config", str(root / "ruff.toml"), *arguments]
    if name == "shellcheck":
        return [executable(name), "--severity=warning", *arguments]
    if name == "jactionlint":
        return [executable(name), "--strict-exit", "--no-online", *arguments]
    if name == "agnix":
        return [executable(name), "--strict", *arguments]
    if name == "typos":
        return [executable(name), "--config", str(root / "_typos.toml"), *arguments]
    if name == "rumdl":
        return [executable(name), "check", "--config", str(root / ".rumdl.toml"), *arguments]
    if name == "hadolint":
        return [executable(name), "--failure-threshold", "warning", *arguments]
    raise GateError(f"No command for {name}")


def run_command(
    name: str, args: list[str], root: Path = ROOT, *, timeout: int = 600, review_code: int | None = None
) -> dict:
    started = time.monotonic()
    directory = ROOT / ".quality-results"
    directory.mkdir(exist_ok=True)
    log = directory / f"{name}-{time.time_ns()}.log"
    env = command_environment()
    with log.open("w") as output:
        child = subprocess.Popen(
            args, cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True
        )
        try:
            code = child.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            import signal

            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise GateError(f"{name} exceeded {timeout}s; log: {log}") from None
    result = {
        "name": name,
        "seconds": round(time.monotonic() - started, 3),
        "exitCode": code,
        "log": str(log.relative_to(ROOT)),
    }
    status = "PASS" if code == 0 else "REVIEW" if code == review_code else "FAIL"
    print(f"[quality] {name}: {status} ({result['seconds']}s)", flush=True)
    if code:
        print("\n".join(log.read_text(errors="replace").splitlines()[-60:]), file=sys.stderr)
    return result


def unique_keys(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise GateError(f"Duplicate configuration key: {key}")
        result[key] = value
    return result


def check_config(root: Path, paths: list[str]) -> None:
    for path in paths:
        text = (root / path).read_text()
        if path.endswith(".toml"):
            tomllib.loads(text)
        else:
            value = json.loads(text, object_pairs_hook=unique_keys)
            if path in {".agents/mcp_config.json", ".github/mcp.json"}:
                if not isinstance(value, dict) or not isinstance(value.get("mcpServers"), dict):
                    raise GateError(f"{path}: expected an mcpServers object")


def check_syntax(root: Path, paths: list[str]) -> list[dict]:
    results = []
    for interpreter in ("bash", "sh"):
        batch = [str(root / path) for path in paths if shell(root, path) == interpreter]
        if batch:
            script = f'for file; do {interpreter} -n -- "$file" || exit; done'
            results.append(run_command(f"syntax-{interpreter}", [interpreter, "-c", script, "syntax", *batch], root))
    return results


def check_one(root: Path, name: str, paths: list[str], baseline: dict, tools_root: Path = ROOT) -> list[dict]:
    paths = selected(root, name, paths)
    if not paths:
        return []
    if name == "config":
        check_config(root, paths)
        return [{"name": name, "exitCode": 0, "files": len(paths), "seconds": 0}]
    if name == "syntax":
        return check_syntax(root, paths)
    paths, accepted = baseline_files(root, name, paths, baseline)
    if accepted:
        print(f"[quality] {name}: {accepted} unchanged legacy file exception(s)", flush=True)
    results = []
    size = 100
    for offset in range(0, len(paths), size):
        results.append(run_command(name, command(root, name, paths[offset : offset + size], tools_root), root))
    return results


def write_report(results: list[dict], label: str) -> None:
    directory = ROOT / ".quality-results"
    directory.mkdir(exist_ok=True)
    path = directory / f"{label}-{time.time_ns()}.json"
    path.write_text(json.dumps({"checks": results}, indent=2) + "\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with Path(summary).open("a") as output:
            output.write(f"### {label}\n\n| Check | Result | Seconds |\n|---|---|---:|\n")
            for result in results:
                output.write(
                    f"| {result['name']} | {'pass' if result['exitCode'] == 0 else 'FAIL'} | {result['seconds']} |\n"
                )


def check_files(root: Path, paths: list[str], names: list[str] | None = None, tools_root: Path = ROOT) -> bool:
    baseline = read_baseline(root)
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        pending = [
            pool.submit(check_one, root, name, paths, baseline, tools_root)
            for name in (names if names is not None else STATIC)
        ]
        for future in pending:
            results.extend(future.result())
    write_report(results, "static")
    return all(result["exitCode"] == 0 for result in results)


def baseline_entry(root: Path, path: str, name: str) -> dict:
    previous = git(root, "show", f"HEAD:{path}", check=False)
    if previous.returncode or previous.stdout != (root / path).read_bytes():
        raise GateError(f"Fix new or modified file before recording a baseline: {path} ({name})")
    entry = {
        "sha256": digest(root / path),
        "reason": "Existing findings at quality-gate adoption; changes to this file must pass.",
    }
    if name in {"oxlint", "ruff", "shellcheck", "agnix", "hadolint"}:
        entry["reviewBy"] = (dt.date.today() + dt.timedelta(days=90)).isoformat()
    return entry


def baseline_entries(root: Path, name: str) -> dict:
    entries = {}
    for path in selected(root, name, files(root)):
        result = subprocess.run(command(root, name, [path]), cwd=root, capture_output=True)
        finding_code = 2 if name == "typos" else 1
        if result.returncode not in (0, finding_code):
            raise GateError(f"{name} could not check {path}:\n{os.fsdecode(result.stderr)}")
        if result.returncode:
            entries[path] = baseline_entry(root, path, name)
    return entries


def record_baseline(root: Path, names: list[str]) -> None:
    baseline = read_baseline(root)
    for name in names:
        if name not in BASELINABLE:
            raise GateError(f"Cannot baseline {name}")
        entries = baseline_entries(root, name)
        baseline["checks"][name] = {"settings": settings_digest(root, name), "files": entries}
        print(f"{name}: recorded {len(entries)} existing file exceptions")
    destination = root / BASELINE
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(baseline, indent=2, sort_keys=True) + "\n")


def knip_symbols(entry: object) -> str:
    if isinstance(entry, list):
        return ",".join(sorted(knip_symbols(item) for item in entry))
    return entry.get("name", "") if isinstance(entry, dict) else str(entry)


def knip_issue_findings(issue: dict) -> set[str]:
    return {
        f"{kind}:{issue['file']}:{knip_symbols(entry)}"
        for kind, entries in issue.items()
        if isinstance(entries, list)
        for entry in entries
    }


def graph_findings(name: str, value: dict) -> set[str]:
    if name == "knip":
        result = {f"file:{path}" for path in value.get("files", [])}
        for issue in value["issues"]:
            result.update(knip_issue_findings(issue))
        return result
    if not value["modules"]:
        raise GateError("Architecture scan returned an empty source graph")
    return {
        ":".join(
            [
                issue["rule"]["name"],
                *dict.fromkeys([issue["from"], issue["to"], *(member["name"] for member in issue.get("cycle", []))]),
            ]
        )
        for issue in value["summary"]["violations"]
    }


def validate_graph_inputs(root: Path, value: dict) -> None:
    expected = {
        path
        for path in files(root)
        if path.startswith(("bin/", "scripts/", "packages/"))
        and Path(path).suffix in {".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"}
        and not path.endswith((".d.ts", ".d.mts", ".d.cts"))
    }
    observed = {module["source"] for module in value["modules"]}
    missing = expected - observed
    if not expected or missing:
        raise GateError(f"Architecture scan omitted maintained source inputs: {', '.join(sorted(missing)[:10])}")


def scan_graph(root: Path, name: str, args: list[str]) -> tuple[set[str], float]:
    started = time.monotonic()
    run = subprocess.run(args, cwd=root, capture_output=True, text=True, timeout=300, env=command_environment())
    directory = ROOT / ".quality-results"
    directory.mkdir(exist_ok=True)
    (directory / f"{name}-{time.time_ns()}.log").write_text(run.stdout + "\n" + run.stderr)
    if run.returncode not in (0, 1):
        raise GateError(f"{name} failed to analyze the project:\n{run.stderr}\n{run.stdout}")
    try:
        value = json.loads(run.stdout)
        if name == "architecture":
            validate_graph_inputs(root, value)
        findings = graph_findings(name, value)
    except (KeyError, TypeError, ValueError) as error:
        raise GateError(f"{name} returned an invalid finding report: {error}") from error
    if run.returncode and not findings:
        raise GateError(f"{name} failed without a complete finding report:\n{run.stderr}")
    return findings, round(time.monotonic() - started, 3)


def graph_baseline(root: Path, name: str, findings: set[str]) -> dict:
    paths = {
        path
        for finding in findings
        for path in (finding.split(":")[1:] if name == "architecture" else [finding.split(":", 2)[1]])
    }
    for path in paths:
        baseline_entry(root, path, name)
    return {
        "settings": settings_digest(root, name),
        "findings": sorted(findings),
        "reason": "Existing graph findings at adoption; new findings fail.",
    }


def analysis(root: Path, record: bool = False) -> bool:
    baseline = read_baseline(root)
    results = []
    checks = {
        "knip": [executable("knip"), "--reporter", "json", "--no-progress"],
        "architecture": [
            executable("depcruise"),
            "--config",
            ".dependency-cruiser.cjs",
            "--output-type",
            "json",
            "bin",
            "scripts",
            "packages",
        ],
    }
    for name, args in checks.items():
        findings, seconds = scan_graph(root, name, args)
        group = baseline["checks"].get(name, {})
        known = set(group.get("findings", [])) if group.get("settings") == settings_digest(root, name) else set()
        if record:
            baseline["checks"][name] = graph_baseline(root, name, findings)
        else:
            for finding in sorted(findings - known):
                print(f"{name}: {finding}", file=sys.stderr)
            print(f"[quality] {name}: {len(findings & known)} existing findings; {len(findings - known)} new")
        results.append({"name": name, "seconds": seconds, "exitCode": int(bool(findings - known) and not record)})
    if record:
        destination = root / BASELINE
        destination.parent.mkdir(exist_ok=True)
        destination.write_text(json.dumps(baseline, indent=2, sort_keys=True) + "\n")
    results.append(run_command("syncpack", [executable("syncpack"), "lint"], root))
    write_report(results, "analysis")
    return all(result["exitCode"] == 0 for result in results)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--check", action="append", choices=STATIC)
    parser.add_argument("--analysis", action="store_true")
    parser.add_argument("--record-baseline", action="store_true", help="Explicit, review-required baseline maintenance")
    parser.add_argument("files", nargs="*")
    args = parser.parse_args(argv)
    try:
        if args.analysis:
            return 0 if analysis(ROOT, args.record_baseline) else 1
        if args.record_baseline:
            if not args.check:
                raise GateError("Select each baseline explicitly with --check")
            record_baseline(ROOT, args.check)
            return 0
        paths = files() if args.all else args.files
        if not paths and not args.all:
            raise GateError("Select --all or explicit files; an empty selection is not a full check.")
        return 0 if check_files(ROOT, paths, args.check) else 1
    except (GateError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"quality: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
