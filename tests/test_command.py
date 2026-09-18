from __future__ import annotations

import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
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
