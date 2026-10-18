from pathlib import Path
import json
import importlib.util
from unittest.mock import patch
import subprocess
import sys
import tempfile
import unittest


BENCHMARK = Path(__file__).resolve().parents[1] / "scripts/benchmark-tests.py"


class BenchmarkTests(unittest.TestCase):
    def run_batch(self, candidate_target="fixture", reference_exit=0, phase="warm", first="reference"):
        with tempfile.TemporaryDirectory(prefix="trellage-benchmark-check-") as temporary:
            root = Path(temporary)
            for side, delay, target, status in (
                ("reference", 0.25, "fixture", reference_exit),
                ("candidate", 0.001, candidate_target, 0),
            ):
                directory = root / side
                directory.mkdir()
                (directory / "Makefile").write_text(
                    "test:\n"
                    + ("\t@test -f prepared\n" if phase == "clean" else "") +
                    f"\t@echo '[test-timing] target={target} event=start'\n"
                    f"\t@{sys.executable} -c 'import time; time.sleep({delay})'\n"
                    f"\t@exit {status}\n"
                    f"\t@echo '[test-timing] target={target} event=end status=passed'\n"
                )
                subprocess.run(["git", "init", "-q", "-b", "main"], cwd=directory, check=True)
                (directory / "scripts").mkdir()
                (directory / "scripts/test-offline.sh").write_text('exec "$@"\n')
                (directory / "scripts/install-source-runtime.sh").write_text(
                    'set -eu\ntest ! -e prepared\ntouch prepared\nprintf "prepared fresh dependencies\\n"\n'
                )
                subprocess.run(["git", "add", "."], cwd=directory, check=True)
                subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=fixture",
                                "-c", "user.email=fixture@trellage.invalid", "-c", "commit.gpgsign=false",
                                "commit", "-qm", "fixture"], cwd=directory, check=True)
            output = root / "batch.json"
            # Synthetic timing checks inject an idle process table; production has no bypass flag.
            loader = (
                "import importlib.util,sys; "
                "spec=importlib.util.spec_from_file_location('fixture_benchmark',sys.argv[1]); "
                "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); "
                "module.process_snapshot=lambda: []; sys.argv=sys.argv[1:]; sys.exit(module.main())"
            )
            result = subprocess.run(
                [sys.executable, "-c", loader, str(BENCHMARK), "--reference", str(root / "reference"),
                 "--candidate", str(root / "candidate"), "--output", str(output), "--label", "sensitivity",
                 "--phase", phase, "--first", first],
                capture_output=True, text=True, timeout=30,
            )
            return result, json.loads(output.read_text())

    def test_detects_a_deliberate_delay_with_five_samples_per_side(self):
        result, report = self.run_batch()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["verdict"], "faster")
        self.assertEqual(report["summary"]["reference"]["samples"], 5)
        self.assertEqual(report["summary"]["candidate"]["samples"], 5)
        measured = [sample["side"] for sample in report["samples"] if not sample["warmup"]]
        self.assertEqual(measured, ["reference", "candidate"] * 5)

    def test_rejects_a_fast_failure_before_timing_comparisons(self):
        result, report = self.run_batch(reference_exit=9)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(report["verdict"], "invalid warmup")
        self.assertEqual(len(report["samples"]), 1)
        self.assertTrue(report["samples"][0]["invalidReasons"])

    def test_rejects_changed_work_even_when_both_commands_pass(self):
        result, report = self.run_batch(candidate_target="different-work")
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(report["verdict"], "incomparable recipe inventories")

    def test_clean_samples_prepare_fresh_dependencies_and_can_reverse_order(self):
        result, report = self.run_batch(phase="clean", first="candidate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["phase"], "clean")
        self.assertEqual(len(report["samples"]), 12)
        self.assertTrue(all(not sample["invalidReasons"] for sample in report["samples"]))
        self.assertEqual([sample["side"] for sample in report["samples"]],
                         ["candidate", "reference"] * 6)


spec = importlib.util.spec_from_file_location("benchmark", BENCHMARK)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)

