#!/usr/bin/env python3
"""Measure alternating complete test runs; keep failures out of speedup claims."""

from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import shlex
import statistics
import subprocess
import sys
import tempfile
import threading
import time



def competing_test_workloads(processes: list[tuple[int, int, str]], controller: int) -> list[dict]:
    owned = {controller}
    while True:
        children = owned | {pid for pid, parent, _ in processes if parent in owned}
        if children == owned:
            break
        owned = children
    found = []
    for pid, parent, command in processes:
        if pid in owned:
            continue
        try:
            words = shlex.split(command)
        except ValueError:
            continue
        if not words:
            continue
        executable = Path(words[0]).name
        arguments = words[1:]
        action = list(arguments)
        while action and action[0].startswith("-"):
            option = action.pop(0)
            if option in ("--cwd", "--config", "--prefix", "--manifest-path", "-C") and action:
                action.pop(0)
        test_action = action[:1] == ["test"] or action[:2] == ["run", "test"]
        script = Path(action[0]) if action else None
        script_test = (
            executable in ("bun", "node", "python", "python3", "bash", "sh", "zsh")
            and script is not None
            and ("tests" in script.parts or script.name.startswith("exhaustive-")
                 or script.name in ("test-exhaustive.py", "benchmark-tests.py", "test-offline.sh"))
        )
        test = (
            executable in ("make", "gmake") and any(
                value == "test" or value.startswith("test-") or value.endswith("-test") for value in arguments
            )
            or executable in ("bun", "npm", "pnpm", "yarn", "cargo") and test_action
            or executable in ("pytest", "py.test")
            or script_test
        )
        if test:
            found.append({"pid": pid, "parentPid": parent, "executable": executable})
    return sorted(found, key=lambda item: item["pid"])


def process_snapshot() -> list[tuple[int, int, str]]:
    rows = subprocess.check_output(["ps", "-axo", "pid=,ppid=,args="], text=True, timeout=5)
    result = []
    for line in rows.splitlines():
        values = line.strip().split(None, 2)
        if len(values) == 3 and values[0].isdigit() and values[1].isdigit():
            result.append((int(values[0]), int(values[1]), values[2]))
    return result


def process_context(processes: list[tuple[int, int, str]], pid: int) -> dict:
    by_pid = {process: (parent, command) for process, parent, command in processes}
    ancestry = []
    visited = set()
    current = pid
    while current in by_pid and current not in visited:
        visited.add(current)
        parent, command = by_pid[current]
        try:
            executable = Path(shlex.split(command)[0]).name
        except (ValueError, IndexError):
            executable = "unparsed"
        ancestry.append({"pid": current, "parentPid": parent, "executable": executable})
        current = parent
    context = {"ancestry": ancestry, "ancestryEndsAtPid": current}
    try:
        if sys.platform == "linux":
            directory = os.readlink(f"/proc/{pid}/cwd")
        elif sys.platform == "darwin":
            output = subprocess.check_output(
                ["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                text=True, timeout=2, stderr=subprocess.DEVNULL,
            )
            paths = [line[1:] for line in output.splitlines() if line.startswith("n")]
            if len(paths) != 1:
                raise ValueError("no unique working directory")
            directory = paths[0]
        else:
            raise NotImplementedError("working-directory lookup unsupported")
        context["workingDirectory"] = directory
    except Exception as error:
        context["workingDirectoryUnavailable"] = type(error).__name__
    return context


class WorkloadMonitor:
    def __init__(self, interval: float = 2.0):
        self.interval = interval
        self.events: list[dict] = []
        self.errors: list[str] = []
        self.stopped = threading.Event()
        self.thread = threading.Thread(target=self.watch, daemon=True)

    def sample(self) -> None:
        try:
            snapshot = process_snapshot()
            workloads = competing_test_workloads(snapshot, os.getpid())
            if workloads and (not self.events or self.events[-1]["workloads"] != workloads):
                event = {"observedAt": datetime.now(timezone.utc).isoformat(), "workloads": workloads,
                         "processContexts": {str(item["pid"]): process_context(snapshot, item["pid"]) for item in workloads}}
                self.events.append(event)
                print(json.dumps({"benchmarkEvent": "competing-test-workload", **event}), file=sys.stderr, flush=True)
        except Exception as error:
            self.errors.append(f"process monitoring failed: {type(error).__name__}")

    def watch(self) -> None:
        while not self.stopped.wait(self.interval):
            self.sample()

    def start(self) -> None:
        self.sample()
        self.thread.start()

    def stop(self) -> None:
        self.stopped.set()
        self.thread.join()
        self.sample()


def source_names(root: Path) -> list[str]:
    names = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root
    ).decode().split("\0")
    return sorted({name for name in names if name and name != "test-performance.json"
                   and not name.startswith("results/")})


