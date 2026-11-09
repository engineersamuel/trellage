#!/usr/bin/env python3
"""Select the same conservative quality gates for hooks, local work, and CI."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

from quality_checks import (
    BASELINE,
    CONFIGS,
    ROOT,
    GateError,
    analysis,
    check_files,
    executable,
    files,
    git,
    owned,
    run_command,
    write_report,
)
from quality_secrets import FIXTURES, SCANNER_CONFIG, public_fixtures

GLOBAL = {
    "Makefile",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    "tsconfig.base.json",
    "mise.toml",
    "lefthook.yml",
    "ruff.toml",
    "knip.json",
    ".dependency-cruiser.cjs",
    ".syncpackrc.json",
}
NATIVE = {
    "agency": "native-agency-profile",
    "claude": "native-claude-profile",
    "copilot": "native-copilot-profiles",
    "jcode": "native-jcode-profile",
    "omp": "native-omp-profile",
    "prime": "native-prime-profile",
}
PROTOTYPES = {
    "prototypes/simd-binary-search/": "rust",
    "pocs/herdr-trx-guide/macos-overlay/": "swift",
    "prototypes/software-factory/web-react/": "web-react",
    "prototypes/software-factory/web-foldkit/": "web-foldkit",
    "prototypes/software-factory/coordinator/": "coordinator",
    "prototypes/software-factory/shared/": "web-shared",
}
ALL_PROTOTYPES = set(PROTOTYPES.values()) - {"web-shared"}
BOOTSTRAP = {
    "scripts/install-source-runtime.sh",
    "scripts/bun-runtime.sh",
    "scripts/bun-runtime.json",
    "scripts/bootstrap-development-dependencies.sh",
    "scripts/prepare-test-cache.sh",
}
BASE_TARGETS = {"quality-contract", "publication-policy", "shell-syntax"}
PACKAGE_TARGETS = {
    "trellage-guide-core": {"profile-guide-contract", "launcher", "conversation-source", "source-runtime"},
    "trellage-launcher": {"launcher"},
    "trellage-conversation-source": {"conversation-source", "launcher"},
}


def shared_input(path: str) -> bool:
    return path in GLOBAL | BOOTSTRAP or path.startswith(
        (
            ".github/",
            ".quality/",
            "scripts/quality",
            "scripts/test-offline",
            "scripts/install-quality",
            "scripts/install-lefthook",
            "packages/trellage-runtime/",
            "bin/",
            "prototypes/trellage-router/",
            "prototypes/trellage-claude-common/",
            "prototypes/trellage-codex-common/",
        )
    )


def package_selection(path: str) -> set[str] | None:
    for package, targets in PACKAGE_TARGETS.items():
        if path.startswith(f"packages/{package}/"):
            result = set(targets)
            if package == "trellage-launcher" and "/src/" in path:
                result.update({"profile-guide-contract", "cli-matrix-contract", "script-tests"})
            return result
    return None


def contract_selection(path: str) -> tuple[set[str], bool] | None:
    if path.startswith(("profile-guides/", "profiles/", ".agents/")) or path in {
        "config.example.toml",
        "skills-lock.json",
    }:
        return {"profile-guide-contract", "floating-skills-contract", "agent-harness", "profile-matrix-test"}, True
    match = re.match(r"prototypes/trellage-([a-z]+)-profiles/", path)
    if match and match[1] in NATIVE:
        return {NATIVE[match[1]], "native-profile-router", "headless-matrix-static-test"}, True
    if path.startswith(("scripts/exhaustive-", "scripts/verify-", "tests/exhaustive/")):
        return {"script-tests", "cli-matrix-contract"}, True
    if path.startswith(("Dockerfile", "compose", "harnesses/")):
        return {"manifest", "contract", "adapter", "copilot-image", "runner", "evidence"}, False
    if path in {
        ".gitignore",
        ".eslintrc.json",
        ".prettierrc.json",
        "_typos.toml",
        ".rumdl.toml",
        "lychee.toml",
        "AGENTS.md",
    }:
        return {"agent-harness"}, False
    if path.startswith(("docs/", "README")) or path == "LICENSE":
        return set(), False
    return None


def shared_prototypes(path: str) -> set[str]:
    if path == "mise.toml" or path.startswith(
        (".github/", "scripts/quality", "scripts/test-offline", "scripts/install-quality")
    ):
        return ALL_PROTOTYPES
    if path in {"package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "tsconfig.base.json"} or path.startswith(
        "packages/trellage-runtime/"
    ):
        return {"coordinator"}
    return set()


def classify(path: str) -> dict:
    if shared_input(path):
        return {"full": True, "prototypes": shared_prototypes(path), "reason": f"shared input: {path}"}
    package = package_selection(path)
    if package is not None:
        return {"targets": package, "macos": True, "analysis": True, "prototypes": {"coordinator"}}
    for prefix, name in PROTOTYPES.items():
        if path.startswith(prefix):
            names = {"web-react", "web-foldkit", "coordinator"} if name == "web-shared" else {name}
            return {"prototypes": names}
    contracts = contract_selection(path)
    if contracts is not None:
        targets, macos = contracts
        return {"targets": targets, "macos": macos}
    return {"full": True, "reason": f"unclassified path: {path}"}


def plan(paths: list[str], fallback: str | None = None, *, complete: bool = False) -> dict:
    selections = [classify(path) for path in paths]
    full = complete or fallback is not None or any(item.get("full") for item in selections)
    targets = set(BASE_TARGETS).union(*(item.get("targets", set()) for item in selections))
    prototypes = set().union(*(item.get("prototypes", set()) for item in selections))
    if complete or fallback:
        prototypes.update(ALL_PROTOTYPES)
    value = {
        "version": 1,
        "full": full,
        "macos": full or any(item.get("macos") for item in selections),
        "analysis": full or any(item.get("analysis") for item in selections),
        "targets": sorted(targets),
        "files": sorted(set(paths)),
        "prototypes": sorted(prototypes),
        "reasons": plan_reasons(selections, fallback),
    }
    value["dependencies"] = dependency_inputs(paths, full)
    return value


def plan_reasons(selections: list[dict], fallback: str | None) -> list[str]:
    reasons = {item["reason"] for item in selections if "reason" in item}
    if fallback:
        reasons.add(fallback)
    return sorted(reasons)


def read_plan(path: str) -> dict:
    value = json.loads(Path(path).read_text())
    flags = {"full", "macos", "analysis", "dependencies"}
    lists = {"targets", "files", "prototypes", "reasons"}
    if not isinstance(value, dict) or set(value) != {"version"} | flags | lists:
        raise GateError("Invalid quality plan fields")
    if type(value["version"]) is not int or value["version"] != 1:
        raise GateError("Unsupported quality plan version")
    if not all(type(value[name]) is bool for name in flags):
        raise GateError("Quality plan flags must be booleans")
    for name in lists:
        if not isinstance(value[name], list) or any(not isinstance(item, str) or not item for item in value[name]):
            raise GateError(f"Invalid quality plan list: {name}")
    validate_plan_selection(value)
    return value


def validate_plan_selection(value: dict) -> None:
    if not BASE_TARGETS <= set(value["targets"]) or any(
        not re.fullmatch(r"[a-z][a-z0-9-]*", target) for target in value["targets"]
    ):
        raise GateError("Invalid quality plan targets")
    if not set(value["prototypes"]) <= ALL_PROTOTYPES:
        raise GateError("Unknown quality plan prototype")
    if value["full"] and not all(value[name] for name in ("macos", "analysis", "dependencies")):
        raise GateError("A full quality plan cannot omit a required lane")
    for path in value["files"]:
        safe_path(path)


def dependency_inputs(paths: list[str], full: bool) -> bool:
    return full or any(path.endswith(("package.json", "bun.lock", "package-lock.json", "Cargo.lock")) for path in paths)


def changed_files(
    root: Path, base: str | None, head: str = "HEAD", *, local: bool = False
) -> tuple[list[str], str | None]:
    if not base:
        return files(root), "no comparison base; selecting the full offline suite"
    merge = git(root, "merge-base", "--", base, head, check=False)
    if merge.returncode:
        return files(root), "comparison base unavailable; selecting the full offline suite"
    result = git(root, "diff", "--name-only", "--no-renames", "-z", merge.stdout.decode().strip(), head, "--")
    paths = set(filter(None, os.fsdecode(result.stdout).split("\0")))
    if local:
        work = git(root, "diff", "--name-only", "--no-renames", "-z", "HEAD", "--")
        paths.update(filter(None, os.fsdecode(work.stdout).split("\0")))
        untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z")
        paths.update(filter(None, os.fsdecode(untracked.stdout).split("\0")))
    return sorted(paths), None


def default_base(root: Path, remote: str = "origin") -> str | None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", remote):
        return None
    result = git(root, "symbolic-ref", "--quiet", f"refs/remotes/{remote}/HEAD", check=False)
    if result.returncode == 0:
        return result.stdout.decode().strip()
    return None


def pushed_files(root: Path, updates: str, remote: str) -> tuple[list[str], str | None, list[tuple[str | None, str]]]:
    paths = set()
    fallback = None
    ranges = []
    head = git(root, "rev-parse", "HEAD").stdout.decode().strip()
    for line in updates.splitlines():
        local_sha, remote_sha = push_update(line)
        if set(local_sha) == {"0"}:
            continue
        commit = git(root, "rev-parse", "--verify", f"{local_sha}^{{commit}}", check=False)
        if commit.returncode or commit.stdout.decode().strip() != head:
            raise GateError("Push validation requires the pushed commit to be checked out in this worktree.")
        base = default_base(root, remote) if set(remote_sha) == {"0"} else remote_sha
        changed, reason = changed_files(root, base, head)
        paths.update(changed)
        fallback = fallback or reason
        ranges.append((base if reason is None else None, head))
    return sorted(paths), fallback, ranges


def push_update(line: str) -> tuple[str, str]:
    fields = line.split()
    if len(fields) != 4 or any(
        not re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", value) for value in (fields[1], fields[3])
    ):
        raise GateError("Invalid pre-push ref input")
    return fields[1], fields[3]


@contextmanager
def staged_snapshot(root: Path, paths: list[str]):
    """Materialize index blobs; never stash, reset, stage, or modify caller files."""
    with tempfile.TemporaryDirectory(prefix="trellage-quality-index-") as directory:
        snapshot = Path(directory)
        for path in paths:
            safe_path(path)
        entries = index_entries(
            root, set(paths) | set(CONFIGS.values()) | {str(BASELINE), str(FIXTURES), str(SCANNER_CONFIG)}
        )
        if entries:
            requests = b"".join(object_id.encode() + b"\n" for _, object_id in entries)
            blobs = io.BytesIO(git(root, "cat-file", "--batch", input=requests).stdout)
            for name, object_id in entries:
                header = blobs.readline().decode().split()
                if len(header) != 3 or header[:2] != [object_id, "blob"]:
                    raise GateError(f"Cannot read staged blob: {name}")
                content = blobs.read(int(header[2]))
                if len(content) != int(header[2]) or blobs.read(1) != b"\n":
                    raise GateError(f"Incomplete staged blob: {name}")
                destination = snapshot / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(content)
        yield snapshot


def safe_path(name: str) -> None:
    if Path(name).is_absolute() or ".." in Path(name).parts:
        raise GateError(f"Unsafe staged path: {name}")


def index_entries(root: Path, required: set[str]) -> list[tuple[str, str]]:
    entries = []
    for record in git(root, "ls-files", "--stage", "-z", index=True).stdout.split(b"\0"):
        if not record:
            continue
        metadata, name = os.fsdecode(record).split("\t", 1)
        mode, object_id, stage = metadata.split()
        safe_path(name)
        if stage != "0":
            raise GateError(f"Unmerged index entry: {name}")
        if mode in {"100644", "100755"} and (owned(name) or name in required):
            entries.append((name, object_id))
    return entries


def secrets(root: Path, paths: list[str]) -> bool:
    # Only explicitly selected repository files enter the scanner, never host state.
    fixtures = public_fixtures(root)
    with tempfile.TemporaryDirectory(prefix="trellage-quality-secrets-") as directory:
        destination = Path(directory)
        for path in paths:
            if path in fixtures:
                continue
            if Path(path).is_absolute() or ".." in Path(path).parts:
                raise GateError(f"Unsafe secret-scan path: {path}")
            source = root / path
            if source.is_file() and not source.is_symlink():
                target = destination / path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
        report = ROOT / ".quality-results" / f"secrets-{time.time_ns()}.json"
        result = run_command(
            "secrets",
            [
                executable("betterleaks"),
                "dir",
                str(destination),
                "--redact",
                "--validation=false",
                "--exit-code",
                "1",
                "--report-format",
                "json",
                "--report-path",
                str(report),
                *secret_flags(root),
            ],
            root,
        )
        if result["exitCode"] not in (0, 1) or not report.is_file():
            raise GateError("File secret scan did not complete; inspect its log.")
        findings = json.loads(report.read_text())
        if not isinstance(findings, list) or result["exitCode"] and not findings:
            raise GateError("File secret scanner returned an incomplete finding report.")
        for finding in findings:
            finding["File"] = str(Path(finding["File"]).relative_to(destination))
        report.write_text(json.dumps(findings, indent=2) + "\n")
        return not findings


def secret_flags(root: Path) -> list[str]:
    return [
        "--config",
        str(root / SCANNER_CONFIG),
        "--ignore-gitleaks-allow",
        "--gitleaks-ignore-path",
        os.devnull,
    ]


def secret_range(root: Path, base: str | None, head: str) -> bool:
    public_fixtures(root)
    report = ROOT / ".quality-results" / f"secret-range-{time.time_ns()}.json"
    result = run_command(
        "secret-range",
        [
            executable("betterleaks"),
            "git",
            str(root),
            "--redact",
            "--exit-code",
            "1",
            "--validation=false",
            "--log-opts",
            f"{base}..{head}" if base else head,
            "--report-format",
            "json",
            "--report-path",
            str(report),
            *secret_flags(root),
        ],
        root,
        review_code=1,
    )
    if result["exitCode"] not in (0, 1) or not report.is_file():
        raise GateError("Commit secret scan did not complete; inspect its log.")
    findings = json.loads(report.read_text())
    if result["exitCode"] and not findings:
        raise GateError("Commit secret scanner failed without a finding report.")
    fixtures = json.loads((root / FIXTURES).read_text()) if (root / FIXTURES).is_file() else {}
    unreviewed = []
    for finding in findings:
        entry = fixtures.get(finding["File"])
        if entry:
            blob = git(root, "show", f"{finding['Commit']}:{finding['File']}", check=False)
            if blob.returncode == 0 and hashlib.sha256(blob.stdout).hexdigest() == entry["sha256"]:
                continue
        unreviewed.append(finding)
    if unreviewed:
        print(f"Unreviewed secrets in pushed history: {len(unreviewed)}; redacted report: {report}", file=sys.stderr)
    return not unreviewed


def test_commands(value: dict, lane: str) -> list[tuple[str, list[str]]]:
    if lane == "macos-launcher":
        commands = [("macos-launcher", ["make", "launcher"])]
    elif lane == "macos-runtime":
        commands = [
            ("macos-runtime", ["make", "conversation-source", "source-runtime", "profile-guide-contract"]),
        ]
    elif value["full"]:
        commands = [("offline-prepare", ["make", "test-prepare"]), ("full-offline", ["make", "test"])]
    else:
        commands = [("isolation-canaries", ["make", "offline-llm-contract"])]
        if set(value["targets"]) - BASE_TARGETS:
            commands.append(("offline-prepare", ["make", "test-prepare"]))
        parallel = sorted(
            set(value["targets"]) - {"native-omp-profile", "native-claude-profile", "native-profile-router"}
        )
        commands.append(
            (
                "affected-contracts",
                [
                    sys.executable,
                    "scripts/test-offline.py",
                    "--",
                    "make",
                    "--no-print-directory",
                    "TEST_TIMING=1",
                    "-j2",
                    *parallel,
                ],
            )
        )
        for target in ("native-omp-profile", "native-claude-profile", "native-profile-router"):
            if target in value["targets"]:
                commands.append(
                    (target, [sys.executable, "scripts/test-offline.py", "--", "make", "TEST_TIMING=1", target])
                )
    return commands


def run_tests(value: dict, *, lane: str = "linux") -> bool:
    results = []
    commands = test_commands(value, lane)
    for name, args in commands:
        if lane.startswith("macos"):
            args = [sys.executable, "scripts/test-offline.py", "--", *args]
        result = run_command(name, args, timeout=5400)
        results.append(result)
        if result["exitCode"]:
            break
    write_report(results, lane)
    return all(result["exitCode"] == 0 for result in results)


def gate_results(value: dict, results: dict) -> bool:
    expected = {"plan", "static", "linux"}
    optional = {
        "macos-tests": value["macos"],
        "dependencies": value["dependencies"],
        "prototypes": bool(value["prototypes"]),
    }
    for name in expected:
        if results.get(name, {}).get("result") != "success":
            return False
    for name, required in optional.items():
        if results.get(name, {}).get("result") not in ({"success"} if required else {"success", "skipped"}):
            return False
    return True


def network(kind: str) -> bool:
    if kind == "dependencies":
        from quality_advisories import scan

        return scan()
    docs = [path for path in files() if path.endswith(".md") and not path.startswith(("prototypes/", "pocs/"))]
    return (
        run_command(
            "links",
            [
                executable("lychee"),
                "--config",
                "lychee.toml",
                "--cache",
                "--no-progress",
                *docs,
            ],
            timeout=1800,
        )["exitCode"]
        == 0
    )


def check_staged() -> bool:
    git(ROOT, "diff", "--cached", "--check", index=True)
    result = git(ROOT, "diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", index=True)
    paths = list(filter(None, os.fsdecode(result.stdout).split("\0")))
    if not paths:
        print("quality: no staged files")
        return True
    with staged_snapshot(ROOT, paths) as snapshot:
        present = [path for path in paths if (snapshot / path).is_file()]
        return secrets(snapshot, present) and check_files(snapshot, present, tools_root=ROOT)


def check_push() -> bool:
    updates = os.environ.get("TRELLAGE_PUSH_REFS")
    if updates is None:
        raise GateError("Missing pre-push ref input; use quality:changed for manual validation.")
    paths, reason, ranges = pushed_files(ROOT, updates, os.environ.get("TRELLAGE_PUSH_REMOTE", ""))
    if not ranges:
        return True
    if (
        git(ROOT, "diff", "--quiet", "HEAD", "--", check=False).returncode
        or git(ROOT, "ls-files", "--others", "--exclude-standard", "-z").stdout
    ):
        raise GateError(
            "Push checks require a clean worktree, including untracked source, so tests match the pushed commit. No files were changed."
        )
    for base, head in ranges:
        if base:
            git(ROOT, "diff", "--check", base, head, "--")
        else:
            git(ROOT, "show", "--format=", "--check", head, "--")
        if not secret_range(ROOT, base, head):
            return False
    if not paths and not reason:
        return True
    return check_plan(plan(paths, reason))


def check_plan(value: dict) -> bool:
    selected_paths = (
        files(ROOT, owned_only=False)
        if value["full"]
        else [path for path in value["files"] if (ROOT / path).is_file() and not (ROOT / path).is_symlink()]
    )
    if not secrets(ROOT, selected_paths) or not check_files(ROOT, selected_paths):
        return False
    if value["analysis"] and not analysis(ROOT):
        return False
    if not run_tests(value):
        return False
    from quality_prototypes import run_local

    return run_local(value["prototypes"])


def dispatch(args: argparse.Namespace) -> bool:
    if args.mode == "staged":
        return check_staged()
    if args.mode == "push":
        return check_push()
    if args.mode == "secrets":
        return check_secrets(args.base, args.head)
    if args.mode == "gate":
        if not args.plan_file:
            raise GateError("--plan-file is required to evaluate CI results")
        value = read_plan(args.plan_file)
        if not gate_results(value, json.loads(args.results or "{}")):
            raise GateError("A required quality job failed, was cancelled, or did not run.")
        return True
    if args.mode == "network":
        kinds = [args.kind] if args.kind else ["dependencies", "links"]
        return all(network(kind) for kind in kinds)
    if args.mode == "coverage":
        from quality_coverage import collect

        return collect()
    return dispatch_plan(args)


def check_secrets(base: str | None, head: str) -> bool:
    if not secrets(ROOT, files(owned_only=False)):
        return False
    if base:
        if git(ROOT, "rev-parse", "--verify", f"{base}^{{commit}}", check=False).returncode == 0:
            return secret_range(ROOT, base, head)
        print("quality: secret-scan base unavailable; scanning all reachable commit history")
        return secret_range(ROOT, None, head)
    return True


def dispatch_plan(args: argparse.Namespace) -> bool:
    if args.plan_file and args.mode == "ci":
        value = read_plan(args.plan_file)
    else:
        paths, reason = changed_files(
            ROOT, args.base or default_base(ROOT), args.head, local=args.mode in {"changed", "plan"}
        )
        value = plan(paths, reason, complete=args.full or args.mode == "all")
    if args.mode == "plan":
        print(json.dumps(value, indent=2))
        return True
    if args.mode == "ci":
        return run_tests(value, lane=args.lane)
    return check_plan(value)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "mode", choices=("plan", "staged", "push", "changed", "all", "ci", "gate", "network", "coverage", "secrets")
    )
    parser.add_argument("--base")
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--lane", choices=("linux", "macos-launcher", "macos-runtime"), default="linux")
    parser.add_argument("--plan-file")
    parser.add_argument("--results")
    parser.add_argument("--kind", choices=("dependencies", "links"))
    args = parser.parse_args(argv)
    try:
        return 0 if dispatch(args) else 1
    except (GateError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"quality: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
