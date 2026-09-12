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
# ASCII record separators divide key stages so Ink can render state changes between writes.
key_stages = keys.encode("utf-8").decode("unicode_escape").encode("latin1").split(b"\x1e")
pid, terminal = pty.fork()
if pid == 0:
    os.execvpe(command[0], command, os.environ)

output = bytearray()
next_key_stage = 0
next_key_stage_at = None
key_stage_frame = 0
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
        # Entering the alternate screen precedes Ink's input subscription.
        screen_ready = (
            b"\x1b[?1049h" not in output
            or b"\x1b[?2026l" in output
            or b"Type yes to update" in output
        )
        if next_key_stage == 0 and output and screen_ready:
            time.sleep(0.1)
            try:
                os.write(terminal, key_stages[next_key_stage])
                next_key_stage += 1
                next_key_stage_at = time.monotonic() + 0.1
                key_stage_frame = output.count(b"\x1b[?2026l")
            except OSError:
                pass
        if signal_marker and not sent_signal and signal_marker.encode() in output:
            os.kill(pid, signal.SIGTERM)
            sent_signal = True

    if (
        next_key_stage_at is not None
        and next_key_stage < len(key_stages)
        and time.monotonic() >= next_key_stage_at
        and (
            key_stage_frame == 0
            or output.count(b"\x1b[?2026l") > key_stage_frame
        )
    ):
        try:
            os.write(terminal, key_stages[next_key_stage])
            next_key_stage += 1
            next_key_stage_at = time.monotonic() + 0.1
            key_stage_frame = output.count(b"\x1b[?2026l")
        except OSError:
            pass

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
