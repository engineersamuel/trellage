#!/usr/bin/env python3

import os
import pty
import select
import signal
import sys
import time


def normalized_status(status: int) -> int:
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


output_path, keys, signal_marker, *command = sys.argv[1:]
pid, terminal = pty.fork()
if pid == 0:
    os.execvpe(command[0], command, os.environ)

output = bytearray()
sent_keys = False
sent_signal = False
deadline = time.monotonic() + 10
status = None

while time.monotonic() < deadline:
    ready, _, _ = select.select([terminal], [], [], 0.05)
    if ready:
        try:
            chunk = os.read(terminal, 4096)
        except OSError:
            chunk = b""
        output.extend(chunk)
        if not sent_keys and b"Enter select" in output:
            os.write(terminal, keys.encode("utf-8").decode("unicode_escape").encode("latin1"))
            sent_keys = True
        if signal_marker and not sent_signal and signal_marker.encode() in output:
            os.kill(pid, signal.SIGTERM)
            sent_signal = True

    waited, wait_status = os.waitpid(pid, os.WNOHANG)
    if waited:
        status = normalized_status(wait_status)
        break

if status is None:
    os.kill(pid, signal.SIGKILL)
    _, wait_status = os.waitpid(pid, 0)
    status = normalized_status(wait_status)

with open(output_path, "wb") as output_file:
    output_file.write(output)

sys.exit(status)
