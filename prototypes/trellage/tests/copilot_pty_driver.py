#!/usr/bin/env python3
"""Drive Copilot in a container-local PTY and verify native session events."""

from __future__ import annotations

import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time
from pathlib import Path


CSI_SEQUENCE = re.compile(rb"\x1b\[([0-?]*)([ -/]*)([@-~])")
VISIBLE_LINE_BOUNDARY = re.compile(rb"[\r\n]")
MAX_TRANSCRIPT_BYTES = 1024 * 1024
MAX_VISIBLE_BYTES = 64 * 1024
MAX_CONTROL_SEQUENCE_BYTES = 256
RESUME_PROMPT_READY = "MCP Servers reloaded: 1 server connected"
ALTERNATE_SCREEN_MODES = frozenset({47, 1047, 1049})

def numeric_csi_parameters(parameters: bytes) -> tuple[int | None, ...] | None:
    if not parameters:
        return ()
    parts = parameters.split(b";")
    if any(part and not part.isdigit() for part in parts):
        return None
    return tuple(int(part) if part else None for part in parts)


def is_screen_boundary_csi(
    parameters: bytes, intermediates: bytes, final: bytes
) -> bool:
    if not intermediates and final in {b"H", b"f"}:
        parsed = numeric_csi_parameters(parameters)
        if parsed is None or len(parsed) > 2:
            return False
        row = parsed[0] if parsed else None
        column = parsed[1] if len(parsed) == 2 else None
        effective_row = 1 if row in {None, 0} else row
        effective_column = 1 if column in {None, 0} else column
        return effective_row == 1 and effective_column == 1

    if not intermediates and final == b"J":
        parsed = numeric_csi_parameters(parameters)
        if parsed is None or len(parsed) > 1:
            return False
        mode = parsed[0] if parsed else 0
        effective_mode = 0 if mode is None else mode
        return effective_mode in {0, 1, 2, 3}

    if not intermediates and final in {b"h", b"l"} and parameters.startswith(b"?"):
        modes = numeric_csi_parameters(parameters[1:])
        return (
            modes is not None
            and all(mode is not None for mode in modes)
            and any(mode in ALTERNATE_SCREEN_MODES for mode in modes)
        )

    return parameters == b"" and intermediates == b"!" and final == b"p"


def is_screen_boundary_sequence(sequence: bytes) -> bool:
    if sequence == b"\x1bc":
        return True
    match = CSI_SEQUENCE.fullmatch(sequence)
    return match is not None and is_screen_boundary_csi(*match.groups())


