#!/usr/bin/env python3
"""Run a make recipe through /bin/sh while recording per-target timing."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time


def _stamp() -> str:
    return f"{time.time():.3f}"


def main(argv: list[str]) -> int:
    if len(argv) < 4 or argv[2] != "-c":
        print("usage: test-command.py TARGET -c RECIPE [args...]", file=sys.stderr)
        return 2

    target = argv[1]
    command = argv[3]
    started = time.monotonic()
    print(f"[test-timing] target={target} event=start time={_stamp()}", file=sys.stderr, flush=True)
    child = None
    interrupted = None

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
        status = child.wait()
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)

    duration = time.monotonic() - started
    if interrupted is not None or status < 0:
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
