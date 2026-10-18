from __future__ import annotations

import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import runpy
from pathlib import Path


COMMAND = Path(__file__).parents[1] / "scripts" / "test-command.py"


class TestCommand(unittest.TestCase):
    def run_command(self, recipe: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(COMMAND), "example", "-c", recipe],
            capture_output=True,
            text=True,
            check=False,
            timeout=10,
        )

    def test_records_success_and_preserves_stdout(self) -> None:
        result = self.run_command("printf output")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "output")
        self.assertIn("target=example event=start", result.stderr)
        self.assertRegex(result.stderr, r"target=example event=end .*duration=[0-9.]+s .*status=passed")

    def test_preserves_failure_status(self) -> None:
        result = self.run_command("exit 7")
        self.assertEqual(result.returncode, 7)
        self.assertIn("code=7 status=failed", result.stderr)

    def test_reports_signal_and_returns_shell_convention(self) -> None:
        result = self.run_command("kill -TERM $$")
        self.assertEqual(result.returncode, 128 + signal.SIGTERM)
        self.assertIn("signal=SIGTERM status=signal", result.stderr)

    def test_forwards_external_signal_to_recipe_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "ready"
            marker = Path(directory) / "terminated"
            child_script = (
                "import os, pathlib, signal; "
                f"ready = pathlib.Path({str(ready)!r}); marker = pathlib.Path({str(marker)!r}); "
                "signal.signal(signal.SIGTERM, lambda *_: (marker.write_text('terminated'), os._exit(0))); "
                "ready.write_text('ready'); signal.pause()"
            )
            child_command = shlex.join([sys.executable, "-c", child_script])
            recipe = f"trap 'wait; exit 0' TERM; {child_command} & wait"
            process = subprocess.Popen(
                [sys.executable, str(COMMAND), "example", "-c", recipe],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                deadline = time.monotonic() + 10
                while not ready.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "recipe did not start before signal")
                process.send_signal(signal.SIGTERM)
                _stdout, stderr = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 128 + signal.SIGTERM)
                self.assertIn("signal=SIGTERM status=signal", stderr)
                self.assertEqual(marker.read_text(), "terminated")
            finally:
                if process.poll() is None:
                    process.terminate()
                process.communicate(timeout=10)

    def test_timeout_kills_a_signal_ignoring_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "child.pid"
            script = (
                "import os,signal,time,pathlib; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                f"pathlib.Path({str(pid_file)!r}).write_text(str(os.getpid())); time.sleep(30)"
            )
            started = time.monotonic()
            result = subprocess.run(
                [sys.executable, str(COMMAND), "--timeout", "0.3", "slow", "-c", shlex.join([sys.executable,"-c",script])],
                capture_output=True, text=True, timeout=4,
            )
            self.assertEqual(result.returncode, 124, result.stderr)
            self.assertIn("status=timeout", result.stderr)
            self.assertLess(time.monotonic() - started, 3)
            self.assertTrue(pid_file.exists())
            pid = int(pid_file.read_text())
            # A killed child can briefly be a zombie until its parent/init reaps it.
            state = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True).stdout.strip()
            self.assertTrue(not state or state.startswith("Z"), state)

    def test_darwin_empty_group_permission_error_preserves_timeout_status(self) -> None:
        namespace = runpy.run_path(str(COMMAND), run_name="test_command_module")
        real_killpg = os.killpg

        def darwin_killpg(pgid: int, signum: int) -> None:
            if signum == signal.SIGKILL:
                raise PermissionError("empty process group")
            real_killpg(pgid, signum)

        with patch.object(os, "killpg", darwin_killpg):
            status = namespace["main"]([str(COMMAND), "--timeout", "0.1", "empty-group", "-c", "exec sleep 30"])
        self.assertEqual(status, 124)

    def test_permission_error_is_not_hidden_when_group_may_still_be_live(self) -> None:
        namespace = runpy.run_path(str(COMMAND), run_name="test_command_module")
        real_killpg = os.killpg

        def denied_killpg(pgid: int, signum: int) -> None:
            if signum == signal.SIGKILL:
                raise PermissionError("live group denied")
            real_killpg(pgid, signum)

        with patch.object(os, "killpg", denied_killpg), patch.dict(
            namespace["main"].__globals__, {"_group_has_live_members": lambda _pgid: True},
        ):
            with self.assertRaisesRegex(PermissionError, "live group denied"):
                namespace["main"]([str(COMMAND), "--timeout", "0.1", "live-group", "-c", "exec sleep 30"])

    def test_invalid_deadline_does_not_run_recipe(self) -> None:
        for value in ("0", "-1", "nan", "inf", "not-a-number"):
            result = subprocess.run(
                [sys.executable, str(COMMAND), "--timeout", value, "example", "-c", "printf executed"],
                capture_output=True, text=True, timeout=3,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")

    def test_preserves_inherited_jobserver_descriptors(self) -> None:
        reader, writer = os.pipe()
        try:
            recipe = shlex.join([sys.executable, "-c", f"import os; os.fstat({reader}); os.fstat({writer})"])
            result = subprocess.run(
                [sys.executable, str(COMMAND), "recursive-make", "-c", recipe],
                pass_fds=(reader, writer), capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
        finally:
            os.close(reader)
            os.close(writer)


if __name__ == "__main__":
    unittest.main()