class MonitorTests(unittest.TestCase):
    def test_ignores_controller_and_transitive_children(self):
        rows = [(100, 1, "python3 benchmark-tests.py"), (101, 100, "bash wrapper"), (102, 101, "make test"), (103, 102, "bun test file.test.ts")]
        self.assertEqual(benchmark.competing_test_workloads(rows, 100), [])

    def test_detects_foreign_test_workloads_without_recording_arguments(self):
        rows = [(200, 1, "/usr/bin/make -j4 test"), (201, 200, "bun --no-install --no-env-file test secret-argument"), (202, 1, "npm --prefix path run test"), (203, 1, "pytest cases")]
        result = benchmark.competing_test_workloads(rows, 100)
        self.assertEqual([item["pid"] for item in result], [200, 201, 202, 203])
        self.assertNotIn("secret-argument", str(result))

    def test_does_not_mistake_application_arguments_for_test_commands(self):
        rows = [(200, 1, "bun app.ts test"), (201, 1, "npm run build"), (202, 1, "make contest"), (203, 1, "python3 -c 'test'"),
                (204, 1, "cat tests/contract.sh"), (205, 1, "bun app.ts scripts/exhaustive-native-launch.ts")]
        self.assertEqual(benchmark.competing_test_workloads(rows, 100), [])

    def test_detects_standalone_exhaustive_and_shell_contract_runners(self):
        rows = [(200, 1, "bun --no-install scripts/exhaustive-native-launch.ts agency"),
                (201, 1, "python3 scripts/test-exhaustive.py --scope agency-launch"),
                (202, 1, "bash /fixture/tests/contract.sh"),
                (203, 1, "make profile-matrix-test"),
                (204, 1, "make test-exhaustive"),
                (205, 1, "python3 scripts/benchmark-tests.py --label private-label")]
        result = benchmark.competing_test_workloads(rows, 100)
        self.assertEqual([item["pid"] for item in result], [200, 201, 202, 203, 204, 205])
        self.assertNotIn("private-label", str(result))

    def test_monitor_retains_transient_competition(self):
        monitor = benchmark.WorkloadMonitor()
        with patch.object(benchmark, "process_snapshot", side_effect=[[(200, 1, "make test")], []]), patch.object(benchmark, "process_context", return_value={"workingDirectory": "/fixture"}):
            monitor.sample()
            monitor.sample()
        self.assertEqual(len(monitor.events), 1)
        self.assertEqual(monitor.events[0]["workloads"][0]["pid"], 200)

    def test_context_retains_parent_chain_without_arguments(self):
        rows = [(200, 201, "bun test private-argument"), (201, 1, "bash private-parent-argument")]
        with patch.object(benchmark.sys, "platform", "linux"), patch.object(benchmark.os, "readlink", return_value="/fixture/worktree"):
            context = benchmark.process_context(rows, 200)
        self.assertEqual(context["workingDirectory"], "/fixture/worktree")
        self.assertEqual(context["ancestryEndsAtPid"], 1)
        self.assertEqual([item["pid"] for item in context["ancestry"]], [200, 201])
        self.assertNotIn("private-argument", str(context))
        self.assertNotIn("private-parent-argument", str(context))

    def test_exited_process_context_preserves_detection_without_private_errors(self):
        with patch.object(benchmark.sys, "platform", "linux"), patch.object(benchmark.os, "readlink", side_effect=OSError("private detail")):
            context = benchmark.process_context([(200, 201, "bun test private-argument")], 200)
        self.assertEqual(context["workingDirectoryUnavailable"], "OSError")
        self.assertEqual(context["ancestryEndsAtPid"], 201)
        self.assertNotIn("private", str(context))

    def test_macos_context_reads_only_the_working_directory(self):
        with patch.object(benchmark.sys, "platform", "darwin"), patch.object(benchmark.subprocess, "check_output", return_value="p200\nfcwd\nn/fixture/worktree\n") as read:
            context = benchmark.process_context([(200, 1, "bun test")], 200)
        self.assertEqual(context["workingDirectory"], "/fixture/worktree")
        self.assertEqual(read.call_args.args[0], ["/usr/sbin/lsof", "-a", "-p", "200", "-d", "cwd", "-Fn"])

    def test_monitor_failure_is_not_silently_treated_as_a_quiet_host(self):
        monitor = benchmark.WorkloadMonitor()
        with patch.object(benchmark, "process_snapshot", side_effect=OSError("private detail")):
            monitor.sample()
        self.assertEqual(monitor.errors, ["process monitoring failed: OSError"])


if __name__ == "__main__":
    unittest.main()
