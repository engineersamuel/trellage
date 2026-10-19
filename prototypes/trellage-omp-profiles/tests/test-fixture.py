#!/usr/bin/env python3
"""Failure-path regressions for OMP fixture supervision and synchronization."""

import importlib.util
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("supervisor", HERE / "run-contract.py")
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class FixtureTests(unittest.TestCase):
    def test_failed_profile_publication_removes_partial_state(self):
        source = (HERE.parent / "bin/omp").read_text()
        publication = source.split("publish_profile() (", 1)[1].split("\ncompose_pi_config_files()", 1)[0]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            script = r'''
runtime_root="$HOME/runtime"
profile_root="$HOME/.omp/profiles/test"
agent_root="$profile_root/agent"
profile_marker="$profile_root/marker"
profile_marker_value=managed
managed_overlay_path="$runtime_root/overlays/test.yml"
profile_kind=local
require_safe_profile_path() { :; }
profile_is_owned_or_adoptable() { :; }
require_safe_overlay_path() { :; }
prepare_profile_directories() { mkdir -p "$agent_root" "$runtime_root/overlays"; }
publish_local_models() { printf models >"$agent_root/models.yml"; }
publish_managed_overlay() { printf overlay >"$managed_overlay_path"; }
mv() {
  if [[ "${3-}" == "$profile_marker" ]]; then
    printf 'injected marker publication failure\n' >&2
    return 23
  fi
  command mv "$@"
}
'''
            result = subprocess.run(
                ["/bin/bash", "-euc", script + "\npublish_profile() (" + publication + "\npublish_profile\n"],
                env={**os.environ, "HOME": directory}, capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 23, result.stderr)
            self.assertIn("injected marker publication failure", result.stderr)
            self.assertNotIn("unbound variable", result.stderr)
            self.assertFalse((root / ".omp").exists(), result.stderr)
            self.assertEqual(list(runtime.iterdir()), [], result.stderr)

    def test_output_and_failure_status(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "output"
            status = supervisor.run([sys.executable, "-c",
                                     "import sys; print('x'*100000); print('diagnostic',file=sys.stderr); sys.exit(23)"], log, 5)
            self.assertEqual(status, 23)
            self.assertIn("diagnostic", log.read_text())
            self.assertGreater(log.stat().st_size, 100000)

    def test_unread_output_cannot_hold_supervisor(self):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "output"
            log.write_bytes(b"x" * 1000000)
            read_fd, write_fd = os.pipe()
            try:
                started = time.monotonic()
                self.assertFalse(supervisor.replay(log, write_fd, timeout=0.1))
                self.assertLess(time.monotonic() - started, 2)
                self.assertTrue(os.get_blocking(write_fd))
                self.assertEqual(log.stat().st_size, 1000000)
            finally:
                os.close(read_fd)
                os.close(write_fd)

    def test_timeout_cleans_detached_descendant(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pid_file = root / "pid"
            worker = (
                "import subprocess,sys,time; from pathlib import Path; "
                "p=subprocess.Popen([sys.executable,'-c',"
                "'import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(60)'],start_new_session=True); "
                "Path(sys.argv[1]).write_text(str(p.pid)); time.sleep(60)"
            )
            started = time.monotonic()
            status = supervisor.run([sys.executable, "-c", worker, str(pid_file)], root / "log", 1)
            self.assertEqual(status, 124)
            self.assertLess(time.monotonic() - started, 4)
            self.assertIn("timed out", (root / "log").read_text())
            pid = int(pid_file.read_text())
            try:
                result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
                self.assertTrue(not result.stdout.strip() or result.stdout.strip().startswith("Z"), result.stdout)
            finally:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_release_and_missing_release(self):
        with tempfile.TemporaryDirectory() as directory:
            ready = Path(directory) / "ready"
            command = ["bash", "-c", '. "$1"; omp_fixture_wait "$2" "test release"',
                       "fixture", str(HERE / "synchronization.sh"), str(ready)]
            ready.touch()
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            ready.unlink()
            result = subprocess.run(command, env={**os.environ, "OMP_FIXTURE_WAIT_SECONDS": "1"},
                                    capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 124)
            self.assertIn("test release", result.stderr)

    def test_cancellation_status_and_cleanup(self):
        for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            with self.subTest(signal=number), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                ready = root / "ready"
                worker = "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)"
                driver = (
                    "import importlib.util,sys; "
                    "s=importlib.util.spec_from_file_location('supervisor',sys.argv[1]); "
                    "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                    "sys.exit(m.run([sys.executable,'-c',sys.argv[2],sys.argv[3]],sys.argv[4],10))"
                )
                process = subprocess.Popen([sys.executable, "-c", driver, str(HERE / "run-contract.py"),
                                            worker, str(ready), str(root / "log")])
                try:
                    deadline = time.monotonic() + 5
                    while not ready.exists():
                        self.assertIsNone(process.poll())
                        self.assertLess(time.monotonic(), deadline)
                        time.sleep(0.01)
                    pid = int(ready.read_text())
                    process.send_signal(number)
                    self.assertEqual(process.wait(timeout=3), 128 + number)
                    with self.assertRaises(ProcessLookupError):
                        os.kill(pid, 0)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    if ready.exists():
                        try:
                            os.killpg(int(ready.read_text()), signal.SIGKILL)
                        except ProcessLookupError:
                            pass


if __name__ == "__main__":
    unittest.main()