class TerminalView:
    def __init__(self) -> None:
        self._visible = bytearray()
        self._visible_head = 0
        self._visible_compactions = 0
        self._state = "normal"
        self._csi = bytearray()
        self._csi_overflow = False
        self._string_esc = False
        self._utf8_remaining = 0
        self._discarding_visible_line = False
        self._drop_lf_after_cr = False

    @property
    def buffered_control_bytes(self) -> int:
        return len(self._csi)

    @property
    def buffered_visible_storage_bytes(self) -> int:
        return self._visible.__alloc__()

    @property
    def visible_compactions(self) -> int:
        return self._visible_compactions

    def visible_bytes(self) -> bytes:
        return bytes(self._visible[self._visible_head:])

    def visible_text(self) -> str:
        return self._visible[self._visible_head:].decode("utf-8", "replace")

    def visible_lines(self) -> tuple[str, ...]:
        text = self.visible_text()
        lines: list[str] = []
        line_start = 0
        index = 0
        while index < len(text):
            if text[index] not in {"\r", "\n"}:
                index += 1
                continue

            line = text[line_start:index].strip(" \t")
            if line:
                lines.append(line)
            if (
                text[index] == "\r"
                and index + 1 < len(text)
                and text[index + 1] == "\n"
            ):
                index += 1
            index += 1
            line_start = index

        line = text[line_start:].strip(" \t")
        if line:
            lines.append(line)
        return tuple(lines)

    def _append_visible(self, byte: int, *, raw: bool = True) -> None:
        if raw and self._drop_lf_after_cr:
            self._drop_lf_after_cr = False
            if byte == ord("\n"):
                return

        if self._discarding_visible_line:
            if raw and byte == ord("\r"):
                self._discarding_visible_line = False
                self._drop_lf_after_cr = True
            elif raw and byte == ord("\n"):
                self._discarding_visible_line = False
            return

        self._visible.append(byte)
        self._enforce_visible_cap()

    def _enforce_visible_cap(self) -> None:
        while len(self._visible) - self._visible_head > MAX_VISIBLE_BYTES:
            match = VISIBLE_LINE_BOUNDARY.search(self._visible, self._visible_head)
            if match is None:
                self._visible.clear()
                self._visible_head = 0
                self._discarding_visible_line = True
                return

            boundary = match.start()
            line_end = boundary + 1
            if (
                self._visible[boundary] == ord("\r")
                and line_end < len(self._visible)
                and self._visible[line_end] == ord("\n")
            ):
                line_end += 1
            elif self._visible[boundary] == ord("\r") and line_end == len(
                self._visible
            ):
                self._drop_lf_after_cr = True
            self._visible_head = line_end
            self._compact_visible_if_needed()

    def _compact_visible_if_needed(self) -> None:
        if self._visible_head < MAX_VISIBLE_BYTES:
            return
        del self._visible[:self._visible_head]
        self._visible_head = 0
        self._visible_compactions += 1

    def _reset_visible_segment(self) -> None:
        self._visible.clear()
        self._visible_head = 0
        self._utf8_remaining = 0
        self._discarding_visible_line = False
        self._drop_lf_after_cr = False

    def _enter_csi(self) -> None:
        self._state = "csi"
        self._csi.clear()
        self._csi_overflow = False

    def _enter_string(self, osc: bool) -> None:
        self._state = "osc" if osc else "string"
        self._string_esc = False

    def _finish_control(self) -> None:
        self._state = "normal"
        self._csi.clear()
        self._csi_overflow = False
        self._string_esc = False

    def _feed_normal(self, byte: int) -> None:
        if self._utf8_remaining:
            if 0x80 <= byte <= 0xBF:
                self._append_visible(byte)
                self._utf8_remaining -= 1
                return
            self._utf8_remaining = 0

        if byte == 0x1B:
            self._state = "esc"
        elif byte == 0x9B:
            self._enter_csi()
        elif byte == 0x9D:
            self._enter_string(osc=True)
        elif byte in {0x90, 0x98, 0x9E, 0x9F}:
            self._enter_string(osc=False)
        elif 0x80 <= byte <= 0x9F:
            return
        else:
            self._append_visible(byte)
            if 0xC2 <= byte <= 0xDF:
                self._utf8_remaining = 1
            elif 0xE0 <= byte <= 0xEF:
                self._utf8_remaining = 2
            elif 0xF0 <= byte <= 0xF4:
                self._utf8_remaining = 3

    def _feed_esc(self, byte: int) -> None:
        if byte == ord("["):
            self._enter_csi()
        elif byte == ord("]"):
            self._enter_string(osc=True)
        elif byte in {ord("P"), ord("X"), ord("^"), ord("_")}:
            self._enter_string(osc=False)
        elif byte == ord("c"):
            self._reset_visible_segment()
            self._finish_control()
        elif byte == 0x1B:
            self._state = "esc"
        else:
            self._finish_control()

    def _feed_csi(self, byte: int) -> None:
        if byte in {0x18, 0x1A}:
            self._finish_control()
            return
        if byte == 0x1B:
            self._state = "esc"
            self._csi.clear()
            self._csi_overflow = False
            return
        if 0x40 <= byte <= 0x7E:
            if not self._csi_overflow:
                self._csi.append(byte)
                sequence = b"\x1b[" + bytes(self._csi)
                match = CSI_SEQUENCE.fullmatch(sequence)
                if match is not None and is_screen_boundary_csi(*match.groups()):
                    self._reset_visible_segment()
                elif match is not None:
                    parameters, intermediates, final = match.groups()
                    if (
                        not intermediates
                        and final in {b"H", b"f"}
                        and numeric_csi_parameters(parameters) is not None
                    ):
                        self._append_visible(ord("\n"), raw=False)
            self._finish_control()
            return
        if 0x20 <= byte <= 0x3F:
            if len(self._csi) < MAX_CONTROL_SEQUENCE_BYTES:
                self._csi.append(byte)
            else:
                self._csi_overflow = True

    def _feed_string(self, byte: int) -> None:
        if byte in {0x18, 0x1A, 0x9C}:
            self._finish_control()
            return
        if self._state == "osc" and byte == 0x07:
            self._finish_control()
            return
        if self._string_esc:
            if byte == ord("\\"):
                self._finish_control()
            else:
                self._string_esc = byte == 0x1B
            return
        if byte == 0x1B:
            self._string_esc = True

    def feed(self, data: bytes) -> None:
        for byte in data:
            if self._state == "normal":
                self._feed_normal(byte)
            elif self._state == "esc":
                self._feed_esc(byte)
            elif self._state == "csi":
                self._feed_csi(byte)
            else:
                self._feed_string(byte)


