#!/usr/bin/env python3

import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
import time
import unittest


PICKER = Path(__file__).resolve().parents[1] / "terminal-picker.mjs"


def normalized_terminal(attributes):
    normalized = list(attributes)
    normalized[3] &= ~getattr(termios, "PENDIN", 0)
    return normalized


class PickerProcess:
    def __init__(self, payload, rows=24, columns=80):
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(
            self.slave,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", rows, columns, 0, 0),
        )
        self.initial_terminal = termios.tcgetattr(self.slave)

        def acquire_controlling_terminal():
            os.setsid()
            fcntl.ioctl(self.slave, termios.TIOCSCTTY, 0)
            os.tcsetpgrp(self.slave, os.getpgrp())

        self.process = subprocess.Popen(
            ["node", str(PICKER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.slave,
            preexec_fn=acquire_controlling_terminal,
        )
        self.process.stdin.write(json.dumps(payload).encode())
        self.process.stdin.close()
        self.process.stdin = None
        self.ui = bytearray()
        self.read_until(b"Enter select")

    def read_available(self):
        while True:
            readable, _, _ = select.select([self.master], [], [], 0)
            if not readable:
                return
            try:
                chunk = os.read(self.master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise
            if not chunk:
                return
            self.ui.extend(chunk)

    def read_until(self, expected, timeout=3):
        deadline = time.monotonic() + timeout
        while expected not in self.ui and time.monotonic() < deadline:
            readable, _, _ = select.select([self.master], [], [], 0.05)
            if readable:
                self.read_available()
            if self.process.poll() is not None:
                self.read_available()
                break
        if expected not in self.ui:
            self.close()
            raise AssertionError(f"picker UI did not contain {expected!r}: {self.ui!r}")

    def finish(self, keys=None, sent_signal=None):
        try:
            if keys is not None:
                os.write(self.master, keys)
            if sent_signal is not None:
                os.kill(self.process.pid, sent_signal)
            self.read_until(b"\x1b[?25h")
            restored = normalized_terminal(termios.tcgetattr(self.slave)) == normalized_terminal(
                self.initial_terminal
            )
            os.close(self.slave)
            self.slave = None
            stdout, _ = self.process.communicate(timeout=3)
            self.read_available()
            return (self.process.returncode, stdout, bytes(self.ui), restored)
        finally:
            self.close()

    def resize(self, rows, columns):
        fcntl.ioctl(
            self.slave,
            termios.TIOCSWINSZ,
            struct.pack("HHHH", rows, columns, 0, 0),
        )
        os.kill(self.process.pid, signal.SIGWINCH)

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
            self.process.wait()
        for descriptor in (self.master, self.slave):
            if descriptor is None:
                continue
            try:
                os.close(descriptor)
            except OSError:
                pass


class TerminalPickerTest(unittest.TestCase):
    choices = [
        {"id": "stable-one", "label": "First choice"},
        {"id": "stable-two", "label": "Second choice"},
        {"id": "stable-three", "label": "Third choice"},
    ]

    def test_enter_writes_only_stable_id_to_stdout(self):
        picker = PickerProcess(self.choices)
        returncode, stdout, ui, restored = picker.finish(b"\r")

        self.assertEqual(returncode, 0)
        self.assertEqual(stdout, b"stable-one\n")
        self.assertIn(b"First choice", ui)
        self.assertNotIn(b"First choice", stdout)
        self.assertTrue(restored)

    def test_arrow_navigation_selects_choice(self):
        picker = PickerProcess({"prompt": "Pick a profile", "choices": self.choices})
        returncode, stdout, ui, restored = picker.finish(b"\x1b[B\x1b[B\x1b[A\r")

        self.assertEqual(returncode, 0)
        self.assertEqual(stdout, b"stable-two\n")
        self.assertIn(b"Pick a profile", ui)
        self.assertTrue(restored)

    def test_navigation_keeps_selection_inside_small_viewport(self):
        choices = [
            {"id": f"id-{index}", "label": f"Choice {index}"}
            for index in range(8)
        ]
        picker = PickerProcess(choices, rows=6, columns=30)
        returncode, stdout, ui, restored = picker.finish(b"\x1b[B" * 6 + b"\r")

        self.assertEqual(returncode, 0)
        self.assertEqual(stdout, b"id-6\n")
        self.assertIn("↑".encode(), ui)
        self.assertIn(b"Choice 6", ui)
        self.assertTrue(restored)

    def test_description_and_details_wrap_at_realistic_widths(self):
        description = (
            "A complete engineering profile with a deliberately long description "
            "that must wrap without changing the concise list row."
        )
        details = (
            "Ready: healthy. Plugins 1: hve-core-all@hve-core 3.3.101. "
            "Package skills: 122. Visible skills: 124. MCPs 2: docs, files."
        )
        for columns in (60, 80, 160):
            with self.subTest(columns=columns):
                picker = PickerProcess(
                    [
                        {
                            "id": "hve",
                            "label": "copilot / hve",
                            "description": description,
                            "details": details,
                        }
                    ],
                    rows=24,
                    columns=columns,
                )
                returncode, stdout, ui, restored = picker.finish(b"\r")

                self.assertEqual(returncode, 0)
                self.assertEqual(stdout, b"hve\n")
                self.assertIn(b"Description: A complete engineering profile", ui)
                self.assertIn(b"Details: Ready: healthy.", ui)
                self.assertTrue(restored)

    def test_tiny_terminal_marks_detail_overflow_and_keeps_choice_visible(self):
        picker = PickerProcess(
            [
                {
                    "id": "one",
                    "label": "Choice one",
                    "description": " ".join(["description"] * 30),
                    "details": " ".join(["inventory"] * 30),
                },
                {"id": "two", "label": "Choice two"},
            ],
            rows=5,
            columns=60,
        )
        returncode, stdout, ui, restored = picker.finish(b"\r")

        self.assertEqual(returncode, 0)
        self.assertEqual(stdout, b"one\n")
        self.assertIn(b"Choice one", ui)
        self.assertIn(b"detail line(s) hidden; resize to view", ui)
        self.assertTrue(restored)

    def test_terminal_with_no_detail_rows_marks_details_hidden(self):
        picker = PickerProcess(
            [
                {
                    "id": "one",
                    "label": "Choice one",
                    "description": "Full description",
                }
            ],
            rows=3,
            columns=60,
        )
        returncode, stdout, ui, restored = picker.finish(b"\r")

        self.assertEqual(returncode, 0)
        self.assertEqual(stdout, b"one\n")
        self.assertIn(b"Choice one", ui)
        self.assertIn(b"Details hidden; resize", ui)
        self.assertTrue(restored)

    def test_resize_reflows_detail_and_expands_viewport(self):
        picker = PickerProcess(
            [
                {
                    "id": "one",
                    "label": "Choice one",
                    "description": " ".join(["long"] * 40),
                    "details": "MCPs 3: alpha, beta, gamma",
                },
                {"id": "two", "label": "Choice two"},
            ],
            rows=5,
            columns=60,
        )
        picker.resize(16, 160)
        picker.read_until(b"MCPs 3: alpha, beta, gamma")
        returncode, stdout, ui, restored = picker.finish(b"\x1b[B\r")

        self.assertEqual(returncode, 0)
        self.assertEqual(stdout, b"two\n")
        self.assertIn(b"Choice two", ui)
        self.assertTrue(restored)

    def test_escape_cancels_without_stdout(self):
        picker = PickerProcess(self.choices)
        returncode, stdout, _, restored = picker.finish(b"\x1b")

        self.assertEqual(returncode, 130)
        self.assertEqual(stdout, b"")
        self.assertTrue(restored)

    def test_ctrl_c_cancels_without_stdout(self):
        picker = PickerProcess(self.choices)
        returncode, stdout, _, restored = picker.finish(b"\x03")

        self.assertEqual(returncode, 130)
        self.assertEqual(stdout, b"")
        self.assertTrue(restored)

    def test_signal_restores_terminal(self):
        picker = PickerProcess(self.choices)
        returncode, stdout, _, restored = picker.finish(sent_signal=signal.SIGTERM)

        self.assertEqual(returncode, 143)
        self.assertEqual(stdout, b"")
        self.assertTrue(restored)

    def test_invalid_choices_fail_before_terminal_use(self):
        completed = subprocess.run(
            ["node", str(PICKER)],
            input=b'[{"id":"duplicate","label":"One"},{"id":"duplicate","label":"Two"}]',
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"choice IDs must be unique", completed.stderr)

    def test_invalid_optional_detail_fails_before_terminal_use(self):
        completed = subprocess.run(
            ["node", str(PICKER)],
            input=json.dumps(
                [{"id": "one", "label": "One", "description": "unsafe\ntext"}]
            ).encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"description must not contain control characters", completed.stderr)

    def test_valid_input_without_controlling_terminal_has_clear_error(self):
        completed = subprocess.run(
            ["node", str(PICKER)],
            input=json.dumps(self.choices).encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
            check=False,
        )

        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, b"")
        self.assertIn(b"interactive controlling terminal is required", completed.stderr)


if __name__ == "__main__":
    unittest.main()
