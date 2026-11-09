import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import quality
import quality_checks as checks

WORKFLOW = """name: Fixture
on: push
permissions:
  contents: read
concurrency:
  group: fixture-${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-24.04
    timeout-minutes: 2
    steps:
      - run: echo complete
"""

PROBES = {
    "oxlint": ("example.ts", "export const value = 1\n", "debugger;\n"),
    "oxfmt": ("example.ts", "export const value = 1\n", "export    const value=1\n"),
    "ruff": ("example.py", "VALUE = 1\n", "import unused\n"),
    "ruff-format": ("example.py", "value = 1\n", "value=   1\n"),
    "shellcheck": (
        "example.sh",
        '#!/bin/sh\nvalue="two words"\nprintf "%s\\n" "$value"\n',
        '#!/bin/sh\nprintf "%s\\n" "$missing"\n',
    ),
    "typos": ("README.md", "# The fixture\n", "# " + "t" + "eh fixture\n"),
    "rumdl": ("README.md", "# Fixture\n", "#Fixture\n"),
    "hadolint": (
        "Dockerfile",
        "FROM scratch\nCOPY README.md /README.md\nUSER 65532\n",
        "FROM ubuntu:latest\nRUN apt-get update\n",
    ),
    "jactionlint": (
        ".github/workflows/fixture.yml",
        WORKFLOW,
        WORKFLOW.replace("run: echo complete", "runs: echo invalid"),
    ),
    "agnix": (
        ".agents/skills/fixture/SKILL.md",
        "---\nname: fixture\ndescription: Use when validating an isolated fixture.\n---\n\n# Fixture\n\nCheck the input.\n",
        "---\nname: Invalid Name\n---\n\n# Fixture\n",
    ),
}


@unittest.skipUnless(os.environ.get("QUALITY_TOOL_PROBES") == "1", "enable installed-tool failure probes explicitly")
class InstalledToolTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="trellage-quality-probe-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        for name in set(checks.CONFIGS.values()) | {"mise.toml", "package.json", str(quality.SCANNER_CONFIG)}:
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(checks.ROOT / name, self.root / name)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_static_tools_accept_clean_and_reject_invalid_content(self):
        for name, (path, good, bad) in PROBES.items():
            with self.subTest(tool=name):
                args = checks.command(self.root, name, [path])
                self.write(path, good)
                clean = subprocess.run(args, cwd=self.root, capture_output=True, text=True, check=False)
                self.assertEqual(clean.returncode, 0, clean.stdout + clean.stderr)
                self.write(path, bad)
                broken = subprocess.run(args, cwd=self.root, capture_output=True, text=True, check=False)
                self.assertNotEqual(broken.returncode, 0, f"{name} accepted the invalid fixture")

    def test_shell_syntax_checks_every_file(self):
        self.write("first.sh", "#!/bin/sh\nexit 0\n")
        self.write("second.sh", "#!/bin/sh\nif then\n")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            results = checks.check_one(self.root, "syntax", ["first.sh", "second.sh"], {"checks": {}})
        self.assertTrue(any(result["exitCode"] != 0 for result in results))

    def test_secret_scanner_rejects_a_synthetic_token_without_validation(self):
        self.write("README.md", "# Public fixture\n")
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(quality.secrets(self.root, ["README.md"]))
            token = "gh" + "p_" + hashlib.sha256(b"quality-gate-synthetic-fixture").hexdigest()[:36]
            self.write("README.md", "token=" + token + "\n")
            self.assertFalse(quality.secrets(self.root, ["README.md"]))
            self.write("README.md", "token=" + token + " # gitleaks:allow\n")
            self.write(".gitleaksignore", "*\n")
            self.assertFalse(quality.secrets(self.root, ["README.md"]))

    def test_commit_scan_finds_removed_tokens_and_checks_the_exact_historical_fixture(self):
        checks.git(self.root, "init", "--quiet", "-b", "main")
        checks.git(self.root, "config", "user.name", "Quality Fixture")
        checks.git(self.root, "config", "user.email", "quality@example.invalid")
        checks.git(self.root, "config", "core.hooksPath", "/dev/null")

        def commit():
            checks.git(self.root, "add", ".")
            checks.git(self.root, "commit", "--quiet", "-m", "Fixture")
            return checks.git(self.root, "rev-parse", "HEAD").stdout.decode().strip()

        base = commit()
        token = "gh" + "p_" + hashlib.sha256(b"quality-history-fixture").hexdigest()[:36]
        content = "token=" + token + "\n"
        self.write("fixture.txt", content)
        commit()
        (self.root / "fixture.txt").unlink()
        head = commit()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(quality.secret_range(self.root, base, head))
            self.assertEqual(checks.git(self.root, "diff", "--name-only", base, head).stdout, b"")
            with (
                patch.object(quality, "ROOT", self.root),
                patch.object(checks, "ROOT", self.root),
                patch.dict(os.environ, {"TRELLAGE_PUSH_REFS": f"refs/heads/main {head} refs/heads/main {base}"}),
            ):
                self.assertFalse(quality.check_push())
            self.write(
                str(quality.FIXTURES),
                json.dumps(
                    {
                        "fixture.txt": {
                            "sha256": hashlib.sha256(content.encode()).hexdigest(),
                            "reason": "Public synthetic fixture",
                        }
                    }
                ),
            )
            self.assertTrue(quality.secret_range(self.root, base, head))
            self.write(
                str(quality.FIXTURES),
                json.dumps(
                    {
                        "fixture.txt": {
                            "sha256": hashlib.sha256(b"different historical contents").hexdigest(),
                            "reason": "Different fixture",
                        }
                    }
                ),
            )
            self.assertFalse(quality.secret_range(self.root, base, head))

    def test_full_local_gate_cannot_hide_a_token_in_vendored_sources(self):
        checks.git(self.root, "init", "--quiet", "-b", "main")
        token = "gh" + "p_" + hashlib.sha256(b"quality-vendored-fixture").hexdigest()[:36]
        self.write("prototypes/software-factory/web-foldkit/repos/fixture.txt", "token=" + token + "\n")
        with (
            patch.object(quality, "ROOT", self.root),
            patch.object(checks, "ROOT", self.root),
            patch.object(quality, "files", side_effect=lambda *args, **kwargs: checks.files(self.root, **kwargs)),
            patch.object(quality, "check_files", return_value=True) as static,
            patch.object(quality, "analysis", return_value=True),
            patch.object(quality, "run_tests", return_value=True),
            patch("quality_prototypes.run_local", return_value=True),
            contextlib.redirect_stdout(io.StringIO()),
            contextlib.redirect_stderr(io.StringIO()),
        ):
            self.assertFalse(quality.check_plan(quality.plan([], complete=True)))
            static.assert_not_called()


if __name__ == "__main__":
    unittest.main()