def contains_exact_trust_modal_lines(
    lines: tuple[str, ...], trust_path: str
) -> bool:
    legacy_expected = (
        "Confirm folder trust",
        trust_path,
        "Do you trust the files in this folder?",
        "1. Yes",
    )
    if any(
        lines[offset:offset + len(legacy_expected)] == legacy_expected
        for offset in range(len(lines) - len(legacy_expected) + 1)
    ):
        return True

    horizontal = "─" * 118
    live_expected = (
        "Confirm folder trust",
        f"╭{horizontal}╮",
        f"│ {trust_path}│",
        f"╰{horizontal}╯",
        "Copilot can read files in this folder and, with your permission, "
        "edit them or run code and shell commands. It will",
        "remember your permissions for the rest of this session.",
        "Do you trust the files in this folder?",
        "Current selection: 1. Yes",
        "2. Yes, and remember this folder for future sessions",
    )
    return any(
        lines[offset:offset + len(live_expected)] == live_expected
        for offset in range(len(lines) - len(live_expected) + 1)
    )


def contains_exact_trust_modal(data: bytes, trust_path: str) -> bool:
    view = TerminalView()
    view.feed(data)
    return contains_exact_trust_modal_lines(view.visible_lines(), trust_path)


def scan_raw_secret(secret: bytes, carry: bytes, chunk: bytes) -> tuple[bool, bytes]:
    candidate = carry + chunk
    keep = max(0, len(secret) - 1)
    return secret in candidate, candidate[-keep:] if keep else b""


def append_capped(buffer: bytearray, chunk: bytes, limit: int) -> None:
    buffer.extend(chunk)
    if len(buffer) > limit:
        del buffer[:len(buffer) - limit]


def drain_raw_pty(
    master: int,
    secret: bytes,
    carry: bytes,
    timeout: float = 2.0,
    read_size: int = 65536,
) -> tuple[bool, bytes, bool]:
    deadline = time.monotonic() + timeout
    found = False
    while time.monotonic() < deadline:
        remaining = max(0.0, deadline - time.monotonic())
        ready, _, _ = select.select([master], [], [], min(0.2, remaining))
        if not ready:
            continue
        try:
            chunk = os.read(master, read_size)
        except OSError as error:
            if error.errno == errno.EIO:
                return found, carry, True
            raise
        if not chunk:
            return found, carry, True
        chunk_found, carry = scan_raw_secret(secret, carry, chunk)
        found = found or chunk_found
    return found, carry, False


def event_evidence(expected: str) -> tuple[int, int, tuple[str, ...]]:
    root = Path(os.environ["COPILOT_HOME"]) / "session-state"
    files = list(root.glob("*/events.jsonl"))
    assistant_canaries = 0
    completed_sessions: list[str] = []
    for path in files:
        canary_pending = False
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                event_type = event.get("type")
                if event_type == "assistant.message" and expected in line:
                    assistant_canaries += 1
                    canary_pending = True
                elif event_type == "assistant.turn_end" and canary_pending:
                    completed_sessions.append(path.parent.name)
                    canary_pending = False
    return len(files), assistant_canaries, tuple(completed_sessions)


def process_group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def wait_for_process_group_exit(
    process_group: int, process: subprocess.Popen[bytes], timeout: float
) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        process.poll()
        if not process_group_exists(process_group):
            return True
        time.sleep(0.05)
    process.poll()
    return not process_group_exists(process_group)


