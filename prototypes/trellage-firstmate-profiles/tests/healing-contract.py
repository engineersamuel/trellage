#!/usr/bin/env python3
"""Offline preparation contracts using the real launcher, resolver, and installer."""

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tarfile
import time
import unittest
import uuid

FIXTURE, SOURCE, REPO, BIN, NATIVE, UPSTREAM = map(Path, sys.argv[1:7])
sys.argv = sys.argv[:1] + os.environ.get("FMX_HEALING_TEST", "").split()
OWNER = "trellage-firstmate-profiles-v1"
MARKER = ".managed-by-trellage-firstmate-profiles"
INSTALL_OWNER = "trellage-firstmate-install-lock-v1"
TOOL_OWNER = "trellage-firstmate-prerequisites-v1"
REVISION = "527aa7c12d25aadbdf3cc56791f87ae71fca5280"
TOOLS = ("no-mistakes", "treehouse", "gh-axi", "chrome-devtools-axi", "lavish-axi", "tasks-axi", "quota-axi")
BASE = FIXTURE / "healing-baseline"


def write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(mode)


def snapshot(root):
    result = {}
    if root.exists():
        for path in (root, *sorted(root.rglob("*"))):
            relative = str(path.relative_to(root))
            if path.is_symlink():
                value = ("link", os.readlink(path))
            elif path.is_file():
                value = ("file", path.stat().st_mode & 0o777, hashlib.sha256(path.read_bytes()).hexdigest())
            else:
                value = ("directory", path.stat().st_mode & 0o777)
            result[relative] = value
    return result


def environment(case):
    home = case / "home"
    values = {
        "HOME": str(home), "PATH": str(case / "bin"), "TMPDIR": str(case / "scratch"),
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH": "0",
        "GH_CONFIG_DIR": str(home / ".config/gh"), "FAKE_HEALING_CASE": str(case),
        "npm_config_userconfig": str(home / ".npmrc"),
        "npm_config_globalconfig": str(home / "global.npmrc"),
        "FAKE_GIT_SOURCE_TREE": str(UPSTREAM),
        "GH_TOKEN": "fixture-gh-token", "ANTHROPIC_API_KEY": "fixture-anthropic-token",
        "AWS_ACCESS_KEY_ID": "fixture-aws-key", "OPENAI_API_KEY": "fixture-openai-token",
    }
    for variable in ("FAKE_GIT_LOG", "FAKE_GH_LOG", "FAKE_TMUX_LOG", "FAKE_HERDR_LOG", "FAKE_CLAUDE_LOG",
                     "NATIVE_CLAUDE_LOG", "NATIVE_CLAUDE_LAUNCH_LOG"):
        values[variable] = str(case / (variable.lower() + ".log"))
    return values


def package(case):
    return case / "prototypes/trellage-firstmate-profiles"


def runtime(case):
    return case / "home/.local/share/trellage/fmx"


def profile(case):
    return case / "home/.local/share/trellage/profiles/firstmate/default"


def process(case, *args, env=None, data=None, helper=False, installed=False):
    root = runtime(case) if installed else package(case)
    values = environment(case)
    values.update(env or {})
    command = [str(root / ("lib/fmx-prerequisites" if helper else "bin/fmx")), *args]
    if helper:
        native = root / "lib/native-claude"
        if not native.exists():
            native = root.parent / "trellage-claude-common/native-claude"
        values.update(TRELLAGE_CLAUDE_LAUNCHER_NAME="fmx", TRELLAGE_CLAUDE_RUNTIME_ROOT=str(root))
        command = [str(native), "exec-clean", "--", *command]
    return subprocess.run(command, env=values, input=data, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=45, cwd=case, check=False)


def source_lock_identity(case):
    result = process(case, "identity", helper=True)
    if result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip()


def destination(case):
    return runtime(case) / "prerequisites" / source_lock_identity(case)


def clear_network_log(case):
    (case / "network.log").unlink(missing_ok=True)


def locked_archives(case):
    manifest_path = package(case) / "prerequisites/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for name in ("no-mistakes", "treehouse"):
        binary = manifest["binaries"][name]
        body = f'#!/usr/bin/env bash\nprintf "{name} {binary["version"]}\\n"\n'.encode()
        archive = case / "assets" / (name + ".tar.gz")
        archive.parent.mkdir(exist_ok=True)
        with tarfile.open(archive, "w:gz") as stream:
            member = tarfile.TarInfo(name)
            member.size, member.mode = len(body), 0o755
            stream.addfile(member, io.BytesIO(body))
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        for asset in binary["assets"].values():
            asset["sha256"] = digest
    write(manifest_path, json.dumps(manifest), 0o644)


PROVIDER = r'''#!/usr/bin/env python3
import json, os, pathlib, shutil, signal, subprocess, sys, time
root = pathlib.Path(os.environ["FAKE_HEALING_CASE"])
real_npm = REAL_NPM
name = pathlib.Path(sys.argv[0]).name
if any(key in os.environ for key in ("GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY",
                                     "ANTHROPIC_AUTH_TOKEN", "AWS_ACCESS_KEY_ID", "OPENAI_API_KEY")):
    raise SystemExit("provider credentials crossed the real exec-clean boundary")
if name == "npm" and sys.argv[1] in ("config", "prefix"):
    os.execv(real_npm, [real_npm, *sys.argv[1:]])
with (root / "network.log").open("a") as handle:
    handle.write(name + "|" + os.environ.get("TRELLAGE_CLAUDE_RUNTIME_ROOT", "") + "\n")
if name == "npm":
    assert sys.argv[1] == "ci", "only a locked local npm ci is allowed"
    assert "--ignore-scripts" in sys.argv and "--no-audit" in sys.argv
    prefix = pathlib.Path(sys.argv[sys.argv.index("--prefix") + 1])
    assert prefix.is_relative_to(root / "home/.local/share/trellage/fmx/prerequisites")
    (root / "install-started").write_text(str(os.getpid()))
    while (root / "hold-npm").exists():
        time.sleep(0.03)
    snapshot = sys.stdin.buffer.read()
    loaded = subprocess.run([real_npm, "config", "list", "--json", *sys.argv[2:]],
                            input=snapshot, capture_output=True, check=True)
    effective = json.loads(loaded.stdout)
    (root / "npm-effective.json").write_text(json.dumps({
        "registry": effective["registry"],
        "scopes": {key: value for key, value in effective.items() if key.endswith(":registry")},
        "cache": effective["cache"],
        "projectAuth": b"fixture-project-token" in snapshot,
        "userAuth": b"fixture-user-token" in snapshot,
        "globalAuth": b"fixture-global-token" in snapshot,
        "overriddenAuth": b"fixture-overridden-token" in snapshot,
    }))
    lock = json.loads((prefix / "package-lock.json").read_text())
    for package, metadata in lock["packages"].items():
        for command, target in metadata.get("bin", {}).items():
            path = prefix / package / target
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('#!/usr/bin/env bash\nprintf "%s %s\\n"\n' % (command, metadata["version"]))
            path.chmod(0o755)
            link = prefix / "node_modules/.bin" / command
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(os.path.relpath(path, link.parent))
elif name == "curl":
    url = next(arg for arg in sys.argv if arg.startswith("https://"))
    target = pathlib.Path(sys.argv[sys.argv.index("-o") + 1])
    assert target.is_relative_to(root / "home/.local/share/trellage/fmx/prerequisites")
    assert url.startswith("https://github.com/kunchenguid/")
    tool = "no-mistakes" if "/no-mistakes/" in url else "treehouse"
    shutil.copyfile(root / "assets" / (tool + ".tar.gz"), target)
else:
    raise SystemExit("unexpected provider")
'''


