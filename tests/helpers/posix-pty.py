#!/usr/bin/env python3
from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
import selectors
import signal
import struct
import subprocess
import sys
import termios


def resize(fd: int, columns: int, rows: int) -> None:
    if not (type(columns) is int and type(rows) is int and 0 < columns < 65536 and 0 < rows < 65536):
        raise ValueError("PTY dimensions must be positive 16-bit integers")
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def claim_terminal() -> None:
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)


def signal_child(child: subprocess.Popen[bytes], value: int) -> None:
    if child.poll() is None:
        try:
            os.killpg(child.pid, value)
        except ProcessLookupError:
            # The child can exit between poll and killpg.
            pass


def command(line: bytes, master: int, child: subprocess.Popen[bytes]) -> None:
    message = json.loads(line)
    if not isinstance(message, dict):
        raise ValueError("PTY commands must be objects")
    kind = message.get("kind")
    if kind == "input" and isinstance(message.get("data"), str):
        pending = message["data"].encode("utf-8")
        while pending:
            pending = pending[os.write(master, pending):]
    elif kind == "signal" and isinstance(message.get("signal"), str):
        signal_child(child, signal.Signals[message["signal"]])
    elif kind == "resize":
        resize(master, message.get("columns"), message.get("rows"))
    else:
        raise ValueError(f"Invalid PTY command: {kind!r}")


def read_output(master: int) -> bool:
    try:
        data = os.read(master, 65536)
    except OSError as error:
        if error.errno != errno.EIO:
            raise
        return False
    if not data:
        return False
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    return True


def read_commands(master: int, child: subprocess.Popen[bytes], pending: bytearray) -> bool:
    data = os.read(0, 65536)
    if not data:
        signal_child(child, signal.SIGKILL)
        return False
    pending.extend(data)
    while b"\n" in pending:
        newline = pending.index(b"\n")
        command(bytes(pending[:newline]), master, child)
        del pending[:newline + 1]
    return True


def relay(master: int, child: subprocess.Popen[bytes]) -> None:
    pending = bytearray()
    with selectors.DefaultSelector() as selector:
        selector.register(master, selectors.EVENT_READ)
        selector.register(0, selectors.EVENT_READ)
        while True:
            events = selector.select(timeout=0.05)
            if not events and child.poll() is not None:
                return
            for key, _ in events:
                if key.fd == master:
                    if not read_output(master):
                        return
                elif not read_commands(master, child, pending):
                    selector.unregister(0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--columns", type=int, required=True)
    parser.add_argument("--rows", type=int, required=True)
    parser.add_argument("executable", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    executable = args.executable
    if executable and executable[0] == "--":
        executable = executable[1:]
    if not executable or not os.path.isabs(executable[0]):
        parser.error("an absolute executable path is required")

    master, slave = os.openpty()
    child = None
    try:
        resize(slave, args.columns, args.rows)
        child = subprocess.Popen(
            executable,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            start_new_session=True,
            preexec_fn=claim_terminal,
            close_fds=True,
        )
        os.close(slave)
        slave = -1

        def stop(signum: int, _frame: object) -> None:
            raise SystemExit(128 + signum)

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGHUP, stop)
        print(json.dumps({"pid": child.pid}), file=sys.stderr, flush=True)
        relay(master, child)
        status = child.wait()
        print(
            json.dumps({"exitCode": max(status, 0), "signal": max(-status, 0)}),
            file=sys.stderr,
            flush=True,
        )
    finally:
        if child is not None:
            signal_child(child, signal.SIGKILL)
            child.wait()
        os.close(master)
        if slave != -1:
            os.close(slave)


if __name__ == "__main__":
    main()