def terminate(process: subprocess.Popen[bytes]) -> None:
    process_group = process.pid
    process.poll()
    if process_group_exists(process_group):
        try:
            os.killpg(process_group, signal.SIGTERM)
        except ProcessLookupError:
            pass
        if not wait_for_process_group_exit(process_group, process, 5):
            try:
                os.killpg(process_group, signal.SIGKILL)
            except ProcessLookupError:
                pass
            wait_for_process_group_exit(process_group, process, 5)
    if process.poll() is None:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main() -> int:
    if len(sys.argv) != 5 or sys.argv[1] not in {"new", "resume"}:
        print("copilot PTY driver: invalid arguments", file=sys.stderr)
        return 64

    mode, expected, prompt, trust_path = sys.argv[1:]
    timeout = int(os.environ.get("COPILOT_SMOKE_TIMEOUT", "120"))
    secret = os.environ.get("COPILOT_GITHUB_TOKEN", "").encode()
    if not secret:
        print("copilot PTY driver: missing inherited credential", file=sys.stderr)
        return 64
    command = ["trellage-copilot-entry", mode, "--allow-all", "--screen-reader"]
    if mode == "new":
        command.extend(["--", prompt])

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    environment = os.environ.copy()
    environment["TERM"] = "xterm-256color"
    environment["COLORTERM"] = "truecolor"
    process = subprocess.Popen(
        command,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=environment,
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave)
    os.set_blocking(master, False)

    transcript = bytearray()
    terminal_view = TerminalView()
    post_selection_view = TerminalView()
    raw_secret_carry = b""
    deadline = time.monotonic() + timeout
    resume_submit_at: float | None = None
    resume_typed = mode == "new"
    resume_sent = mode == "new"
    resume_readiness_seen = False
    trust_selected = False
    result_seen = False
    exit_sent = False
    exit_deadline: float | None = None

    try:
        while time.monotonic() < deadline:
            now = time.monotonic()
            if resume_submit_at is not None and not resume_sent and now >= resume_submit_at:
                os.write(master, b"\r")
                resume_sent = True

            event_files, assistant_canaries, completed_sessions = event_evidence(expected)
            if completed_sessions and not result_seen:
                if not trust_selected:
                    print("copilot PTY driver: result appeared without exact trust selection", file=sys.stderr)
                    return 128
                result_seen = True
                if len(set(completed_sessions)) != 1:
                    print("copilot PTY driver: canary completed in multiple sessions", file=sys.stderr)
                    return 128
                if process.poll() is None:
                    os.write(master, b"/exit\r")
                    exit_sent = True
                    exit_deadline = time.monotonic() + 15

            if process.poll() is not None:
                secret_found, raw_secret_carry, drain_complete = drain_raw_pty(
                    master, secret, raw_secret_carry
                )
                if secret_found:
                    print(
                        "copilot PTY driver: raw PTY stream contained credential material",
                        file=sys.stderr,
                    )
                    return 125
                if not drain_complete:
                    print("copilot PTY driver: post-exit PTY drain timed out", file=sys.stderr)
                    return 124
                if result_seen and exit_sent and process.returncode == 0:
                    print(expected)
                    print(f"session={completed_sessions[0]}")
                    return 0
                print(
                    f"copilot PTY driver: exited before verified /exit "
                    f"(code={process.returncode}, event_files={event_files}, "
                    f"assistant_canaries={assistant_canaries}, "
                    f"completed_sessions={len(completed_sessions)}, bytes={len(transcript)})",
                    file=sys.stderr,
                )
                return 127

            ready, _, _ = select.select([master], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if chunk:
                    secret_found, raw_secret_carry = scan_raw_secret(
                        secret, raw_secret_carry, chunk
                    )
                    if secret_found:
                        print(
                            "copilot PTY driver: raw PTY stream contained credential material",
                            file=sys.stderr,
                        )
                        return 125
                    append_capped(transcript, chunk, MAX_TRANSCRIPT_BYTES)
                    terminal_view.feed(chunk)
                    if trust_selected:
                        post_selection_view.feed(chunk)
                    rendered = terminal_view.visible_text()
                    trust_header = "Confirm folder trust" in rendered
                    if trust_selected \
                        and "Confirm folder trust" in post_selection_view.visible_text():
                        print("copilot PTY driver: duplicate folder trust modal", file=sys.stderr)
                        return 126
                    if trust_header and not trust_selected:
                        if contains_exact_trust_modal_lines(
                            terminal_view.visible_lines(), trust_path
                        ):
                            os.write(master, b"1\r")
                            trust_selected = True
                            post_selection_view = TerminalView()
                    if mode == "resume" and trust_selected \
                        and RESUME_PROMPT_READY in post_selection_view.visible_lines():
                        resume_readiness_seen = True
                    if mode == "resume" and resume_readiness_seen and not resume_typed:
                        os.write(master, prompt.encode() + b"\r")
                        resume_typed = True
                        resume_submit_at = time.monotonic() + 0.5

            if exit_deadline is not None and time.monotonic() >= exit_deadline:
                print("copilot PTY driver: event verified but /exit did not terminate", file=sys.stderr)
                return 124

        event_files, assistant_canaries, completed_sessions = event_evidence(expected)
        rendered = terminal_view.visible_text()
        print(
            "copilot PTY driver: timed out "
            f"(bytes={len(transcript)}, event_files={event_files}, "
            f"assistant_canaries={assistant_canaries}, "
            f"completed_sessions={len(completed_sessions)}, "
            f"trust_header={'Confirm folder trust' in rendered}, "
            f"trust_path={trust_path in rendered}, "
            f"trust_question={'Do you trust the files in this folder?' in rendered}, "
            f"trust_option={'1. Yes' in rendered}, trust_selected={trust_selected}, "
            f"readiness_seen={resume_readiness_seen}, resume_typed={resume_typed}, "
            f"resume_sent={resume_sent}, result_seen={result_seen}, exit_sent={exit_sent})",
            file=sys.stderr,
        )
        return 124
    finally:
        terminate(process)
        os.close(master)


if __name__ == "__main__":
    raise SystemExit(main())
