#!/usr/bin/env python3
"""Exercise real Guide terminal routing with an inert, offline launcher boundary."""
from __future__ import annotations

import argparse
import errno
import hashlib
import itertools
import json
import math
import os
from pathlib import Path
import pty
import re
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent


def sources() -> dict[str, str]:
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in (
        "scripts/exhaustive-guide-process.py", "prototypes/trellage-router/bin/trx",
        "packages/trellage-launcher/src/fork-preview.tsx",
    )}


def domains() -> dict:
    fork = (ROOT / "packages/trellage-launcher/src/fork-preview.tsx").read_text()
    match = re.search(r'export const forkPreviewVariants = (\[[^\n]+\]) as const', fork)
    if not match:
        raise AssertionError("cannot find production fork variants")
    variants = json.loads(match[1])
    assert variants and all(isinstance(value, str) for value in variants)
    modes = [
        {"id": "basket", "argv": ["--preview"], "route": "guide-preview", "terminal": True},
        {"id": "basket-inline-invalid", "argv": ["--preview=fixture"], "route": "guide-preview", "terminal": True},
        {"id": "basket-help", "argv": ["--preview", "--help"], "route": "guide-preview", "terminal": True},
        {"id": "fork-default", "argv": ["--forks"], "route": "guide-forks", "terminal": True},
        *[{"id": f"fork-{variant}", "argv": ["--forks", variant], "route": "guide-forks", "terminal": True} for variant in variants],
        *[{"id": f"fork-inline-{variant}", "argv": [f"--forks={variant}"], "route": "guide-forks", "terminal": True} for variant in variants],
        {"id": "basket-before-fork", "argv": ["--preview", "--forks"], "route": "guide-preview", "terminal": True},
        {"id": "fork-before-basket", "argv": ["--forks", "--preview"], "route": "guide-forks", "terminal": True},
        {"id": "ritual", "argv": ["--ritual"], "route": "guide", "terminal": True},
        {"id": "ritual-model", "argv": ["--ritual", "--model", "fixture"], "route": "guide", "terminal": True},
        {"id": "ritual-flag-shaped-value", "argv": ["--ritual", "--model", "--print"], "route": "guide", "terminal": True},
        *[{"id": f"ritual-{flag[2:]}", "argv": ["--ritual", flag, "fixture"], "route": "guide", "terminal": False} for flag in ("--print", "--copy")],
        *[{"id": f"ritual-{flag[2:]}", "argv": ["--ritual", flag], "route": "guide", "terminal": False} for flag in ("--help", "--json", "--preview")],
    ]
    return {"modes": modes, "stdinTTY": [False, True], "stderrTTY": [False, True],
            "picker": ["regular", "missing", "symlink"], "stdin": ["", "\n", "two\nlines\n", "模型 😀\n"]}


def read_terminal(master: int) -> bytes:
    output = bytearray()
    os.set_blocking(master, False)
    while True:
        try:
            data = os.read(master, 4096)
        except BlockingIOError:
            return bytes(output)
        except OSError as error:
            if error.errno == errno.EIO:
                return bytes(output)
            raise
        if not data:
            return bytes(output)
        output.extend(data)


def execute(script: Path, argv: list[str], environment: dict[str, str], stdin_tty: bool,
            stderr_tty: bool, text: str) -> tuple[int, str, str]:
    terminals: list[tuple[int, int]] = []
    try:
        if stdin_tty:
            terminals.append(pty.openpty())
            stdin = terminals[-1][1]
        else:
            stdin = subprocess.PIPE
        if stderr_tty:
            terminals.append(pty.openpty())
            stderr = terminals[-1][1]
            error_master = terminals[-1][0]
        else:
            stderr = subprocess.PIPE
        child = subprocess.Popen(["bash", str(script), "guide", *argv], stdin=stdin,
                                 stdout=subprocess.PIPE, stderr=stderr, env=environment)
        try:
            stdout, errors = child.communicate(None if stdin_tty else text.encode(), timeout=10)
        except BaseException:
            child.kill()
            child.wait()
            raise
        if stderr_tty:
            errors = read_terminal(error_master)
        return child.returncode, stdout.decode(), (errors or b"").decode().replace("\r\n", "\n")
    finally:
        for master, slave in terminals:
            os.close(master)
            if slave != -1:
                os.close(slave)


