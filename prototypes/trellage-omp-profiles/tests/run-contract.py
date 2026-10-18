#!/usr/bin/env python3
"""Bound the OMP contract and keep child diagnostics off the caller's pipes."""

import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import tempfile
import time


def replay(log, fd, timeout=2):
    deadline = time.monotonic() + timeout
    blocking = os.get_blocking(fd)
    os.set_blocking(fd, False)
    try:
        with open(log, "rb") as source:
            while chunk := source.read(4096):
                while chunk:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not select.select([], [fd], [], remaining)[1]:
                        return False
                    try:
                        chunk = chunk[os.write(fd, chunk):]
                    except BlockingIOError:
                        continue
                    except BrokenPipeError:
                        return False
        return True
    finally:
        os.set_blocking(fd, blocking)


def run(command, log, timeout=600):
    interrupted = None
    child = None

    def interrupt(number, _frame):
        nonlocal interrupted
        interrupted = interrupted or number

    previous = {number: signal.signal(number, interrupt)
                for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    try:
        with open(log, "wb", buffering=0) as output:
            child = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                     stdout=output, stderr=subprocess.STDOUT,
                                     start_new_session=True)
            deadline = time.monotonic() + timeout
            while child.poll() is None and interrupted is None and time.monotonic() < deadline:
                time.sleep(0.02)
            if interrupted is not None or child.poll() is None:
                status = 128 + interrupted if interrupted is not None else 124
                output.write(f"\nOMP contract {'interrupted' if interrupted else 'timed out'}; log: {log}\n".encode())
            else:
                status = child.returncode if child.returncode >= 0 else 128 - child.returncode
            return status
    finally:
        if child is not None:
            rows = [line.split() for line in subprocess.check_output(
                ["ps", "-axo", "pid=,ppid=,pgid="], text=True).splitlines()]
            descendants = {child.pid}
            while True:
                expanded = descendants | {int(pid) for pid, parent, _ in rows if int(parent) in descendants}
                if expanded == descendants:
                    break
                descendants = expanded
            groups = {child.pid} | {int(group) for pid, _, group in rows
                                   if int(pid) in descendants and int(group) in descendants}
            # Also remove descendants left behind by a worker that already exited.
            for number in (signal.SIGTERM, signal.SIGKILL):
                # macOS can report EPERM when the group leader is an unreaped child.
                child.poll()
                for group in groups:
                    try:
                        os.killpg(group, number)
                    except ProcessLookupError:
                        pass
                if number == signal.SIGTERM:
                    time.sleep(0.2)
            child.wait()
        for number, handler in previous.items():
            signal.signal(number, handler)


def main():
    with tempfile.TemporaryDirectory(prefix="trellage-omp-supervisor-") as temporary:
        log_fd, log = tempfile.mkstemp(prefix="trellage-omp-contract-", suffix=".log")
        os.close(log_fd)
        os.environ["TMPDIR"] = temporary
        status = run(["/bin/bash", str(Path(__file__).with_name("contract.sh")), "--fixture-body"], log)
        with open(log, "a") as output:
            output.write(f"\nOMP contract exit {status}" + (f"; log: {log}" if status else "") + "\n")
        delivered = replay(log, sys.stdout.fileno())
        if status == 0 and delivered:
            os.unlink(log)
        # Failed or undelivered logs remain outside the owned fixture directory.
        return status


if __name__ == "__main__":
    raise SystemExit(main())