def identity(root: Path) -> str:
    digest = hashlib.sha256()
    for name in source_names(root):
        file = root / name
        digest.update(name.encode() + b"\0")
        if not file.exists() and not file.is_symlink():
            digest.update(b"deleted\0")
            continue
        digest.update(str(file.lstat().st_mode).encode() + b"\0")
        digest.update(os.readlink(file).encode() if file.is_symlink() else file.read_bytes())
    return digest.hexdigest()


@contextmanager
def clean_checkout(root: Path):
    with tempfile.TemporaryDirectory(prefix="trellage-clean-benchmark-") as temporary:
        checkout = Path(temporary).resolve() / "source"
        subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "worktree", "add",
                        "--quiet", "--detach", str(checkout), "HEAD"], cwd=root, check=True)
        trusted = False
        try:
            for name in source_names(root):
                source, destination = root / name, checkout / name
                if destination.is_symlink() or destination.is_file():
                    destination.unlink()
                if source.exists() or source.is_symlink():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, destination, follow_symlinks=False)
            if (checkout / "mise.toml").exists():
                subprocess.run(["mise", "trust"], cwd=checkout, check=True, capture_output=True)
                trusted = True
            yield checkout
        finally:
            if trusted:
                subprocess.run(["mise", "trust", "--untrust"], cwd=checkout, check=True, capture_output=True)
            subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "worktree", "remove",
                            "--force", str(checkout)], cwd=root, check=True, capture_output=True)


