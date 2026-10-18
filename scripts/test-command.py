#!/usr/bin/env python3
"""Run a make recipe through /bin/sh while recording per-target timing."""

from __future__ import annotations

import math
import os
import signal
import subprocess
import sys
import time


def _stamp() -> str:
    return f"{time.time():.3f}"


def _group_has_live_members(pgid: int) -> bool:
    """Fail closed if the host cannot confirm that a retired group is empty."""
    try:
        result = subprocess.run(
            ["ps", "-axo", "pgid=,stat="], capture_output=True, text=True, check=True, timeout=1,
        )
    except (OSError, subprocess.SubprocessError):
        return True
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) == 2 and fields[0] == str(pgid) and not fields[1].startswith("Z"):
            return True
    return False


def main(argv: list[str]) -> int:
    timeout = None
    if len(argv) > 1 and argv[1] == "--timeout":
        try:
            timeout = float(argv[2])
            if not math.isfinite(timeout) or timeout <= 0:
                raise ValueError("invalid timeout")
        except (ValueError, IndexError):
            print("test-command: timeout must be a positive finite number of seconds", file=sys.stderr)
            return 2
        argv = [argv[0], *argv[3:]]
    if len(argv) < 4 or argv[2] != "-c":
        print("usage: test-command.py [--timeout SECONDS] TARGET -c RECIPE [args...]", file=sys.stderr)
        return 2

    target = argv[1]
    command = argv[3]
    started = time.monotonic()
    print(f"[test-timing] target={target} event=start time={_stamp()}", file=sys.stderr, flush=True)
    child = None
    interrupted = None
    timed_out = False

    def signal_group(signum: int) -> None:
        if child is not None:
            try:
                os.killpg(child.pid, signum)
            except ProcessLookupError:
                pass
            except PermissionError:
                # Darwin can return EPERM for a retired, empty process group.
                # Never hide a denied signal while any worker is still running.
                if child.poll() is None or _group_has_live_members(child.pid):
                    raise

    def stop_group() -> None:
        signal_group(signal.SIGTERM)
        try:
            child.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass
        # Kill descendants too, including ones that outlive a cooperative shell.
        signal_group(signal.SIGKILL)
        child.wait(timeout=1)

    def forward(signum: int, _frame: object) -> None:
        nonlocal interrupted
        interrupted = interrupted or signum
        if child is None:
            return
        try:
            os.killpg(child.pid, signum)
        except ProcessLookupError:
            pass

    previous: dict[int, object] = {}
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        previous[signum] = signal.signal(signum, forward)
    try:
        child = subprocess.Popen(
            ["/bin/sh", "-c", command, *argv[4:]],
            start_new_session=True,
            # Recursive make recipes inherit the jobserver descriptors.
            close_fds=False,
        )
        if interrupted is not None:
            forward(interrupted, None)
        while True:
            remaining = None if timeout is None else timeout - (time.monotonic() - started)
            if interrupted is not None or (remaining is not None and remaining <= 0):
                timed_out = interrupted is None
                stop_group()
                status = child.returncode
                break
            try:
                status = child.wait(timeout=min(0.05, remaining) if remaining is not None else 0.05)
                if interrupted is not None:
                    stop_group()
                break
            except subprocess.TimeoutExpired:
                continue
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)

    duration = time.monotonic() - started
    if timed_out:
        detail = f"code=124 status=timeout timeout={timeout:.3f}s"
        exit_status = 124
        print(f"test-command: {target} exceeded {timeout:g}s; stopped its recipe process group", file=sys.stderr)
    elif interrupted is not None or status < 0:
        signum = interrupted or -status
        detail = f"signal={signal.Signals(signum).name} status=signal"
        exit_status = 128 + signum
    else:
        detail = f"code={status} status={'passed' if status == 0 else 'failed'}"
        exit_status = status
    print(
        f"[test-timing] target={target} event=end time={_stamp()} "
        f"duration={duration:.3f}s {detail}",
        file=sys.stderr,
        flush=True,
    )
    return exit_status


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
