import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("exhaustive_runner", Path(__file__).parents[1] / "scripts/test-exhaustive.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class CompletionContract(unittest.TestCase):
    def execute(self, arguments, effect):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "evidence"
            with patch.object(runner, "scopes", return_value={"first": {}, "second": {}}), \
                 patch.object(runner, "run_scope", side_effect=effect) as invoked, \
                 patch.dict(runner.os.environ, {"TRELLAGE_TEST_OFFLINE": "1", "TRELLAGE_DEV_SOURCES": "fixture"}), \
                 patch.object(runner.sys, "argv", ["runner", "--output", str(output), *arguments]), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                error = None
                try:
                    status = runner.main()
                except RuntimeError as caught:
                    status, error = None, str(caught)
            return status, json.loads((output / "summary.json").read_text()), invoked.call_count, error

    @staticmethod
    def passed(name, _scope, _directory):
        return {"name": name, "status": "passed"}

    def test_all_registered_scopes_passing_cannot_discharge_missing_behavior(self):
        status, report, count, _ = self.execute([], self.passed)
        self.assertEqual(status, 2)
        self.assertEqual(count, 2)
        self.assertFalse(report["complete"])
        self.assertEqual(report["status"], "partial")
        self.assertTrue(report["missingCoverage"])

    def test_explicit_partial_selection_never_claims_full_completion(self):
        status, report, count, _ = self.execute(["--scope", "first"], self.passed)
        self.assertEqual(status, 0)
        self.assertEqual(count, 1)
        self.assertEqual(report["selectedScopes"], ["first"])
        self.assertTrue(report["partialSelection"])
        self.assertFalse(report["complete"])

    def test_verification_failure_stops_later_scopes_and_is_saved(self):
        def failure(name, _scope, _directory):
            return {"name": name, "status": "verification-failed", "stderr": "fixture.log"}
        status, report, count, _ = self.execute([], failure)
        self.assertEqual(status, 1)
        self.assertEqual(count, 1)
        self.assertEqual(report["status"], "failed")
        self.assertFalse(report["complete"])
        self.assertIn("finishedAt", report)

    def test_exception_leaves_a_terminal_failed_summary(self):
        status, report, count, error = self.execute([], RuntimeError("fixture failure"))
        self.assertIsNone(status)
        self.assertEqual(error, "fixture failure")
        self.assertEqual(count, 1)
        self.assertEqual(report["status"], "failed")
        self.assertFalse(report["complete"])
        self.assertEqual(report["error"], "RuntimeError: fixture failure")


if __name__ == "__main__":
    unittest.main()
