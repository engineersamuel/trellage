#!/usr/bin/env python3

import os
import pty
import select
import signal
import sys
import time


def exit_status(status: int) -> int:
    if os.WIFEXITED(status):
        return os.WEXITSTATUS(status)
    if os.WIFSIGNALED(status):
        return 128 + os.WTERMSIG(status)
    return 1


output_path, *command = sys.argv[1:]
pid, terminal = pty.fork()
if pid == 0:
    os.execvpe(command[0], command, os.environ)

output = bytearray()
sent_input = False
status = None
deadline = time.monotonic() + 10

while time.monotonic() < deadline:
    ready, _, _ = select.select([terminal], [], [], 0.05)
    if ready:
        try:
            output.extend(os.read(terminal, 4096))
        except OSError:
            pass
        if not sent_input and b"TTY_READ_READY" in output:
            os.write(terminal, b"continue\n")
            sent_input = True
    waited, wait_status = os.waitpid(pid, os.WNOHANG)
    if waited:
        status = exit_status(wait_status)
        break

if status is None:
    os.kill(pid, signal.SIGKILL)
    _, wait_status = os.waitpid(pid, 0)
    status = exit_status(wait_status)

with open(output_path, "wb") as output_file:
    output_file.write(output)

if status != 0 or not sent_input or b"TTY_READ_DONE" not in output:
    sys.exit(1)