def summarize(values: list[float]) -> dict:
    median = statistics.median(values)
    return {
        "samples": len(values), "medianSeconds": median,
        "madSeconds": statistics.median(abs(value - median) for value in values),
        "minSeconds": min(values), "maxSeconds": max(values),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=5)
    parser.add_argument("--label", required=True)
    parser.add_argument("--phase", choices=("warm", "clean"), default="warm")
    parser.add_argument("--first", choices=("reference", "candidate"), default="reference")
    args = parser.parse_args()
    if args.samples < 5:
        parser.error("at least five samples per side are required")
    if args.output.exists():
        parser.error("output already exists; use a new batch path")
    foreign = competing_test_workloads(process_snapshot(), os.getpid())
    if foreign:
        parser.error(f"competing test workloads are active: {foreign}")
    order = ("reference", "candidate") if args.first == "reference" else ("candidate", "reference")
    roots = {name: getattr(args, name).resolve() for name in order}
    contents = {name: identity(root) for name, root in roots.items()}
    command = ["make", "test"]
    versions = {}
    for tool in ("python3", "bun", "node", "npm", "make", "git"):
        executable = shutil.which(tool)
        if executable is None:
            raise RuntimeError(f"required tool is missing: {tool}")
        version = subprocess.check_output([executable, "--version"], cwd=roots["candidate"], text=True).splitlines()[0]
        versions[tool] = {"executable": executable, "version": version}
    report = {
        "schemaVersion": 1, "label": args.label, "phase": args.phase,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "command": command, "roots": {name: str(root) for name, root in roots.items()},
        "contentIds": contents, "logicalCpus": os.cpu_count(),
        "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "controllerPython": sys.version, "tools": versions,
        "environment": {name: os.environ.get(name) for name in
                        ("PATH", "TEST_JOBS", "TRELLAGE_TEST_PACKAGE_CACHE", "BUN_INSTALL_CACHE_DIR",
                         "BUN_RUNTIME_TRANSPILER_CACHE_PATH")},
        "threshold": {"fraction": 0.05, "madMultiplier": 3},
        "samples": [], "verdict": "incomplete",
        "cleanStartDefinition": "Fresh source worktree, dependencies absent; timed offline preparation plus make test. Source copying and mise trust excluded. Host package cache and OS caches retained.",
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def save() -> None:
        args.output.write_text(json.dumps(report, indent=2) + "\n")

    def run(side: str, warmup: bool) -> dict:
        root = roots[side]
        if identity(root) != contents[side]:
            raise RuntimeError(f"{side} changed during the batch")
        log_path = args.output.with_suffix(f".{len(report['samples']):02d}-{side}.log")
        load_before = os.getloadavg()
        started_at = datetime.now(timezone.utc).isoformat()
        def execute(directory: Path) -> tuple[int, float]:
            started = time.monotonic()
            with log_path.open("w") as log:
                status = 0
                if args.phase == "clean":
                    status = subprocess.run(
                        ["bash", "scripts/test-offline.sh", "bash", "scripts/install-source-runtime.sh", "--prepare"],
                        cwd=directory, stdout=log, stderr=subprocess.STDOUT,
                    ).returncode
                    if status == 0 and (directory / "tests/playwright/package-lock.json").is_file():
                        status = subprocess.run(
                            ["bash", str(directory / "scripts/test-offline.sh"), "npm", "ci", "--offline",
                             "--no-audit", "--no-fund"],
                            cwd=directory / "tests/playwright", stdout=log, stderr=subprocess.STDOUT,
                        ).returncode
                if status == 0:
                    status = subprocess.run(command, cwd=directory, stdout=log, stderr=subprocess.STDOUT).returncode
            return status, time.monotonic() - started

        monitor = WorkloadMonitor()
        monitor.start()
        if monitor.events or monitor.errors:
            monitor.stop()
            report["verdict"] = "workload isolation failed before run"
            report["admissionFailure"] = {"side": side, "events": monitor.events, "errors": monitor.errors}
            save()
            raise RuntimeError("workload isolation failed before run; no timed sample started")
        try:
            if args.phase == "clean":
                with clean_checkout(root) as checkout:
                    status, duration = execute(checkout)
            else:
                status, duration = execute(root)
        finally:
            monitor.stop()
        output = log_path.read_text()
        starts = Counter(re.findall(r"\[test-timing\] target=(\S+) event=start", output))
        ends = Counter(re.findall(r"\[test-timing\] target=(\S+) event=end.*status=passed", output))
        reasons = list(monitor.errors)
        if monitor.events:
            reasons.append("competing test workloads observed during run")
        if status != 0:
            reasons.append(f"command exited {status}")
        if not starts or starts != ends:
            reasons.append("recipe inventory missing, incomplete, or failed")
        if identity(root) != contents[side]:
            reasons.append("source changed during run")
        sample = {
            "side": side, "warmup": warmup, "startedAt": started_at,
            "durationSeconds": duration, "exitCode": status,
            "loadBefore": load_before, "loadAfter": os.getloadavg(),
            "recipeCounts": dict(sorted(ends.items())), "log": str(log_path),
            "logSha256": hashlib.sha256(output.encode()).hexdigest(),
            "invalidReasons": reasons,
            "competingTestWorkloads": monitor.events,
            "processMonitorIntervalSeconds": monitor.interval,
        }
        report["samples"].append(sample)
        save()
        print(json.dumps(sample), flush=True)
        return sample

    save()
    for side in roots:
        if run(side, True)["invalidReasons"]:
            report["verdict"] = "invalid warmup"
            save()
            return 1
    for _ in range(args.samples):
        for side in roots:
            if run(side, False)["invalidReasons"]:
                report["verdict"] = "invalid sample"
                save()
                return 1
    samples = [sample for sample in report["samples"] if not sample["warmup"]]
    inventories = [sample["recipeCounts"] for sample in samples]
    if any(inventory != inventories[0] for inventory in inventories):
        report["verdict"] = "incomparable recipe inventories"
        save()
        return 1
    summary = {
        side: summarize([sample["durationSeconds"] for sample in samples if sample["side"] == side])
        for side in roots
    }
    before, after = summary["reference"], summary["candidate"]
    gain = before["medianSeconds"] - after["medianSeconds"]
    threshold = max(before["medianSeconds"] * 0.05, 3 * max(before["madSeconds"], after["madSeconds"]))
    report.update({
        "summary": summary, "gainSeconds": gain, "requiredGainSeconds": threshold,
        "verdict": "faster" if gain > threshold else "no demonstrated gain",
    })
    save()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
