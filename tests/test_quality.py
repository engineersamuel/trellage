import argparse
import contextlib
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import quality
import quality_advisories as advisories
import quality_checks as checks
import quality_coverage as coverage
import quality_secrets


class SelectionTests(unittest.TestCase):
    def test_shared_contracts_select_all_consumers(self):
        value = quality.plan(["packages/trellage-guide-core/src/conversation.ts"])
        self.assertFalse(value["full"])
        self.assertTrue(value["macos"])
        self.assertTrue(value["analysis"])
        self.assertTrue({"launcher", "source-runtime", "conversation-source"} <= set(value["targets"]))

    def test_global_unknown_and_missing_base_cannot_skip_tests(self):
        for path in ["mise.toml", "new-package/src/index.ts", "packages/trellage-runtime/src/index.ts"]:
            with self.subTest(path=path):
                value = quality.plan([path])
                self.assertTrue(value["full"])
                self.assertTrue(value["macos"])
        self.assertTrue(quality.plan([], "base unavailable")["full"])
        self.assertIn("swift", quality.plan([], "base unavailable")["prototypes"])
        self.assertEqual(set(quality.plan([], complete=True)["prototypes"]), quality.ALL_PROTOTYPES)

    def test_docs_and_independent_prototypes_avoid_native_suites(self):
        value = quality.plan(["docs/verification.md"])
        self.assertFalse(value["full"])
        self.assertFalse(value["macos"])
        self.assertEqual(value["targets"], sorted(quality.BASE_TARGETS))
        value = quality.plan(["prototypes/software-factory/shared/model.ts"])
        self.assertEqual(value["prototypes"], ["coordinator", "web-foldkit"])
        self.assertFalse(value["macos"])

    def test_factory_runs_when_linked_source_or_dependencies_change(self):
        for path in [
            "packages/trellage-runtime/src/native-run/run.ts",
            "packages/trellage-launcher/src/guide-optimize-catalog.ts",
            "packages/trellage-guide-core/src/index.ts",
            "package.json",
            "bun.lock",
        ]:
            with self.subTest(path=path):
                self.assertIn("coordinator", quality.plan([path])["prototypes"])

    def test_final_gate_rejects_failed_cancelled_missing_and_unexpected_skips(self):
        value = quality.plan(["packages/trellage-launcher/src/cli.tsx"])
        results = {
            "plan": {"result": "success"},
            "static": {"result": "success"},
            "linux": {"result": "success"},
            "macos-tests": {"result": "success"},
            "dependencies": {"result": "skipped"},
            "prototypes": {"result": "success"},
        }
        self.assertTrue(quality.gate_results(value, results))
        for name in ["plan", "static", "linux", "macos-tests", "prototypes"]:
            for status in ["failure", "cancelled", "skipped", None]:
                with self.subTest(job=name, status=status):
                    self.assertFalse(quality.gate_results(value, results | {name: {"result": status}}))
        self.assertFalse(quality.gate_results(value, {}))

    def test_timing_sensitive_native_tests_are_serial(self):
        value = quality.plan(["prototypes/trellage-omp-profiles/bin/omp"])
        commands = dict(quality.test_commands(value, "linux"))
        self.assertNotIn("native-omp-profile", commands["affected-contracts"])
        self.assertNotIn("native-profile-router", commands["affected-contracts"])
        self.assertIn("native-omp-profile", commands)
        self.assertIn("native-profile-router", commands)


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="trellage-quality-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        checks.git(self.root, "init", "--quiet", "-b", "main")
        checks.git(self.root, "config", "user.name", "Quality Fixture")
        checks.git(self.root, "config", "user.email", "quality@example.invalid")
        checks.git(self.root, "config", "core.hooksPath", "/dev/null")
        self.write("README.md", "Initial state\n")
        self.commit()

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def commit(self):
        checks.git(self.root, "add", ".")
        checks.git(self.root, "commit", "--quiet", "-m", "Quality fixture")
        return checks.git(self.root, "rev-parse", "HEAD").stdout.decode().strip()

    def test_rename_and_delete_keep_both_sides_in_selection(self):
        self.write("packages/trellage-launcher/src/old.ts", "export {}\n")
        self.write("docs/removed.md", "Removed\n")
        base = self.commit()
        checks.git(self.root, "mv", "packages/trellage-launcher/src/old.ts", "docs/new.ts")
        checks.git(self.root, "rm", "docs/removed.md")
        self.commit()
        paths, reason = quality.changed_files(self.root, base)
        self.assertIsNone(reason)
        self.assertEqual(paths, ["docs/new.ts", "docs/removed.md", "packages/trellage-launcher/src/old.ts"])
        self.assertIn("launcher", quality.plan(paths)["targets"])

    def test_unavailable_base_broadens_and_local_edits_are_included(self):
        base = checks.git(self.root, "rev-parse", "HEAD").stdout.decode().strip()
        self.write("local.py", "VALUE = 1\n")
        paths, reason = quality.changed_files(self.root, base, local=True)
        self.assertIsNone(reason)
        self.assertIn("local.py", paths)
        paths, reason = quality.changed_files(self.root, "f" * 40)
        self.assertIsNotNone(reason)
        self.assertIn("README.md", paths)
        self.assertTrue(quality.plan(paths, reason)["full"])

    def test_plan_preview_includes_uncommitted_and_untracked_changes(self):
        self.write("README.md", "Updated\n")
        self.write("packages/trellage-launcher/src/new.ts", "export {}\n")
        args = argparse.Namespace(mode="plan", base="HEAD", head="HEAD", full=False, plan_file=None)
        output = io.StringIO()
        with patch.object(quality, "ROOT", self.root), contextlib.redirect_stdout(output):
            self.assertTrue(quality.dispatch_plan(args))
        value = json.loads(output.getvalue())
        self.assertEqual(value["files"], ["README.md", "packages/trellage-launcher/src/new.ts"])
        self.assertIn("launcher", value["targets"])

    def test_staged_bytes_and_alternate_index_leave_caller_unchanged(self):
        self.write("example.py", "STAGED = True\n")
        checks.git(self.root, "add", "example.py")
        self.write("example.py", "UNSTAGED = True\n")
        index_before = (self.root / ".git/index").read_bytes()
        with quality.staged_snapshot(self.root, ["example.py"]) as snapshot:
            self.assertEqual((snapshot / "example.py").read_text(), "STAGED = True\n")
            self.assertEqual((snapshot / "README.md").read_text(), "Initial state\n")
        self.assertEqual((self.root / "example.py").read_text(), "UNSTAGED = True\n")
        self.assertEqual((self.root / ".git/index").read_bytes(), index_before)
        alternate = self.root / ".git/alternate-index"
        with patch.dict(os.environ, {"GIT_INDEX_FILE": str(alternate)}):
            checks.git(self.root, "read-tree", "HEAD", index=True)
            self.write("example.py", "ALTERNATE = True\n")
            checks.git(self.root, "add", "example.py", index=True)
            self.write("example.py", "WORKTREE = True\n")
            with quality.staged_snapshot(self.root, ["example.py"]) as snapshot:
                self.assertEqual((snapshot / "example.py").read_text(), "ALTERNATE = True\n")
        self.assertEqual((self.root / ".git/index").read_bytes(), index_before)
        self.assertEqual((self.root / "example.py").read_text(), "WORKTREE = True\n")

    def test_staged_symlinks_are_not_followed_and_unsafe_paths_fail(self):
        (self.root / "alias").symlink_to("README.md")
        checks.git(self.root, "add", "alias")
        with quality.staged_snapshot(self.root, ["alias"]) as snapshot:
            self.assertFalse((snapshot / "alias").exists())
        with self.assertRaisesRegex(checks.GateError, "Unsafe staged path"):
            with quality.staged_snapshot(self.root, ["../outside"]):
                self.fail("unsafe snapshot yielded")

    def test_new_multiple_deleted_and_non_head_pushes(self):
        base = checks.git(self.root, "rev-parse", "HEAD").stdout.decode().strip()
        checks.git(self.root, "update-ref", "refs/remotes/upstream/trunk", base)
        checks.git(self.root, "symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/trunk")
        self.write("docs/new.md", "New\n")
        head = self.commit()
        zero = "0" * 40
        updates = (
            f"refs/heads/main {head} refs/heads/main {base}\n"
            f"refs/heads/topic {head} refs/heads/topic {zero}\n"
            f"(delete) {zero} refs/heads/old {base}\n"
        )
        paths, reason, ranges = quality.pushed_files(self.root, updates, "upstream")
        self.assertEqual(paths, ["docs/new.md"])
        self.assertIsNone(reason)
        self.assertEqual(len(ranges), 2)
        self.assertEqual(
            quality.pushed_files(self.root, f"(delete) {zero} refs/heads/old {base}", "upstream"), ([], None, [])
        )
        with self.assertRaisesRegex(checks.GateError, "checked out"):
            quality.pushed_files(self.root, f"refs/heads/old {base} refs/heads/old {zero}", "upstream")
        with self.assertRaisesRegex(checks.GateError, "Invalid pre-push"):
            quality.pushed_files(self.root, "incomplete input", "upstream")
        checks.git(self.root, "tag", "-am", "Fixture release", "release")
        tag = checks.git(self.root, "rev-parse", "release").stdout.decode().strip()
        paths, reason, _ = quality.pushed_files(
            self.root, f"refs/tags/release {tag} refs/tags/release {zero}", "upstream"
        )
        self.assertEqual(paths, ["docs/new.md"])
        self.assertIsNone(reason)
        paths, reason, ranges = quality.pushed_files(
            self.root, f"refs/heads/main {head} refs/heads/main {'f' * 40}", "upstream"
        )
        self.assertIsNotNone(reason)
        self.assertIn("README.md", paths)
        self.assertEqual(ranges, [(None, head)])

    def test_push_refuses_untracked_source_that_would_not_reach_ci(self):
        base = checks.git(self.root, "rev-parse", "HEAD").stdout.decode().strip()
        self.write("docs/new.md", "New\n")
        head = self.commit()
        self.write("untracked.test.ts", "throw new Error('not in the pushed commit')\n")
        with (
            patch.object(quality, "ROOT", self.root),
            patch.dict(os.environ, {"TRELLAGE_PUSH_REFS": f"refs/heads/main {head} refs/heads/main {base}"}),
        ):
            with self.assertRaisesRegex(checks.GateError, "untracked source"):
                quality.check_push()

    def test_invalid_saved_plans_cannot_drop_required_checks(self):
        value = quality.plan(["docs/new.md"])
        self.write("plan.json", json.dumps(value))
        self.assertEqual(quality.read_plan(str(self.root / "plan.json")), value)
        changes = [
            {"version": True},
            {"full": "false"},
            {"targets": []},
            {"prototypes": ["unknown"]},
            {"files": ["../outside"]},
            {"full": True},
            {"targets": [*value["targets"], "--eval=install"]},
        ]
        for change in changes:
            with self.subTest(change=change):
                self.write("plan.json", json.dumps(value | change))
                with self.assertRaises(checks.GateError):
                    quality.read_plan(str(self.root / "plan.json"))

    def test_nested_git_commands_clear_all_repository_variables(self):
        original = (self.root / ".git/config").read_bytes()
        nested = self.root / "nested"
        polluted = {
            "GIT_DIR": str(self.root / ".git"),
            "GIT_WORK_TREE": str(self.root),
            "GIT_COMMON_DIR": str(self.root / ".git"),
            "GIT_INDEX_FILE": str(self.root / ".git/index"),
            "GIT_PREFIX": "caller/",
            "GIT_OBJECT_DIRECTORY": str(self.root / ".git/objects"),
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "core.bare",
            "GIT_CONFIG_VALUE_0": "true",
        }
        with patch.dict(os.environ, polluted), patch.object(checks, "ROOT", self.root):
            with contextlib.redirect_stdout(io.StringIO()):
                result = checks.run_command("nested", ["git", "init", "--quiet", "--bare", str(nested)], self.root)
        self.assertEqual(result["exitCode"], 0)
        self.assertTrue((nested / "HEAD").exists())
        self.assertEqual((self.root / ".git/config").read_bytes(), original)

    def test_failed_or_missing_tools_cannot_pass(self):
        with patch.object(checks, "ROOT", self.root), contextlib.redirect_stdout(io.StringIO()):
            result = checks.run_command("failure", [sys.executable, "-c", "raise SystemExit(9)"], self.root)
        self.assertEqual(result["exitCode"], 9)
        with patch("quality_checks.shutil.which", return_value=None):
            with self.assertRaisesRegex(checks.GateError, "quality:setup"):
                checks.executable("missing-tool", self.root)
        with patch("quality_checks.shutil.which", return_value="/unrelated/global/oxlint"):
            with self.assertRaisesRegex(checks.GateError, "quality:setup"):
                checks.executable("oxlint", self.root)
        with (
            patch.object(quality, "ROOT", self.root),
            patch.object(quality, "executable", return_value="fixture"),
            patch.object(quality, "run_command", return_value={"exitCode": 0}),
            self.assertRaisesRegex(checks.GateError, "did not complete"),
        ):
            quality.secrets(self.root, ["README.md"])

    def baseline(self):
        self.write("mise.toml", '[tools]\nruff = "1.0"\n')
        self.write("package.json", '{"devDependencies":{}}\n')
        self.write("ruff.toml", "line-length = 120\n")
        self.write("legacy.py", "import unused\n")
        return {
            "version": 1,
            "checks": {
                "ruff": {
                    "settings": checks.settings_digest(self.root, "ruff"),
                    "files": {
                        "legacy.py": {
                            "sha256": checks.digest(self.root / "legacy.py"),
                            "reason": "Reviewed legacy finding",
                        }
                    },
                }
            },
        }

    def test_baseline_requires_exact_bytes_and_settings(self):
        baseline = self.baseline()
        self.assertEqual(checks.baseline_files(self.root, "ruff", ["legacy.py"], baseline), ([], 1))
        self.write("legacy.py", "import a_new_violation\n")
        self.assertEqual(checks.baseline_files(self.root, "ruff", ["legacy.py"], baseline), (["legacy.py"], 0))
        self.write("legacy.py", "import unused\n")
        self.write("ruff.toml", "line-length = 100\n")
        self.assertEqual(checks.baseline_files(self.root, "ruff", ["legacy.py"], baseline), (["legacy.py"], 0))
        self.write("new.py", "import unused\n")
        self.assertEqual(checks.baseline_files(self.root, "ruff", ["new.py"], baseline), (["new.py"], 0))

    def test_expired_and_forbidden_baselines_fail(self):
        baseline = self.baseline()
        baseline["checks"]["ruff"]["files"]["legacy.py"]["reviewBy"] = (
            dt.date.today() - dt.timedelta(days=1)
        ).isoformat()
        self.write(str(checks.BASELINE), json.dumps(baseline))
        with self.assertRaisesRegex(checks.GateError, "expired"):
            checks.read_baseline(self.root)
        self.write(str(checks.BASELINE), '{"version":1,"checks":{"secrets":{}}}')
        with self.assertRaisesRegex(checks.GateError, "not permitted"):
            checks.read_baseline(self.root)

    def test_invalid_configuration_cannot_be_baselined(self):
        self.write("settings.json", '{"key":1,"key":2}')
        with self.assertRaisesRegex(checks.GateError, "Duplicate"):
            checks.check_config(self.root, ["settings.json"])
        self.write(".agents/mcp_config.json", '{"mcpServers":[]}')
        with self.assertRaisesRegex(checks.GateError, "mcpServers"):
            checks.check_config(self.root, [".agents/mcp_config.json"])

    def test_public_fixture_exception_rejects_changed_secret(self):
        self.write("fixture.pem", "public test fixture\n")
        manifest = {
            "fixture.pem": {
                "sha256": hashlib.sha256(b"public test fixture\n").hexdigest(),
                "reason": "Public test-only fixture",
            }
        }
        self.write(str(quality_secrets.FIXTURES), json.dumps(manifest))
        self.assertEqual(quality_secrets.public_fixtures(self.root), {"fixture.pem"})
        checks.git(self.root, "add", ".")
        with quality.staged_snapshot(self.root, ["fixture.pem"]) as snapshot:
            self.assertEqual(quality_secrets.public_fixtures(snapshot), {"fixture.pem"})
        self.write("fixture.pem", "different material\n")
        with self.assertRaisesRegex(ValueError, "changed"):
            quality_secrets.public_fixtures(self.root)

    def test_graph_gate_allows_known_findings_but_rejects_new_ones_and_tool_failures(self):
        known = "exports:source.ts:old"
        self.write(
            str(checks.BASELINE),
            json.dumps({"version": 1, "checks": {"knip": {"settings": "pin", "findings": [known]}}}),
        )
        with (
            patch.object(checks, "settings_digest", return_value="pin"),
            patch.object(checks, "executable", side_effect=lambda name: name),
            patch.object(checks, "run_command", return_value={"exitCode": 0}),
            patch.object(checks, "write_report"),
        ):
            for added, expected in [(set(), True), ({"exports:source.ts:new"}, False)]:
                with (
                    self.subTest(added=added),
                    patch.object(
                        checks,
                        "scan_graph",
                        side_effect=[({known} | added, 0), (set(), 0)],
                    ),
                    contextlib.redirect_stdout(io.StringIO()),
                    contextlib.redirect_stderr(io.StringIO()),
                ):
                    self.assertEqual(checks.analysis(self.root), expected)
        for code, report in [(1, '{"issues":[]}'), (2, '{"issues":[]}'), (0, "{}")]:
            with (
                self.subTest(code=code, report=report),
                patch.object(checks, "ROOT", self.root),
                patch(
                    "quality_checks.subprocess.run",
                    return_value=subprocess.CompletedProcess([], code, report, "failed"),
                ),
            ):
                with self.assertRaises(checks.GateError):
                    checks.scan_graph(self.root, "knip", ["fixture"])

    def test_successful_graph_commands_cannot_omit_typescript_inputs(self):
        self.write("packages/example/src/main.ts", "export const value = 1\n")
        for modules in [[], [{"source": "scripts/only-javascript.js"}]]:
            with self.subTest(modules=modules), self.assertRaisesRegex(checks.GateError, "omitted"):
                checks.validate_graph_inputs(self.root, {"modules": modules})
        checks.validate_graph_inputs(self.root, {"modules": [{"source": "packages/example/src/main.ts"}]})
        with self.assertRaisesRegex(checks.GateError, "empty"):
            checks.graph_findings("architecture", {"modules": []})

    def test_graph_baselines_check_both_edge_ends_and_every_cycle_member(self):
        paths = ["packages/example/src/a.ts", "packages/example/src/b.ts", "packages/example/src/c.ts"]
        for path in paths:
            self.write(path, "export const value = 1\n")
        self.commit()
        issue = {
            "rule": {"name": "no-cycles"},
            "from": paths[0],
            "to": paths[1],
            "cycle": [{"name": path} for path in paths],
        }
        report = {"modules": [{"source": paths[0]}], "summary": {"violations": [issue]}}
        findings = checks.graph_findings("architecture", report)
        with patch.object(checks, "settings_digest", return_value="pin"):
            checks.graph_baseline(self.root, "architecture", findings)
            for path in paths[1:]:
                self.write(path, "export const value = 2\n")
                with self.subTest(path=path), self.assertRaisesRegex(checks.GateError, "modified"):
                    checks.graph_baseline(self.root, "architecture", findings)
                self.write(path, "export const value = 1\n")
        issue["cycle"].append({"name": "packages/example/src/new.ts"})
        self.assertNotEqual(findings, checks.graph_findings("architecture", report))

    def test_advisory_exceptions_are_version_path_id_scoped_and_expire(self):
        report = {
            "results": [
                {
                    "source": {"path": "bun.lock"},
                    "packages": [
                        {
                            "package": {"ecosystem": "npm", "name": "example", "version": "1.0.0"},
                            "vulnerabilities": [{"id": "GHSA-example"}],
                        }
                    ],
                }
            ]
        }
        key = "bun.lock|npm|example|1.0.0|GHSA-example"
        self.assertEqual(advisories.finding_keys(report, self.root), {key})
        exception = {
            key: {"reason": "Reviewed fixture", "reviewBy": (dt.date.today() + dt.timedelta(days=1)).isoformat()}
        }
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(advisories.review_findings({key}, exception))
            for old, new in [("bun.lock", "other/bun.lock"), ("1.0.0", "1.0.1"), ("GHSA-example", "GHSA-other")]:
                with self.subTest(change=new):
                    self.assertFalse(advisories.review_findings({key.replace(old, new)}, exception))
        exception[key]["reviewBy"] = (dt.date.today() - dt.timedelta(days=1)).isoformat()
        with self.assertRaisesRegex(checks.GateError, "expired"):
            advisories.review_findings({key}, exception)

    def test_coverage_excludes_other_packages_and_rejects_regressions_or_missing_data(self):
        self.write(
            "lcov.info",
            "SF:src/core.ts\nLF:10\nLH:8\nFNF:2\nFNH:1\nend_of_record\n"
            "SF:../trellage-launcher/src/other.ts\nLF:100\nLH:100\nend_of_record\n",
        )
        metrics = {"guide-core": coverage.read_lcov(self.root / "lcov.info", "guide-core")}
        baseline = {"packages": {"guide-core": {"lines": 80}}}
        self.assertTrue(coverage.enforce_floors(metrics, baseline))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(coverage.enforce_floors(metrics, {"packages": {"guide-core": {"lines": 81}}}))
            self.assertFalse(coverage.enforce_floors(metrics, {"packages": {"guide-core": {"branches": 1}}}))
        with self.assertRaisesRegex(checks.GateError, "Missing measured coverage"):
            coverage.enforce_floors({}, baseline)
        with self.assertRaisesRegex(checks.GateError, "Invalid coverage floor"):
            coverage.enforce_floors(metrics, {"packages": {"guide-core": {"lines": -1}}})


if __name__ == "__main__":
    unittest.main()