def create_baseline():
    BASE.mkdir(mode=0o700)
    source = package(BASE)
    source.mkdir(parents=True)
    for name in ("bin", "lib", "overlay", "instance-overlay", "policies", "prerequisites"):
        shutil.copytree(SOURCE / name, source / name)
    shutil.copyfile(SOURCE / "catalog.json", source / "catalog.json")
    common = source.parent / "trellage-claude-common"
    common.mkdir()
    shutil.copyfile(NATIVE, common / "native-claude")
    (common / "native-claude").chmod(0o755)
    shutil.copyfile(REPO / "scripts/trellage-session-bridge.py", source / "lib/trellage-session-bridge.py")
    shutil.copytree(BIN, BASE / "bin", symlinks=True)
    for tool in TOOLS:
        (BASE / "bin" / tool).unlink(missing_ok=True)
    for name in ("npm", "curl"):
        (BASE / "bin" / name).unlink(missing_ok=True)
        write(BASE / "bin" / name, PROVIDER.replace("REAL_NPM", repr(shutil.which("npm"))), 0o755)
    if not (BASE / "bin/ps").exists():
        (BASE / "bin/ps").symlink_to(shutil.which("ps"))
    (BASE / "scratch").mkdir(mode=0o700)
    locked_archives(BASE)
    installed = runtime(BASE)
    installed.parent.mkdir(parents=True)
    shutil.copytree(source, installed)
    (installed / "prerequisites").rename(installed / "prerequisite-lock")
    shutil.copyfile(common / "native-claude", installed / "lib/native-claude")
    (installed / "lib/native-claude").chmod(0o755)
    write(installed / MARKER, OWNER + "\n")
    write(BASE / "home/.config/gh/hosts.yml", "github.com:\n    user: fixture\n    oauth_token: fixture\n")
    write(BASE / "package.json", '{"name":"fixture-project","version":"1.0.0"}')
    write(BASE / ".npmrc", "registry=https://packagefeedproxy.microsoft.io/npm/\n")
    write(BASE / "home/.npmrc", "registry=https://user-feed.example/npm/\n")
    write(BASE / "home/global.npmrc", "")
    cache = BASE / "home/.local/share/trellage/common/skills"
    write(cache / "managed-skills.txt", "fixture-skill\n")
    write(cache / "always-on.md", "Fixture instructions.\n")
    write(cache / "skills/fixture-skill/SKILL.md", "---\nname: fixture-skill\ndescription: Fixture\n---\n")
    for key, path in environment(BASE).items():
        if key.endswith("_LOG"):
            Path(path).write_text("")
    result = process(BASE, "setup", "default")
    if result.returncode:
        raise AssertionError("fixture setup failed: " + result.stderr)
    values = environment(BASE)
    command = [str(common / "native-claude"), "exec-clean", "--",
               str(source / "lib/fmx-prerequisites"), "install"]
    values.update(TRELLAGE_CLAUDE_LAUNCHER_NAME="fmx", TRELLAGE_CLAUDE_RUNTIME_ROOT=str(source))
    result = subprocess.run(command, env=values, stdin=subprocess.DEVNULL, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, cwd=BASE, check=False)
    if result.returncode:
        raise AssertionError("real fixture installer failed: " + result.stderr)
    clear_network_log(BASE)
    for path in BASE.glob("*.log"):
        path.write_text("")
    (BASE / "install-started").unlink(missing_ok=True)


class HealingContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        create_baseline()

    def setUp(self):
        self.case = FIXTURE / ("healing-" + uuid.uuid4().hex)
        shutil.copytree(BASE, self.case, symlinks=True)
        self.root = profile(self.case)
        record_path = self.root / "receipts/instance.json"
        record = json.loads(record_path.read_text())
        record["home"] = str(self.root / "home")
        write(record_path, json.dumps(record))
        self.artifact_identity = source_lock_identity(self.case)
        result = process(self.case, "plan", helper=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.identity = json.loads(result.stdout)["identity"]

    def tearDown(self):
        shutil.rmtree(self.case)

    def prepare(self, approved=None, revision=REVISION, env=None, data=None):
        args = ["prepare", "default", "--json", "--expected-source-revision", revision]
        if approved is not None:
            args += ["--install-prerequisites", approved]
        return process(self.case, *args, env=env, data=data)

    def response(self, result, state):
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        preparation = value["fleet"]["preparation"]
        self.assertEqual(preparation["state"], state, preparation)
        if state != "ready":
            self.assertTrue(preparation["diagnostic"])
        for row in value["fleet"]["prerequisites"]:
            self.assertEqual(row["ready"], row["status"] == "ready", row)
        return value

    def no_network(self):
        self.assertFalse((self.case / "network.log").exists(), "unexpected fixture install/download")
        self.assertFalse((self.case / "native_claude_launch_log.log").read_text(), "prepare started a supervisor")

    def unchanged(self, before, root):
        after = snapshot(root)
        changed = [name for name in sorted(set(before) | set(after)) if before.get(name) != after.get(name)]
        self.assertEqual(changed, [], "unexpected writes under " + str(root))

    def remove_cache(self):
        shutil.rmtree(destination(self.case))

    def current_plan(self):
        result = process(self.case, "plan", helper=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def shared_maintenance_artifacts(self, interrupted=False, missing_runtime=False):
        installed = runtime(self.case)
        commands = self.case / "home/.local/bin"
        commands.mkdir(parents=True, exist_ok=True)
        (commands / "fmx").symlink_to(installed / "bin/fmx")
        retired = installed.parent / ".fmx-retired-install.fixture"
        write(retired / "retained", "existing retired install\n")
        write(commands / ".fmx-command.fixture/retained", "existing command stage\n")
        if interrupted:
            transaction = installed.parent / ".fmx-install.fixture"
            for name, value in (
                (".managed-by-trellage-firstmate-install-transaction", INSTALL_OWNER),
                ("had-runtime", "yes"), ("had-command", "yes"), ("runtime-retired", "yes"),
            ):
                write(transaction / name, value + "\n")
            shutil.copytree(installed, transaction / "old-runtime", symlinks=True)
            write(transaction / "old-runtime/policies/admission-retired.md", "prior runtime\n")
        if missing_runtime:
            installed.rename(retired / "runtime")

    def shared_maintenance_snapshot(self):
        lock = ".local/share/trellage/.fmx-install.lock"
        return {name: value for name, value in snapshot(self.case / "home").items()
                if name != lock and not name.startswith(lock + "/")}

    def refuse_shared_maintenance_after_lock(self, operation, blocker):
        lock = runtime(self.case).parent / ".fmx-install.lock"
        self.hold_lock_creation(lock)
        child = subprocess.Popen(
            [str(self.case / "bin/bash"), str(SOURCE / (operation + ".sh"))],
            env=environment(self.case), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, cwd=self.case, start_new_session=True,
        )
        try:
            self.wait_file(self.case / "lock-ready", child)
            if blocker == "active-session":
                write(self.root / "locks/session/owner", OWNER + "\n")
                write(self.root / "locks/session/pid", str(os.getpid()) + "\n")
            elif blocker == "ambiguous-mutation":
                write(self.root / "locks/mutation", "existing non-directory mutation record\n")
            elif blocker == "active-worker":
                write(self.root / "workers/admission" / MARKER, OWNER + "\n")
                write(self.root / "workers/admission/.active", str(os.getpid()) + "\n")
            else:
                self.assertEqual(blocker, "incomplete-session")
                write(self.root / "locks/session/owner", OWNER + "\n")
            before = self.shared_maintenance_snapshot()
            write(self.case / "lock-release", "release\n")
            output, error = child.communicate(timeout=30)
        finally:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate(timeout=10)
        self.assertEqual(child.returncode, 1, error)
        self.assertIn("cannot " + operation + " fmx while a Firstmate fleet or profile mutation is active or indeterminate", error)
        self.assertEqual(output, "")
        self.assertEqual(before, self.shared_maintenance_snapshot(), "refusal changed pre-existing state")
        self.assertFalse(lock.exists())
        self.no_network()

    def test_installer_admission_preserves_existing_state(self):
        self.shared_maintenance_artifacts(interrupted=True)
        self.refuse_shared_maintenance_after_lock("install", "active-session")

    def test_installer_admission_preserves_missing_runtime_state(self):
        self.shared_maintenance_artifacts(interrupted=True, missing_runtime=True)
        self.refuse_shared_maintenance_after_lock("install", "ambiguous-mutation")

    def test_uninstaller_admission_preserves_existing_state(self):
        self.shared_maintenance_artifacts()
        self.refuse_shared_maintenance_after_lock("uninstall", "active-worker")

    def test_uninstaller_admission_preserves_missing_runtime_state(self):
        self.shared_maintenance_artifacts(missing_runtime=True)
        self.refuse_shared_maintenance_after_lock("uninstall", "incomplete-session")

    def test_idle_installer_still_recovers_existing_state(self):
        self.shared_maintenance_artifacts(interrupted=True)
        before = snapshot(self.root)
        values = environment(self.case)
        values["FMX_INSTALL_TEST_FAIL_AT"] = "after-recovery"
        result = subprocess.run(
            [str(self.case / "bin/bash"), str(SOURCE / "install.sh")], env=values,
            stdin=subprocess.DEVNULL, capture_output=True, text=True, cwd=self.case, timeout=30, check=False,
        )
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("injected failure at after-recovery", result.stderr)
        self.assertEqual((runtime(self.case) / "policies/admission-retired.md").read_text(), "prior runtime\n")
        self.assertTrue((self.case / "home/.local/bin/fmx").is_symlink())
        self.assertFalse((runtime(self.case).parent / ".fmx-install.fixture").exists())
        self.assertFalse((runtime(self.case).parent / ".fmx-retired-install.fixture").exists())
        self.assertFalse((self.case / "home/.local/bin/.fmx-command.fixture").exists())
        self.assertFalse((runtime(self.case).parent / ".fmx-install.lock").exists())
        self.unchanged(before, self.root)
        self.no_network()

    def test_idle_uninstaller_still_removes_only_managed_artifacts(self):
        self.shared_maintenance_artifacts()
        before = snapshot(self.root)
        result = subprocess.run(
            [str(self.case / "bin/bash"), str(SOURCE / "uninstall.sh")], env=environment(self.case),
            stdin=subprocess.DEVNULL, capture_output=True, text=True, cwd=self.case, timeout=30, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(runtime(self.case).exists())
        self.assertFalse((self.case / "home/.local/bin/fmx").is_symlink())
        self.assertFalse((runtime(self.case).parent / ".fmx-retired-install.fixture").exists())
        self.assertFalse((self.case / "home/.local/bin/.fmx-command.fixture").exists())
        self.assertFalse((runtime(self.case).parent / ".fmx-install.lock").exists())
        self.unchanged(before, self.root)
        self.no_network()

    def test_source_reuses_verified_owned_cache_without_writes(self):
        before = snapshot(package(self.case))
        installed = process(self.case, "path", helper=True, installed=True)
        source = process(self.case, "path", helper=True)
        self.assertEqual(source.returncode, 0, source.stderr)
        self.assertEqual(source.stdout, installed.stdout)
        self.assertTrue(source.stdout.startswith(str(destination(self.case)) + "/bin:"))
        inventory = process(self.case, "inventory", "default", "--json")
        value = json.loads(inventory.stdout)
        self.assertEqual(value["readiness"], "healthy", value)
        self.assertNotIn("preparation", value["fleet"])
        self.assertTrue(all(set(row) == {"id", "ready", "description"} for row in value["fleet"]["prerequisites"]))
        self.assertEqual(process(self.case, "doctor", "default").returncode, 0)
        self.assertEqual(before, snapshot(package(self.case)))
        self.no_network()

    def test_automatic_prepare_is_idempotent(self):
        before = snapshot(self.root)
        for _ in range(2):
            value = self.response(self.prepare(), "ready")
            self.assertEqual(value["fleet"]["preparation"]["repairs"], [])
            self.assertIsNone(value["fleet"]["preparation"]["installation"])
        self.unchanged(before, self.root)
        self.no_network()

    def test_wire_text_bounds_preserve_helper_failure_details(self):
        control = package(self.case) / "lib/fmx-control.py"
        details = "Helper check failed:\nmissing gh-axi\t" + "🧭" * 4000
        result = subprocess.run(
            [str(self.case / "bin/python3"), str(control), "tool-report", "false", details, "gh-axi", ""],
            env=environment(self.case), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertTrue(report["description"].startswith("Helper check failed: missing gh-axi "))
        self.assertNotIn("\n", report["description"])
        self.assertNotIn("\t", report["description"])
        self.assertLessEqual(len(report["description"].encode("utf-16-le")) // 2, 2000)
        sys.path.insert(0, str(control.parent))
        try:
            spec = importlib.util.spec_from_file_location("healing_control", control)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            message = module.diagnostic(details)
            self.assertTrue(message.startswith("Helper check failed:\nmissing gh-axi\t"))
            self.assertLessEqual(len(message.encode("utf-16-le")) // 2, 4000)
            self.assertLessEqual(len(module.wire_limit("🧭" * 300, 511).encode("utf-16-le")) // 2, 511)
        finally:
            sys.path.pop(0)
        self.no_network()

    def test_verified_retired_cache_is_restored_without_install_consent(self):
        cache = destination(self.case)
        before = snapshot(cache)
        retired = cache.with_name(".retired." + self.artifact_identity + ".fixture")
        cache.rename(retired)
        value = self.response(self.prepare(), "ready")
        self.assertTrue(value["fleet"]["preparation"]["repairs"])
        self.assertEqual(before, snapshot(cache))
        self.assertFalse(retired.exists())
        self.assertFalse((runtime(self.case) / "prerequisites/.install-lock").exists())
        self.no_network()

    def test_differing_source_lock_cannot_reuse_installed_requirements(self):
        lock = package(self.case) / "prerequisites/npm/package-lock.json"
        lock.write_text(lock.read_text() + "\n")
        self.assertEqual(process(self.case, "path", helper=True).returncode, 3)
        self.assertEqual(process(self.case, "path", helper=True, installed=True).returncode, 0)
        value = self.response(self.prepare(), "needs-consent")
        plan = value["fleet"]["preparation"]["installation"]
        self.assertNotEqual(plan["identity"], self.identity)
        self.assertNotEqual(plan["identity"], source_lock_identity(self.case))
        self.assertEqual(Path(plan["destination"]).name, source_lock_identity(self.case))
        self.assertTrue(Path(plan["destination"]).is_relative_to(runtime(self.case) / "prerequisites"))
        self.no_network()

    def test_missing_cache_has_exact_plan_and_stdin_is_not_consent(self):
        self.remove_cache()
        before = snapshot(self.root)
        value = self.response(self.prepare(data="yes\n"), "needs-consent")
        plan = value["fleet"]["preparation"]["installation"]
        lock = json.loads((package(self.case) / "prerequisites/manifest.json").read_text())
        expected = dict(lock["npm"]["tools"])
        expected.update({name: binary["version"] for name, binary in lock["binaries"].items()})
        self.assertEqual({entry["name"]: entry["version"] for entry in plan["tools"]}, expected)
        self.assertEqual(plan["identity"], self.identity)
        self.assertEqual(plan["destination"], str(destination(self.case)))
        self.assertEqual(plan["statePaths"], [str(self.case / "home/.no-mistakes"), str(self.case / "home/.npm")])
        self.assertIn("https://packagefeedproxy.microsoft.io/npm/", plan["sources"][0])
        self.assertTrue(all("Checksum-verified release:" in entry and "SHA-256" in entry for entry in plan["sources"][1:]))
        self.response(self.prepare(), "needs-consent")
        self.assertEqual(before, snapshot(self.root))
        self.assertFalse(destination(self.case).exists())
        self.no_network()

    def test_stale_source_and_plan_fail_before_mutation_or_network(self):
        self.remove_cache()
        before = snapshot(self.root)
        for revision, approved in (("a" * 40, self.identity), (REVISION, "b" * 64)):
            result = self.prepare(approved, revision)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertIn("changed", result.stderr)
        self.assertEqual(before, snapshot(self.root))
        self.no_network()

    def test_approved_install_uses_source_helper_and_real_clean_boundary(self):
        self.remove_cache()
        before = snapshot(package(self.case))
        identity = (self.root / "receipts/instance.json").read_bytes()
        value = self.response(self.prepare(self.identity), "ready")
        self.assertTrue(value["fleet"]["preparation"]["repairs"])
        self.assertEqual(process(self.case, "verify", helper=True).returncode, 0)
        calls = (self.case / "network.log").read_text().splitlines()
        self.assertEqual([line.split("|")[0] for line in calls], ["npm", "curl", "curl"])
        self.assertTrue(all(line.endswith("|" + str(package(self.case))) for line in calls))
        self.assertEqual(before, snapshot(package(self.case)))
        self.assertEqual(identity, (self.root / "receipts/instance.json").read_bytes())
        self.assertFalse((self.case / "home/.no-mistakes").exists())
        self.assertFalse((self.root / "locks/mutation").exists())
        self.assertFalse((runtime(self.case).parent / ".fmx-install.lock").exists())
        self.assertFalse((self.case / "native_claude_launch_log.log").read_text())

    def test_plan_binds_registry_scope_and_destination_without_changing_artifact_cache(self):
        before = snapshot(destination(self.case))
        original = self.current_plan()
        self.assertNotEqual(original["identity"], self.artifact_identity)
        write(self.case / ".npmrc", "registry=https://project-feed.example/npm/\n")
        project = self.current_plan()
        self.assertNotEqual(project["identity"], original["identity"])
        write(self.case / ".npmrc", "registry=https://project-feed.example/npm/\n@hono:registry=https://scope-feed.example/\n")
        scoped = self.current_plan()
        self.assertNotEqual(scoped["identity"], project["identity"])
        self.assertTrue(any("@hono" in source and "https://scope-feed.example/" in source for source in scoped["sources"]))
        other = self.case / "other-home"
        shutil.copytree(self.case / "home", other, symlinks=True)
        result = process(self.case, "plan", helper=True, env={
            "HOME": str(other), "npm_config_userconfig": str(other / ".npmrc"),
            "npm_config_globalconfig": str(other / "global.npmrc"),
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        moved = json.loads(result.stdout)
        self.assertNotEqual(moved["identity"], scoped["identity"])
        self.assertNotEqual(moved["destination"], scoped["destination"])
        self.assertEqual(source_lock_identity(self.case), self.artifact_identity)
        self.assertEqual(process(self.case, "path", helper=True).returncode, 0)
        self.unchanged(before, destination(self.case))
        self.no_network()

    def test_project_and_scoped_npm_policy_is_used_by_the_real_install_config_loader(self):
        write(self.case / "home/global.npmrc",
              "registry=https://global-feed.example/\n//global-feed.example/:_authToken=fixture-global-token\n")
        write(self.case / "home/.npmrc",
              "registry=https://user-feed.example/npm/\n@hono:registry=https://user-scope.example/\n"
              "//user-feed.example/npm/:_authToken=fixture-user-token\n"
              "//project-feed.example/npm/:_authToken=fixture-overridden-token\n")
        write(self.case / ".npmrc",
              "registry=https://project-feed.example/npm/\n@hono:registry=https://project-scope.example/\n"
              "//project-feed.example/npm/:_authToken=fixture-project-token\n")
        plan = self.current_plan()
        self.assertIn("Configured host npm registry: https://project-feed.example/npm/", plan["sources"])
        self.assertTrue(any("@hono" in source and "https://project-scope.example/" in source for source in plan["sources"]))
        self.assertFalse(any("user-feed.example" in source or "user-scope.example" in source for source in plan["sources"]))
        files = {path: path.read_bytes() for path in (self.case / ".npmrc", self.case / "home/.npmrc", self.case / "home/global.npmrc")}
        self.remove_cache()
        value = self.response(self.prepare(plan["identity"]), "ready")
        effective = json.loads((self.case / "npm-effective.json").read_text())
        self.assertEqual(effective["registry"], "https://project-feed.example/npm/")
        self.assertEqual(effective["scopes"]["@hono:registry"], "https://project-scope.example/")
        self.assertTrue(effective["projectAuth"] and effective["userAuth"] and effective["globalAuth"])
        self.assertFalse(effective["overriddenAuth"])
        self.assertIn(effective["cache"], plan["statePaths"])
        self.assertNotIn("fixture-project-token", json.dumps(plan) + json.dumps(value))
        self.assertFalse(list(destination(self.case).rglob(".npmrc")))
        self.assertEqual(files, {path: path.read_bytes() for path in files})

    def test_changed_registry_approval_is_rejected_before_any_profile_mutation(self):
        approved = self.current_plan()["identity"]
        self.remove_cache()
        (self.root / "home/config/crew-harness").unlink()
        before = snapshot(self.root)
        write(self.case / ".npmrc", "registry=https://new-feed.example/npm/\n")
        result = self.prepare(approved)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("plan changed", result.stderr)
        self.unchanged(before, self.root)
        self.no_network()

    def test_raw_artifact_identity_is_not_installation_approval(self):
        self.remove_cache()
        before = snapshot(self.root)
        result = self.prepare(self.artifact_identity)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("plan changed", result.stderr)
        self.unchanged(before, self.root)
        self.no_network()

    def changed_registry_under_installer_lock(self, lock):
        approved = self.current_plan()["identity"]
        self.remove_cache()
        before = snapshot(self.root)
        cache = runtime(self.case) / "prerequisites"
        write(cache / (".stage." + self.artifact_identity + ".old") / "sentinel", "existing stage\n")
        retired = cache / (".retired." + "c" * 64 + ".old")
        write(retired / ".managed-by-trellage-firstmate-prerequisites", "trellage-firstmate-prerequisites-v1\n")
        write(retired / ".complete", "c" * 64 + "\n")
        write(retired / "receipt.json", json.dumps({"schemaVersion": 1, "identity": "c" * 64}))
        cache_before = snapshot(cache)
        self.hold_lock_creation(lock)
        child = self.start_preparation(approved)
        self.wait_file(self.case / "lock-ready", child)
        write(self.case / ".npmrc", "registry=https://packagefeedproxy.microsoft.io/npm/\n@hono:registry=https://new-scope.example/\n")
        write(self.case / "lock-release", "release")
        output, error = child.communicate(timeout=35)
        self.assertEqual(child.returncode, 0, error)
        value = json.loads(output)
        self.assertEqual(value["fleet"]["preparation"]["state"], "blocked")
        self.assertIn("plan changed", value["fleet"]["preparation"]["diagnostic"])
        self.unchanged(before, self.root)
        self.unchanged(cache_before, cache)
        self.assertFalse(destination(self.case).exists())
        self.no_network()

    def test_scoped_registry_is_rechecked_under_runtime_lock(self):
        self.changed_registry_under_installer_lock(runtime(self.case).parent / ".fmx-install.lock")

    def test_scoped_registry_is_rechecked_under_cache_install_lock(self):
        self.changed_registry_under_installer_lock(runtime(self.case) / "prerequisites/.install-lock")

    def test_npm_ci_uses_the_frozen_approved_configuration(self):
        write(self.case / ".npmrc", "registry=https://approved-feed.example/npm/\n@hono:registry=https://approved-scope.example/\n")
        approved = self.current_plan()["identity"]
        self.remove_cache()
        write(self.case / "hold-npm", "hold")
        child = self.start_preparation(approved)
        self.wait_file(self.case / "install-started", child)
        write(self.case / ".npmrc", "registry=https://changed-feed.example/npm/\n@hono:registry=https://changed-scope.example/\n")
        (self.case / "hold-npm").unlink()
        output, error = child.communicate(timeout=35)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(json.loads(output)["fleet"]["preparation"]["state"], "blocked")
        effective = json.loads((self.case / "npm-effective.json").read_text())
        self.assertEqual(effective["registry"], "https://approved-feed.example/npm/")
        self.assertEqual(effective["scopes"]["@hono:registry"], "https://approved-scope.example/")
        self.assertFalse(destination(self.case).exists())
        self.assertFalse(list((runtime(self.case) / "prerequisites").glob(".stage.*")))

    def test_secret_bearing_registry_is_refused_without_disclosure_or_installation(self):
        self.remove_cache()
        before = snapshot(self.root)
        for key in ("registry", "@hono:registry", "https-proxy"):
            with self.subTest(setting=key):
                write(self.case / ".npmrc", "registry=https://safe-feed.example/npm/\n"
                      + key + "=https://fixture-user:fixture-password@feed.example/npm/\n")
                value = self.response(self.prepare(), "blocked")
                diagnostic = value["fleet"]["preparation"]["diagnostic"]
                self.assertIn("cannot be safely reviewed", diagnostic)
                self.assertNotIn("fixture-password", json.dumps(value))
                self.unchanged(before, self.root)
        self.no_network()

    def test_unrepresentable_npm_configuration_and_lock_sources_fail_closed(self):
        self.remove_cache()
        before = snapshot(self.root)
        write(self.case / ".npmrc", "[policy]\nregistry=https://section-feed.example/npm/\n")
        value = self.response(self.prepare(), "blocked")
        self.assertIn("cannot safely snapshot this npmrc syntax", value["fleet"]["preparation"]["diagnostic"])
        write(self.case / ".npmrc", "registry=https://packagefeedproxy.microsoft.io/npm/\n")
        lock_path = package(self.case) / "prerequisites/npm/package-lock.json"
        lock = json.loads(lock_path.read_text())
        lock["packages"]["node_modules/gh-axi"]["resolved"] = "https://fixed-feed.example/package.tgz"
        write(lock_path, json.dumps(lock), 0o644)
        value = self.response(self.prepare(), "blocked")
        self.assertIn("fixed URL", value["fleet"]["preparation"]["diagnostic"])
        del lock["packages"]["node_modules/gh-axi"]["resolved"]
        lock["packages"]["node_modules/gh-axi"].setdefault("dependencies", {})["unreviewed"] = "example/repository#branch"
        write(lock_path, json.dumps(lock), 0o644)
        value = self.response(self.prepare(), "blocked")
        self.assertIn("non-registry npm dependencies", value["fleet"]["preparation"]["diagnostic"])
        self.unchanged(before, self.root)
        self.no_network()

    def test_doctor_fails_precisely_when_tools_are_missing(self):
        self.remove_cache()
        result = process(self.case, "doctor", "default")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("doctor default: OK", result.stdout)
        self.assertIn("fleet prerequisites incomplete", result.stderr)
        for tool in TOOLS:
            self.assertIn(tool, result.stderr)
        inventory = json.loads(process(self.case, "inventory", "default", "--json").stdout)
        row = next(row for row in inventory["fleet"]["prerequisites"] if row["id"] == "fleet-tools")
        self.assertFalse(row["ready"])
        self.assertIn("no-mistakes", row["description"])
        self.no_network()

    def test_resolver_errors_are_not_reported_as_all_tools_missing(self):
        write(destination(self.case) / "npm/node_modules/.bin/node", "collision", 0o755)
        before = snapshot(self.root)
        result = process(self.case, "doctor", "default")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unexpected command in managed PATH", result.stderr)
        value = self.response(self.prepare(), "blocked")
        self.assertIn("unexpected command", value["fleet"]["preparation"]["diagnostic"])
        inventory = json.loads(process(self.case, "inventory", "default", "--json").stdout)
        row = next(row for row in inventory["fleet"]["prerequisites"] if row["id"] == "fleet-tools")
        self.assertIn("resolver failed", row["description"])
        self.assertEqual(before, snapshot(self.root))
        self.no_network()

    def test_unsafe_cache_roots_and_links_are_refused(self):
        cache = destination(self.case)
        paths = (runtime(self.case) / "prerequisites", cache / "npm/node_modules",
                 cache / "npm/node_modules/.bin", cache / "bin")
        before = snapshot(self.root)
        for path in paths:
            saved = path.with_name(path.name + ".saved")
            path.rename(saved)
            path.symlink_to(saved, target_is_directory=True)
            with self.subTest(path=path):
                self.assertNotEqual(process(self.case, "path", helper=True).returncode, 0)
                self.response(self.prepare(), "blocked")
            path.unlink()
            saved.rename(path)
        command = cache / "npm/node_modules/.bin/gh-axi"
        target = os.readlink(command)
        command.unlink()
        command.symlink_to(self.case / "bin/gh")
        self.response(self.prepare(), "blocked")
        command.unlink()
        command.symlink_to(target)
        self.assertEqual(before, snapshot(self.root))
        self.no_network()

    def test_unowned_or_missing_runtime_is_not_claimed(self):
        before = snapshot(package(self.case))
        marker = runtime(self.case) / MARKER
        marker.write_text("foreign\n")
        self.response(self.prepare(), "blocked")
        self.assertEqual(marker.read_text(), "foreign\n")
        installed = runtime(self.case)
        saved = installed.with_name("saved-fmx")
        installed.rename(saved)
        self.assertEqual(process(self.case, "path", helper=True).returncode, 3)
        self.response(self.prepare(), "blocked")
        self.assertFalse(installed.exists())
        self.assertEqual(before, snapshot(package(self.case)))
        self.no_network()

    def test_owned_runtime_and_setup_drift_are_repaired_once(self):
        before_source = snapshot(package(self.case))
        identity = (self.root / "receipts/instance.json").read_bytes()
        write(self.root / "runtime/bin/fm-brief.sh",
              (self.root / "runtime/bin/fm-brief.sh").read_text() + "\n# drift\n", 0o755)
        (self.root / "home/config/crew-harness").unlink()
        value = self.response(self.prepare(), "ready")
        self.assertTrue(value["fleet"]["preparation"]["repairs"])
        self.assertEqual(identity, (self.root / "receipts/instance.json").read_bytes())
        self.assertEqual(before_source, snapshot(package(self.case)))
        after = snapshot(self.root)
        fetches = (self.case / "fake_git_log.log").read_text().count("fetch")
        self.response(self.prepare(), "ready")
        self.assertEqual(after, snapshot(self.root))
        self.assertEqual(fetches, (self.case / "fake_git_log.log").read_text().count("fetch"))
        self.no_network()

    def test_missing_identity_migrates_without_creating_consent(self):
        record = self.root / "receipts/instance.json"
        record.unlink()
        value = self.response(self.prepare(), "blocked")
        self.assertIsNotNone(value["fleet"]["identity"])
        self.assertTrue(value["fleet"]["consentRequired"])
        migrated = json.loads(record.read_text())
        self.assertFalse(migrated["prerequisitesConsent"])
        self.assertTrue(value["fleet"]["preparation"]["repairs"])
        before = snapshot(self.root)
        self.response(self.prepare(), "blocked")
        self.assertEqual(before, snapshot(self.root))
        explicit = process(self.case, "repair", "default")
        self.assertEqual(explicit.returncode, 0, explicit.stderr)
        repaired = json.loads(record.read_text())
        self.assertEqual(repaired["instanceId"], migrated["instanceId"])
        self.assertTrue(repaired["prerequisitesConsent"])
        self.no_network()

    def test_existing_declined_setup_consent_is_preserved(self):
        record = self.root / "receipts/instance.json"
        value = json.loads(record.read_text())
        value["prerequisitesConsent"] = False
        write(record, json.dumps(value))
        (self.root / "home/config/crew-harness").unlink()
        self.response(self.prepare(), "blocked")
        self.assertEqual(json.loads(record.read_text()), value)
        self.no_network()

    def test_missing_setup_directories_keep_the_existing_identity(self):
        record = (self.root / "receipts/instance.json").read_bytes()
        shutil.rmtree(self.root / "home/state")
        self.response(self.prepare(), "ready")
        self.assertEqual(record, (self.root / "receipts/instance.json").read_bytes())
        self.assertTrue((self.root / "home/state").is_dir())
        self.no_network()

    def test_missing_captain_home_is_repaired_from_existing_state(self):
        shutil.rmtree(self.root / "captain/claude")
        value = self.response(self.prepare(), "ready")
        self.assertTrue(value["fleet"]["preparation"]["repairs"])
        self.assertTrue((self.root / "captain/claude").is_dir())
        after = snapshot(self.root)
        self.response(self.prepare(), "ready")
        self.unchanged(after, self.root)
        self.no_network()

    def test_missing_skill_cache_never_downloads_an_unapproved_cli(self):
        shutil.rmtree(self.case / "home/.local/share/trellage/common/skills")
        before = snapshot(self.root)
        value = self.response(self.prepare(env={"NATIVE_CLAUDE_SKILLS_STATUS": "1"}), "blocked")
        self.assertIn("no skill tools were downloaded", value["fleet"]["preparation"]["diagnostic"])
        self.unchanged(before, self.root)
        self.assertNotIn("prepare|", (self.case / "native_claude_log.log").read_text())
        self.no_network()

    def test_stale_supervisor_is_preserved_and_not_recovered(self):
        lock = self.root / "locks/session"
        for name, value in (("owner", OWNER), ("backend", "tmux"), ("pid", "2147483647")):
            write(lock / name, value + "\n")
        write(self.root / "home/state/.lock", "2147483647\n")
        (self.root / "home/config/crew-harness").unlink()
        before_lock = snapshot(lock)
        value = self.response(self.prepare(), "ready")
        self.assertEqual(value["fleet"]["supervisor"]["state"], "stale")
        self.assertTrue(value["fleet"]["actions"]["recover"]["allowed"])
        self.unchanged(before_lock, lock)
        self.assertEqual((self.root / "home/state/.lock").read_text(), "2147483647\n")
        self.no_network()

    def test_active_fleet_is_inspection_only_and_keeps_send_allowed(self):
        lock = self.root / "locks/session"
        for name, value in (("owner", OWNER), ("backend", "tmux"), ("pid", str(os.getpid()))):
            write(lock / name, value + "\n")
        before = snapshot(self.root)
        value = self.response(self.prepare(), "ready")
        self.assertTrue(value["fleet"]["actions"]["submit"]["allowed"])
        self.assertEqual(value["fleet"]["preparation"]["repairs"], [])
        self.response(self.prepare(self.identity), "blocked")
        self.assertEqual(before, snapshot(self.root))
        self.no_network()

    def test_other_active_fleet_blocks_shared_install(self):
        self.remove_cache()
        other = self.root.with_name("pstack-workers")
        write(other / MARKER, OWNER + "\n")
        for name, value in (("owner", OWNER), ("backend", "tmux"), ("pid", str(os.getpid()))):
            write(other / "locks/session" / name, value + "\n")
        before = snapshot(other)
        result = self.response(self.prepare(self.identity), "blocked")
        self.assertIn("fleet or profile mutation is active", result["fleet"]["preparation"]["diagnostic"])
        self.assertEqual(before, snapshot(other))
        self.assertFalse(destination(self.case).exists())
        self.no_network()

    def test_unsafe_profile_worker_and_lock_are_preserved(self):
        (self.root / MARKER).write_text("foreign\n")
        before = snapshot(self.root)
        self.response(self.prepare(), "blocked")
        self.assertEqual(before, snapshot(self.root))
        write(self.root / MARKER, OWNER + "\n")
        (self.root / "workers/redirected").symlink_to(self.case, target_is_directory=True)
        self.response(self.prepare(), "blocked")
        (self.root / "workers/redirected").unlink()
        write(self.root / "locks/mutation/owner", "foreign\n")
        before = snapshot(self.root)
        self.response(self.prepare(), "blocked")
        self.assertEqual(before, snapshot(self.root))
        self.no_network()

    def test_symlinked_or_absent_profile_is_not_created(self):
        saved = self.root.with_name("saved-default")
        self.root.rename(saved)
        self.root.symlink_to(saved, target_is_directory=True)
        before = snapshot(saved)
        self.response(self.prepare(), "blocked")
        self.assertEqual(before, snapshot(saved))
        self.root.unlink()
        self.response(self.prepare(), "blocked")
        self.assertFalse(self.root.exists())
        self.no_network()

    def test_authenticated_profile_is_not_modified(self):
        (self.root / "home/config/crew-harness").unlink()
        write(self.root / "captain/claude/.credentials.json", '{"oauth":"fixture"}')
        before = snapshot(self.root)
        gh = (self.case / "home/.config/gh/hosts.yml").read_bytes()
        value = self.response(self.prepare(), "blocked")
        self.assertIn("authenticated Claude profile", value["fleet"]["preparation"]["diagnostic"])
        self.assertEqual(before, snapshot(self.root))
        self.assertEqual(gh, (self.case / "home/.config/gh/hosts.yml").read_bytes())
        self.no_network()

    def test_saved_inbox_notes_and_request_identity_survive_repair(self):
        inventory = json.loads(process(self.case, "inventory", "default", "--json").stdout)
        request = dict(schemaVersion=1, requestId=str(uuid.uuid4()), expectedFleet=inventory["fleet"]["identity"],
                       originalIntent="Keep this exact required input.", generatedSpec="Keep this separate.",
                       workflowId="firstmate-fleet", projectTarget=None)
        result = process(self.case, "submit", "default", "--json", data=json.dumps(request))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["state"], "saved")
        notes = snapshot(self.root / "home/state/inbox")
        wake = (self.root / "home/state/.wake-queue").read_bytes()
        instance = (self.root / "receipts/instance.json").read_bytes()
        (self.root / "home/config/crew-harness").unlink()
        value = self.response(self.prepare(), "ready")
        self.assertEqual(value["fleet"]["identity"], request["expectedFleet"])
        self.assertEqual(notes, snapshot(self.root / "home/state/inbox"))
        self.assertEqual(wake, (self.root / "home/state/.wake-queue").read_bytes())
        self.assertEqual(instance, (self.root / "receipts/instance.json").read_bytes())
        self.no_network()

    def test_missing_identity_never_rebinds_saved_notes(self):
        write(self.root / "home/state/inbox/saved.note", "saved input bound to the prior identity\n")
        (self.root / "receipts/instance.json").unlink()
        before = snapshot(self.root)
        value = self.response(self.prepare(), "blocked")
        self.assertIn("original fleet identity", value["fleet"]["preparation"]["diagnostic"])
        self.assertEqual(before, snapshot(self.root))
        self.no_network()

    def hold_lock_creation(self, target):
        command = self.case / "bin/mkdir"
        real = str(command.resolve())
        command.unlink()
        source = """#!/usr/bin/env python3
import os, pathlib, subprocess, sys, time
result = subprocess.run([REAL, *sys.argv[1:]], check=False)
root = pathlib.Path(os.environ["FAKE_HEALING_CASE"])
if result.returncode == 0 and TARGET in sys.argv[1:]:
    (root / "lock-ready").write_text("ready")
    while not (root / "lock-release").exists():
        time.sleep(0.03)
raise SystemExit(result.returncode)
""".replace("REAL", repr(real)).replace("TARGET", repr(str(target)))
        write(command, source, 0o755)

    def test_expected_revision_is_rechecked_under_the_mutation_gate(self):
        (self.root / "home/config/crew-harness").unlink()
        before = snapshot(self.root)
        self.hold_lock_creation(self.root / "locks/mutation")
        child = self.start_preparation()
        self.wait_file(self.case / "lock-ready", child)
        path = package(self.case) / "catalog.json"
        value = json.loads(path.read_text())
        value["source"]["commit"] = "a" * 40
        write(path, json.dumps(value), 0o644)
        write(self.case / "lock-release", "release")
        output, error = child.communicate(timeout=20)
        self.assertEqual(child.returncode, 0, error)
        result = json.loads(output)
        self.assertEqual(result["fleet"]["preparation"]["state"], "blocked")
        self.assertIn("revision changed", result["fleet"]["preparation"]["diagnostic"])
        self.assertEqual(before, snapshot(self.root))
        self.no_network()

    def test_install_plan_is_rechecked_under_the_runtime_gate(self):
        self.remove_cache()
        before = snapshot(self.root)
        self.hold_lock_creation(runtime(self.case).parent / ".fmx-install.lock")
        child = self.start_preparation(self.identity)
        self.wait_file(self.case / "lock-ready", child)
        path = package(self.case) / "prerequisites/npm/package-lock.json"
        path.write_text(path.read_text() + "\n")
        write(self.case / "lock-release", "release")
        output, error = child.communicate(timeout=20)
        self.assertEqual(child.returncode, 0, error)
        result = json.loads(output)
        self.assertEqual(result["fleet"]["preparation"]["state"], "blocked")
        self.assertIn("plan changed", result["fleet"]["preparation"]["diagnostic"])
        self.assertEqual(before, snapshot(self.root))
        self.assertFalse((runtime(self.case).parent / ".fmx-install.lock").exists())
        self.no_network()

    def preserve_interrupted_state_on_locked_refusal(self, change):
        write(self.root / "staging/firstmate/old-stage", "existing interrupted stage\n")
        write(self.root / "runtime.previous/old-runtime", "existing retired runtime\n")
        (self.root / "receipts/source.json").rename(self.root / "receipts.previous.json")
        before = snapshot(self.root)
        self.hold_lock_creation(self.root / "locks/mutation")
        child = self.start_preparation(self.identity if change == "plan" else None)
        self.wait_file(self.case / "lock-ready", child)
        if change == "source":
            path = package(self.case) / "catalog.json"
            value = json.loads(path.read_text())
            value["source"]["commit"] = "a" * 40
            write(path, json.dumps(value), 0o644)
        elif change == "lock":
            path = package(self.case) / "prerequisites/npm/package-lock.json"
            path.write_text(path.read_text() + "\n")
        else:
            write(self.case / ".npmrc", "registry=https://new-feed.example/npm/\n")
        write(self.case / "lock-release", "release")
        output, error = child.communicate(timeout=30)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(json.loads(output)["fleet"]["preparation"]["state"], "blocked")
        self.unchanged(before, self.root)
        self.no_network()

    def test_stale_source_refusal_preserves_existing_stage_and_backups(self):
        self.preserve_interrupted_state_on_locked_refusal("source")

    def test_stale_lock_refusal_preserves_existing_stage_and_backups(self):
        self.preserve_interrupted_state_on_locked_refusal("lock")

    def test_stale_plan_refusal_preserves_existing_stage_and_backups(self):
        self.preserve_interrupted_state_on_locked_refusal("plan")

    def test_cancel_between_spawn_and_registration_stops_the_new_group(self):
        control = package(self.case) / "lib/fmx-control.py"
        pid_file, action_file = self.case / "race-child-pid", self.case / "race-child-action"
        driver = self.case / "spawn-race.py"
        code = """import importlib.util, os, pathlib, signal, subprocess, sys
sys.dont_write_bytecode = True
control, pid_file, action_file = map(pathlib.Path, sys.argv[1:])
sys.path.insert(0, str(control.parent))
spec = importlib.util.spec_from_file_location("race_control", control)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original = subprocess.Popen
def raced_spawn(*args, **kwargs):
    child = original(*args, **kwargs)
    assert module.preparation_child is None
    pid_file.write_text(str(child.pid))
    os.kill(os.getpid(), signal.SIGTERM)
    return child
module.subprocess.Popen = raced_spawn
signal.signal(signal.SIGTERM, module.cancel_preparation)
action = "import pathlib,sys,time; time.sleep(2); pathlib.Path(sys.argv[1]).write_text('escaped'); time.sleep(30)"
try:
    module.preparation_process([sys.executable, "-c", action, str(action_file)])
except module.PreparationCancelled:
    raise SystemExit(143)
raise SystemExit("cancellation was lost")
"""
        write(driver, code)
        try:
            result = subprocess.run(
                [str(self.case / "bin/python3"), str(driver), str(control), str(pid_file), str(action_file)],
                env=environment(self.case), capture_output=True, text=True, timeout=10, check=False,
            )
            self.assertEqual(result.returncode, 143, result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertFalse(action_file.exists())
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid_file.read_text()), 0)
        finally:
            if pid_file.exists():
                try:
                    os.killpg(int(pid_file.read_text()), signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def start_preparation(self, approved=None, extra=None):
        args = [str(package(self.case) / "bin/fmx"), "prepare", "default", "--json",
                "--expected-source-revision", REVISION]
        if approved:
            args += ["--install-prerequisites", approved]
        env = environment(self.case)
        env.update(extra or {})
        return subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, cwd=self.case)

    def wait_file(self, path, child):
        # Parallel CI can delay preparation; cancellation keeps its separate 10-second bound.
        deadline = time.monotonic() + 60
        while not path.exists() and time.monotonic() < deadline and child.poll() is None:
            time.sleep(0.03)
        if not path.exists():
            if child.poll() is None:
                child.terminate()
            output, error = child.communicate(timeout=10)
            self.fail("preparation did not reach fixture barrier: " + output + error)

    def cancel_like_guide(self, child):
        child.send_signal(signal.SIGTERM)
        try:
            output, error = child.communicate(timeout=10)
        except subprocess.TimeoutExpired:
            child.send_signal(signal.SIGKILL)
            output, error = child.communicate(timeout=5)
            self.fail("the public fmx parent did not finish cancellation within the Guide's 10-second grace: " + error)
        self.assertEqual(child.returncode, 143, error)
        self.assertEqual(output, "")

    def test_cancelled_install_stops_children_and_releases_owned_locks(self):
        self.remove_cache()
        write(self.case / "hold-npm", "hold")
        child = self.start_preparation(self.identity)
        self.wait_file(self.case / "install-started", child)
        provider_pid = int((self.case / "install-started").read_text())
        self.assertNotEqual(provider_pid, child.pid)
        self.cancel_like_guide(child)
        with self.assertRaises(ProcessLookupError):
            os.kill(provider_pid, 0)
        self.assertFalse((self.root / "locks/mutation").exists())
        self.assertFalse((runtime(self.case).parent / ".fmx-install.lock").exists())
        self.assertFalse((runtime(self.case) / "prerequisites/.install-lock").exists())
        self.assertFalse(list((runtime(self.case) / "prerequisites").glob(".stage.*")))
        self.assertFalse(destination(self.case).exists())
        (self.case / "hold-npm").unlink()
        self.response(self.prepare(self.identity), "ready")

    def test_cancelled_claude_repair_does_not_report_success(self):
        ready, release = self.case / "repair-ready", self.case / "repair-release"
        before = snapshot(self.root)
        child = self.start_preparation(extra={
            "NATIVE_CLAUDE_DOCTOR_STATUS": "1", "NATIVE_CLAUDE_PREPARE_READY": str(ready),
            "NATIVE_CLAUDE_PREPARE_RELEASE": str(release),
        })
        self.wait_file(ready, child)
        self.cancel_like_guide(child)
        self.assertEqual(before, snapshot(self.root))
        self.assertFalse((self.root / "locks/mutation").exists())
        self.response(self.prepare(), "ready")
        self.no_network()

    def test_cancelled_runtime_repair_rolls_back_staging_from_parent_signal(self):
        source_before = snapshot(package(self.case))
        runtime_file = self.root / "runtime/bin/fm-brief.sh"
        runtime_file.write_text(runtime_file.read_text() + "\n# repair required\n")
        before = snapshot(self.root)
        command = self.case / "bin/git"
        wrapped = command.with_name("git-fixture")
        command.rename(wrapped)
        source = """#!/usr/bin/env python3
import os, pathlib, sys, time
root = pathlib.Path(os.environ["FAKE_HEALING_CASE"])
if "fetch" in sys.argv[1:]:
    (root / "fetch-started").write_text(str(os.getpid()))
    while not (root / "fetch-release").exists():
        time.sleep(0.03)
    raise SystemExit(0)
os.execv(WRAPPED, [WRAPPED, *sys.argv[1:]])
""".replace("WRAPPED", repr(str(wrapped)))
        write(command, source, 0o755)
        child = self.start_preparation()
        self.wait_file(self.case / "fetch-started", child)
        provider_pid = int((self.case / "fetch-started").read_text())
        self.assertNotEqual(provider_pid, child.pid)
        self.assertTrue((self.root / "staging/firstmate/.git").is_dir())
        self.cancel_like_guide(child)
        with self.assertRaises(ProcessLookupError):
            os.kill(provider_pid, 0)
        self.assertFalse((self.root / "locks/mutation").exists())
        self.assertFalse((self.root / "staging").exists())
        self.unchanged(before, self.root)
        self.unchanged(source_before, package(self.case))
        command.unlink()
        wrapped.rename(command)
        self.response(self.prepare(), "ready")
        self.no_network()

    def test_stale_owned_prepare_and_installer_locks_recover(self):
        self.remove_cache()
        write(self.root / "locks/mutation/owner", OWNER + "\n")
        write(self.root / "locks/mutation/action", "prepare\n")
        write(self.root / "locks/mutation/pid", "2147483647\n")
        lock = runtime(self.case) / "prerequisites/.install-lock"
        write(lock / "owner", TOOL_OWNER + "\n")
        write(lock / "pid", "2147483647\n")
        self.response(self.prepare(self.identity), "ready")
        self.assertFalse(lock.exists())
        self.assertFalse((self.root / "locks/mutation").exists())


if __name__ == "__main__":
    unittest.main(verbosity=1)