def verify_coverage(report: dict) -> dict:
    matrix = domains()
    total = math.prod(len(values) for values in matrix.values())
    assert report["scope"] == "guide-ritual-preview-terminal-routing-only", "wrong verification scope"
    assert report["domains"] == matrix, "finite domains changed"
    assert report["sourceHashes"] == sources(), "production or verifier sources changed"
    assert report["complete"] is True, "incomplete process coverage"
    for key in ("expectedCases", "executedCases", "distinctTupleIds"):
        assert type(report[key]) is int and report[key] == total, f"incorrect {key}"
    outcomes = report["outcomes"]
    assert set(outcomes) <= {"terminal-rejected", "picker-rejected", "mock-launcher-handoff"}, "unknown outcome"
    assert all(type(value) is int and value >= 0 for value in outcomes.values()), "invalid outcome count"
    assert sum(outcomes.values()) == total, "not every case has an outcome"
    digest = hashlib.sha256()
    for ordinal in range(total):
        digest.update(f"{ordinal}\n".encode())
    assert report["idSequenceSha256"] == digest.hexdigest(), "tuple sequence mismatch"
    return {"scope": report["scope"], "complete": True, "executedCases": total,
            "distinctTupleIds": total, "sourceHashes": sources()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify", type=Path)
    args = parser.parse_args()
    if args.verify:
        if args.output:
            parser.error("--verify and --output cannot be combined")
        print(json.dumps(verify_coverage(json.loads(args.verify.read_text())), indent=2))
        return
    assert os.environ.get("TRELLAGE_TEST_OFFLINE") == "1", "run through scripts/test-offline.sh"
    hashes = sources()
    matrix = domains()
    router = (ROOT / "prototypes/trellage-router/bin/trx").read_text()
    start = router.index("mode=''\n")
    dispatch = router[start:router.index("command -v jq >/dev/null", start)]
    start = router.index('if [[ "$mode" == guide && "$ritual_seen" == true ]]; then')
    routing = router[start:router.index('catalog_tmp="$(mktemp', start)]
    digest = hashlib.sha256()
    outcomes: dict[str, int] = {}
    total = 1
    for values in matrix.values():
        total *= len(values)
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="trellage-guide-process-") as temporary:
        directory = Path(temporary)
        picker = directory / "picker"
        regular = directory / "regular"
        regular.write_text("inert picker marker\n")
        probe = directory / "probe.py"
        probe.write_text('''import json, os, sys
print(json.dumps({"argv": sys.argv[1:], "stdinTTY": sys.stdin.isatty(),
                  "stderrTTY": sys.stderr.isatty(), "runtimeChecked": os.environ.get("RUNTIME_CHECKED"),
                  "stdin": None if sys.stdin.isatty() else sys.stdin.read()}))
''')
        script = directory / "routing.sh"
        script.write_text("\n".join([
            "set -euo pipefail", 'die() { printf "%s\\n" "$1" >&2; exit 1; }',
            'usage() { printf "root-help\\n"; }', 'guide_usage() { printf "guide-help\\n"; }', dispatch,
            'require_source_runtime() { export RUNTIME_CHECKED=1; }',
            'picker_path="$FIXTURE_PICKER"', 'guide_root="$FIXTURE_GUIDE_ROOT"',
            'trellage_launcher=("$FIXTURE_PYTHON" "$FIXTURE_PROBE")', routing,
            "die 'fixture unexpectedly reached catalog discovery'",
        ]))
        environment = {**os.environ, "FIXTURE_PICKER": str(picker), "FIXTURE_GUIDE_ROOT": str(directory / "guides"),
                       "FIXTURE_PYTHON": sys.executable, "FIXTURE_PROBE": str(probe)}
        executed = 0
        for ordinal, (mode, stdin_tty, stderr_tty, kind, text) in enumerate(itertools.product(*matrix.values())):
            if picker.exists() or picker.is_symlink():
                picker.unlink()
            if kind == "regular":
                picker.write_text("fixture marker\n")
            elif kind == "symlink":
                picker.symlink_to(regular)
            status, output, errors = execute(script, mode["argv"], environment, stdin_tty, stderr_tty, text)
            context = f"case {ordinal}: {mode['id']}, stdinTTY={stdin_tty}, stderrTTY={stderr_tty}, picker={kind}"
            if mode["terminal"] and not (stdin_tty and stderr_tty):
                assert (status, output, errors) == (1, "", "an interactive terminal is required\n"), (context, status, output, errors)
                outcome = "terminal-rejected"
            elif kind != "regular":
                assert (status, output, errors) == (1, "", "Ink launcher is missing or unsafe\n"), (context, status, output, errors)
                outcome = "picker-rejected"
            else:
                assert status == 0 and errors == "", (context, status, output, errors)
                prefix = [str(picker), mode["route"]]
                if mode["route"] == "guide":
                    prefix.extend([environment["FIXTURE_GUIDE_ROOT"], ""])
                assert json.loads(output) == {"argv": [*prefix, *mode["argv"]], "stdinTTY": stdin_tty,
                    "stderrTTY": stderr_tty, "runtimeChecked": "1", "stdin": None if stdin_tty else text}, context
                outcome = "mock-launcher-handoff"
            outcomes[outcome] = outcomes.get(outcome, 0) + 1
            digest.update(f"{ordinal}\n".encode())
            executed += 1
        assert executed == total
    assert sources() == hashes, "production or verification sources changed during execution"
    report = {"scope": "guide-ritual-preview-terminal-routing-only", "complete": True,
              "domains": matrix, "sourceHashes": hashes, "expectedCases": total, "executedCases": executed,
              "distinctTupleIds": executed, "idSequenceSha256": digest.hexdigest(), "outcomes": outcomes,
              "elapsedSeconds": time.monotonic() - started,
              "stdinRationale": "Text inputs are supplied verbatim to pipes. TTY cases retain every tuple but do not type terminal input; the probe reports null for terminal contents.",
              "extraction": "Exact root dispatch and ritual/preview routing. Source-runtime validation and final launcher are inert mocks. Each case runs in a fresh Bash process with independently controlled real stdin/stderr PTYs.",
              "remainingVerification": ["ordinary Guide catalog/service routing", "interactive UI", "terminal input contents and terminal signals", "full option product"]}
    if args.output:
        with args.output.open("x") as output:
            json.dump(report, output, indent=2)
            output.write("\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
