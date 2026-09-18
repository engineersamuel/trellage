#!/usr/bin/env python3
"""Named fleet behavior through real Native entrypoints and linked Git worktrees."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
import uuid

sys.dont_write_bytecode = True
os.environ["FMX_HEALING_TEST"] = os.environ.get("FMX_INSTANCE_TEST", "")
spec = importlib.util.spec_from_file_location("healing", Path(__file__).with_name("healing-contract.py"))
healing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(healing)
healing.BASE = healing.FIXTURE / "instances-baseline"
SOURCE, REPO = healing.SOURCE, healing.REPO
REAL_GIT = shutil.which("git")
CORE = "@trellage/guide-core"
BUN_EVAL = ["bun", "--no-install", "--no-env-file", f"--config={REPO / 'bunfig.toml'}", "-e"]


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


class InstanceContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        healing.create_baseline()
        destination = healing.runtime(healing.BASE).parent / "common/floating-skills-runtime"
        result = subprocess.run(
            [str(REPO / "scripts/install-source-runtime.sh"), "--stage", str(destination)],
            env=healing.environment(healing.BASE), capture_output=True, text=True, check=False,
        )
        if result.returncode:
            raise AssertionError("could not stage the shared Bun source runtime: " + result.stderr)

    def setUp(self):
        healing.HealingContract.setUp(self)
        self.children = []
        self.package = healing.package(self.case)
        self.runtime = healing.runtime(self.case)
        self.home = self.case / "home"
        self.registry = self.home / ".local/share/trellage/profiles/firstmate/instances"
        self.complete_shared_candidate()
        self.project = self.case / "project"
        self.worktree_a = self.case / "worktree-a"
        self.worktree_b = self.case / "worktree-b"
        self.git("init", "-q", str(self.project))
        healing.write(self.project / "code.txt", "fixture\n")
        self.git("-C", str(self.project), "add", ".")
        self.git("-C", str(self.project), "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture",
                 "commit", "-qm", "fixture")
        for path in (self.worktree_a, self.worktree_b):
            self.git("-C", str(self.project), "worktree", "add", "-q", "--detach", str(path), "HEAD")

    def tearDown(self):
        for child in self.children:
            if child.poll() is None:
                child.terminate()
                try:
                    child.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.communicate(timeout=10)
        healing.HealingContract.tearDown(self)

    def git(self, *args):
        result = subprocess.run([REAL_GIT, *args], cwd=self.case, env=healing.environment(self.case),
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def complete_shared_candidate(self):
        scripts = self.case / "scripts"
        scripts.mkdir()
        shutil.copyfile(REPO / "scripts/floating-skills.ts", scripts / "floating-skills.ts")
        healing.write(
            scripts / "install-floating-skills-runtime.sh",
            "#!/usr/bin/env bash\nexec " + shlex.quote(str(REPO / "scripts/install-floating-skills-runtime.sh")) + ' "$@"\n',
            0o755,
        )
        shutil.copyfile(REPO / "skills.json", self.case / "skills.json")
        native_skills = REPO / "prototypes/trellage-claude-common/native-skills.ts"
        shutil.copyfile(native_skills, self.package.parent / "trellage-claude-common/native-skills.ts")
        shutil.copyfile(native_skills, self.runtime / "native-skills.ts")
        for target in (scripts / "trellage-session-bridge.py", self.runtime / "lib/trellage-session-bridge.py"):
            shutil.copyfile(REPO / "scripts/trellage-session-bridge.py", target)
        refresh = "const m=await import(process.argv[1]);m.writeReadiness(process.argv[2]);"
        result = subprocess.run(
            [*BUN_EVAL, refresh, (REPO / "packages/trellage-runtime/src/workspace.ts").as_uri(),
             str(self.runtime.parent / "common/floating-skills-runtime")],
            env=healing.environment(self.case), capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def run_fmx(self, *args, data=None, cwd=None, env=None, installed=False):
        values = healing.environment(self.case)
        values.update(env or {})
        return subprocess.run([str((self.runtime if installed else self.package) / "bin/fmx"), *args],
                              input=None if data is None else json.dumps(data), text=True, capture_output=True,
                              env=values, cwd=cwd or self.case, timeout=80, check=False)

    def json_result(self, result, state=None):
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        if state is not None:
            self.assertEqual(value["state"], state, value)
        return value

    def parse_core(self, parser, value, extra=None):
        script = """import fs from 'node:fs';
const core=await import(process.argv[1]);
const input=JSON.parse(fs.readFileSync(0,'utf8'));
core[process.argv[2]](input.value, ...(input.extra===null ? [] : [input.extra]));
process.stdout.write('validated');"""
        result = subprocess.run([*BUN_EVAL, script, CORE, parser],
                                input=json.dumps({"value": value, "extra": extra}), text=True, capture_output=True,
                                env=healing.environment(self.case), cwd=self.case, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)

    def plan(self, name, worktree, profile="default"):
        result = self.json_result(self.run_fmx("instances", "plan", profile, "--name", name, "--worktree", str(worktree),
                                             "--json", "--expected-source-revision", healing.REVISION), "ready")
        self.parse_core("parseFirstmateInstancePlanResultV1", result)
        return result["plan"]

    def create(self, plan, state="created"):
        result = self.json_result(self.run_fmx("instances", "create", plan["reference"]["profile"], "--json",
                                             "--approve-creation", plan["approvalDigest"], data=plan), state)
        self.parse_core("parseFirstmateInstanceCreateResultV1", result, plan)
        return result

    def context(self, plan, selection="entry-match", entry=None):
        return {"schemaVersion": 1, "reference": plan["reference"], "expectedBindingDigest": digest(plan["worktree"]),
                "expectedRuntimeDigest": digest(plan["runtimeRequirements"]),
                "entryWorktree": plan["worktree"] if entry is None else entry, "selection": selection}

    def selected(self, operation, plan, *args, context=True, **kwargs):
        command = [operation, plan["reference"]["profile"], "--instance", plan["reference"]["instanceId"], *args]
        if context:
            command += ["--fmx-instance-context-json", json.dumps(self.context(plan))]
        return self.run_fmx(*command, **kwargs)

    def command(self, argv, env=None, data=None):
        values = healing.environment(self.case)
        values.update(env or {})
        return subprocess.run([str(arg) for arg in argv], input=data, text=True, capture_output=True,
                              env=values, cwd=self.case, timeout=80, check=False)

    def test_linked_worktrees_create_and_reuse_isolated_default_instances(self):
        before_legacy = healing.snapshot(self.root)
        before_git = healing.snapshot(self.project)
        a, b = self.plan("alpha", self.worktree_a), self.plan("beta", self.worktree_b)
        self.assertFalse(self.registry.exists(), "planning mutated the registry")
        self.assertNotEqual(a["reference"]["instanceId"], b["reference"]["instanceId"])
        self.assertNotEqual(a["taskIdPrefix"], b["taskIdPrefix"])
        self.assertEqual(a["worktree"]["generation"]["commonGitDir"], b["worktree"]["generation"]["commonGitDir"])
        self.assertNotEqual(a["worktree"]["generationDigest"], b["worktree"]["generationDigest"])
        self.create(a)
        self.create(b)
        self.create(a, "existing")
        for plan, worktree in ((a, self.worktree_a), (b, self.worktree_b)):
            resolved = self.json_result(self.run_fmx("instances", "resolve", "default", "--worktree", str(worktree), "--json"), "matched")
            self.parse_core("parseFirstmateInstanceResolveResultV1", resolved)
            self.assertEqual(resolved["descriptor"]["reference"], plan["reference"])
            ready = self.json_result(self.selected("prepare", plan, "--json", "--expected-source-revision", healing.REVISION))
            self.assertEqual(ready["fleet"]["preparation"]["state"], "ready", ready)
            self.assertEqual(ready["fleet"]["identity"]["home"], plan["destination"] + "/home")
            self.assertEqual(ready["fleet"]["identity"]["instanceId"], plan["reference"]["instanceId"])
        self.assertEqual(before_legacy, healing.snapshot(self.root))
        self.assertEqual(before_git, healing.snapshot(self.project))

    def test_pagination_stale_cursor_and_profile_names(self):
        a = self.plan("same-name", self.worktree_a)
        self.create(a)
        pstack = self.plan("same-name", self.worktree_a, "pstack-workers")
        self.create(pstack)
        first = self.json_result(self.run_fmx("instances", "list", "default", "--json", "--limit", "1"), "page")
        self.parse_core("parseFirstmateInstanceListResultV1", first)
        self.assertEqual(first["instances"][0]["mode"], "legacy")
        last = self.json_result(self.run_fmx("instances", "list", "default", "--json", "--limit", "1",
                                           "--cursor=" + first["page"]["nextCursor"]), "page")
        self.parse_core("parseFirstmateInstanceListResultV1", last)
        self.assertEqual(last["instances"][0]["reference"], a["reference"])
        self.assertIsNone(last["page"]["nextCursor"])
        self.create(self.plan("beta", self.worktree_b))
        stale = self.json_result(self.run_fmx("instances", "list", "default", "--json",
                                            "--cursor=" + first["page"]["nextCursor"]), "stale-cursor")
        self.parse_core("parseFirstmateInstanceListResultV1", stale)

    def test_creation_approval_source_and_namespace_conflicts_preserve_state(self):
        a, b = self.plan("alpha", self.worktree_a), self.plan("beta", self.worktree_b)
        before = healing.snapshot(self.home)
        denied = self.json_result(self.run_fmx("instances", "create", "default", "--json", data=a), "blocked")
        self.assertEqual(denied["diagnostics"][0]["code"], "approval-mismatch")
        self.assertEqual(before, healing.snapshot(self.home))
        self.create(a)
        before = healing.snapshot(self.home)
        b["taskIdPrefix"] = a["taskIdPrefix"]
        b["approvalDigest"] = digest({key: value for key, value in b.items() if key != "approvalDigest"})
        self.create(b, "blocked")
        self.assertEqual(before, healing.snapshot(self.home))
        changed = dict(a, name="other")
        changed["approvalDigest"] = digest({key: value for key, value in changed.items() if key != "approvalDigest"})
        self.create(changed, "blocked")
        self.assertEqual(before, healing.snapshot(self.home))

    def test_legacy_uuid_cannot_be_rebound_to_a_named_root(self):
        plan = self.plan("alpha", self.worktree_a)
        instance_id = json.loads((self.root / "receipts/instance.json").read_text())["instanceId"]
        plan["reference"]["instanceId"] = instance_id
        plan["destination"] = str(self.registry / instance_id)
        plan["permittedWrites"][0]["path"] = plan["destination"]
        plan["approvalDigest"] = digest({key: value for key, value in plan.items() if key != "approvalDigest"})
        before = healing.snapshot(self.home)
        result = self.create(plan, "blocked")
        self.assertEqual(result["diagnostics"][0]["code"], "stale-plan")
        self.assertEqual(before, healing.snapshot(self.home))

        self.create(self.plan("beta", self.worktree_b))
        unknown = self.registry / instance_id
        unknown.mkdir(mode=0o700)
        sentinel = unknown / "preserve"
        sentinel.write_text("Unreserved directory must not inherit a legacy UUID.\n")
        sentinel.chmod(0o600)
        before = healing.snapshot(self.home)
        listing = self.json_result(self.run_fmx("instances", "list", "default", "--json"), "blocked")
        self.assertIn("unreserved", listing["diagnostics"][0]["message"])
        self.assertEqual(before, healing.snapshot(self.home))

    def reserve_unpublished(self, plan, descriptor=False):
        script = """import importlib.util,json,pathlib,sys
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location('instances',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
plan=json.loads(sys.argv[2]);root=m.registry.ensure_registry()
m.registry.atomic_json(root/'locks/plans'/(plan['reference']['instanceId']+'.json'),
 {'schemaVersion':1,'owner':m.registry.REGISTRY_OWNER,'phase':'reserved','plan':plan})
if sys.argv[3]=='yes':
 m.publish_reserved_root(plan)
 (pathlib.Path(plan['destination'])/'receipts/instance.json').unlink()
"""
        result = self.command([sys.executable, "-c", script, self.package / "lib/fmx-instances.py",
                               json.dumps(plan), "yes" if descriptor else "no"])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_cross_profile_uuid_cannot_overwrite_pending_reservation(self):
        a = self.plan("alpha", self.worktree_a)
        b = self.plan("beta", self.worktree_b, "pstack-workers")
        self.reserve_unpublished(a)
        b["reference"]["instanceId"] = a["reference"]["instanceId"]
        b["destination"] = a["destination"]
        b["permittedWrites"][0]["path"] = a["destination"]
        b["approvalDigest"] = digest({key: value for key, value in b.items() if key != "approvalDigest"})
        before = healing.snapshot(self.home)
        self.create(b, "incomplete")
        self.assertEqual(before, healing.snapshot(self.home))
        self.assertEqual(self.plan("alpha", self.worktree_a), a)
        self.create(a)

    def test_unpublished_descriptor_without_identity_recovers_original_plan(self):
        a = self.plan("alpha", self.worktree_a)
        self.reserve_unpublished(a, descriptor=True)
        self.create(a)
        identity = json.loads((Path(a["destination"]) / "receipts/instance.json").read_text())
        self.assertEqual(identity["instanceId"], a["reference"]["instanceId"])
        self.create(a, "existing")

    def test_explicit_join_and_locator_refresh(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        denied = self.selected("prepare", a, "--json", "--expected-source-revision", healing.REVISION,
                               context=False, cwd=self.worktree_b)
        self.assertNotEqual(denied.returncode, 0)
        joined = self.json_result(self.selected("prepare", a, "--json", "--expected-source-revision", healing.REVISION,
                                                "--join", context=False, cwd=self.worktree_b))
        self.assertEqual(joined["fleet"]["preparation"]["state"], "ready", joined)
        moved = self.case / "moved-a"
        self.git("-C", str(self.project), "worktree", "move", str(self.worktree_a), str(moved))
        refused = self.selected("prepare", a, "--json", "--expected-source-revision", healing.REVISION)
        self.assertNotEqual(refused.returncode, 0)
        previous = self.create_descriptor(a)
        refreshed = self.json_result(self.run_fmx("instances", "refresh-locator", "default", "--instance", a["reference"]["instanceId"],
                                                "--worktree", str(moved), "--json", "--expected-binding-digest", digest(a["worktree"]), "--confirm"))
        self.parse_core("parseFirstmateInstanceLocatorRefreshResultV1", refreshed, previous)
        self.assertEqual(refreshed["worktree"]["evidence"]["generationDigest"], a["worktree"]["generationDigest"])
        self.assertEqual(refreshed["worktree"]["evidence"]["locators"]["worktree"], str(moved))

    def create_descriptor(self, plan):
        return json.loads((Path(plan["destination"]) / "instance.json").read_text())

    def wait_file(self, path, child, timeout=30):
        until = time.monotonic() + timeout
        while not path.exists():
            if child.poll() is not None:
                output, error = child.communicate()
                self.fail(f"child stopped before its barrier: {output}\n{error}")
            self.assertLess(time.monotonic(), until, "child did not reach its barrier")
            time.sleep(0.03)

    def start_supervisor(self, plan, label):
        ready = self.case / (label + "-ready")
        values = healing.environment(self.case)
        values.update(NATIVE_CLAUDE_LAUNCH_READY=str(ready),
                      NATIVE_CLAUDE_LAUNCH_RELEASE=str(self.case / (label + "-release")),
                      NATIVE_CLAUDE_INSTANCE_LOG=str(self.case / "instance-launches.jsonl"),
                      NATIVE_CLAUDE_ARGV_LOG=str(self.case / "captain-argv.jsonl"))
        child = subprocess.Popen([str(self.package / "bin/fmx"), plan["reference"]["profile"],
                                  "--instance", plan["reference"]["instanceId"],
                                  "--fmx-instance-context-json", json.dumps(self.context(plan))],
                                 env=values, cwd=self.worktree_b, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(child)
        self.wait_file(ready, child)
        return child

    def inventory(self, plan):
        return self.json_result(self.selected("inventory", plan, "--json", context=False))

    def test_concurrent_supervisors_reject_only_duplicate_instance_and_keep_startup_origin(self):
        a, b = self.plan("alpha", self.worktree_a), self.plan("beta", self.worktree_b)
        self.create(a)
        self.create(b)
        first, second = self.start_supervisor(a, "alpha"), self.start_supervisor(b, "beta")
        self.assertNotEqual(first.pid, second.pid)
        for plan, child in ((a, first), (b, second)):
            fleet = self.inventory(plan)["fleet"]
            self.assertEqual(fleet["supervisor"], {"state": "running", "pid": child.pid})
            self.assertTrue(fleet["actions"]["submit"]["allowed"])
        before = healing.snapshot(Path(b["destination"]))
        duplicate = self.run_fmx("default", "--instance", a["reference"]["instanceId"],
                                 "--fmx-instance-context-json", json.dumps(self.context(a)))
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("already running", duplicate.stderr)
        self.assertEqual(before, healing.snapshot(Path(b["destination"])))
        self.assertIsNone(second.poll())
        origins = [json.loads(line) for line in (self.case / "instance-launches.jsonl").read_text().splitlines()]
        arguments = [json.loads(line) for line in (self.case / "captain-argv.jsonl").read_text().splitlines()]
        self.assertEqual(len(origins), 2)
        for origin, plan, argv in zip(origins, (a, b), arguments):
            context = json.loads(origin["FMX_LAUNCH_PROVENANCE_JSON"])
            self.parse_core("parseFirstmateInstanceControlContextV1", context)
            self.assertEqual(context, self.context(plan))
            self.assertEqual(origin["FMX_INSTANCE_ID"], plan["reference"]["instanceId"])
            self.assertEqual(len(argv), 1)
            self.assertIn("session-start", argv[0])
            self.assertIn("bin/fm-inbox.sh drain", argv[0])

    def request(self, plan, request_id):
        return {"schemaVersion": 1, "requestId": request_id, "expectedFleet": self.inventory(plan)["fleet"]["identity"],
                "originalIntent": "Keep this request in its selected fleet.", "generatedSpec": "Inspect the local fixture.",
                "workflowId": "implement", "projectTarget": None}

    def test_same_id_receipts_are_isolated_and_readable_after_binding_loss(self):
        a, b = self.plan("alpha", self.worktree_a), self.plan("beta", self.worktree_b)
        self.create(a)
        self.create(b)
        request_id = str(uuid.uuid4())
        requests = [self.request(plan, request_id) for plan in (a, b)]
        results = []
        for plan, request in zip((a, b), requests):
            result = self.json_result(self.selected("submit", plan, "--json", data=request))
            self.assertEqual(result["state"], "saved", result)
            results.append(result)
        self.assertNotEqual(results[0]["digest"], results[1]["digest"])
        before_b = healing.snapshot(Path(b["destination"]))
        self.json_result(self.selected("submit", a, "--json", data=requests[0]))
        self.assertEqual(before_b, healing.snapshot(Path(b["destination"])))
        moved = self.case / "moved-a"
        self.git("-C", str(self.project), "worktree", "move", str(self.worktree_a), str(moved))
        receipt = {key: requests[0][key] for key in ("schemaVersion", "requestId", "expectedFleet")}
        result = self.json_result(self.selected("receipt", a, "--json", context=False, data=receipt, cwd=self.worktree_b))
        self.assertEqual(result["digest"], results[0]["digest"])
        self.assertEqual(result["state"], "saved")
        denied = self.selected("submit", a, "--json", data=requests[0])
        self.assertNotEqual(denied.returncode, 0)
        self.assertEqual(before_b, healing.snapshot(Path(b["destination"])))

    def test_saved_named_receipt_does_not_execute_or_require_its_runtime(self):
        plan = self.plan("alpha", self.worktree_a)
        self.create(plan)
        request = self.request(plan, str(uuid.uuid4()))
        saved = self.json_result(self.selected("submit", plan, "--json", data=request))
        lookup = {key: request[key] for key in ("schemaVersion", "requestId", "expectedFleet")}
        root = Path(plan["destination"])
        inbox = root / "home/state/inbox"
        note = inbox / (request["requestId"] + ".note")
        original_note = note.read_bytes()
        moved = self.case / "moved-receipt-worktree"
        self.git("-C", str(self.project), "worktree", "move", str(self.worktree_a), str(moved))
        runtime = root / "runtime"
        helper = runtime / "bin/fm-inbox.sh"
        helper.write_text("#!/usr/bin/env bash\nprintf 'damaged runtime must not execute\\n' >&2\nexit 97\n")
        for damage in ("drift", "missing"):
            with self.subTest(damage=damage):
                if damage == "missing":
                    shutil.rmtree(runtime)
                before = healing.snapshot(self.home)
                result = self.json_result(self.selected("receipt", plan, "--json", context=False,
                                                       data=lookup, cwd=self.worktree_b))
                self.assertEqual(result["digest"], saved["digest"])
                self.assertEqual(result["state"], "saved")
                self.assertEqual(note.read_bytes(), original_note)
                self.assertEqual(before, healing.snapshot(self.home))
        for field, value in (("instanceId", str(uuid.uuid4())), ("home", str(self.root / "home")),
                             ("sourceRevision", "f" * 40)):
            with self.subTest(foreign=field):
                wrong = json.loads(json.dumps(lookup))
                wrong["expectedFleet"][field] = value
                before = healing.snapshot(self.home)
                refused = self.selected("receipt", plan, "--json", context=False, data=wrong)
                self.assertNotEqual(refused.returncode, 0)
                self.assertEqual(before, healing.snapshot(self.home))

    def test_parent_only_creation_cancellation_retains_same_plan_and_recovers(self):
        a = self.plan("alpha", self.worktree_a)
        ready = self.case / "creation-ready"
        values = healing.environment(self.case)
        values.update(NATIVE_CLAUDE_PREPARE_READY=str(ready),
                      NATIVE_CLAUDE_PREPARE_RELEASE=str(self.case / "creation-release"))
        child = subprocess.Popen([str(self.package / "bin/fmx"), "instances", "create", "default", "--json",
                                  "--approve-creation", a["approvalDigest"]],
                                 env=values, cwd=self.case, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(child)
        child.stdin.write(json.dumps(a))
        child.stdin.close()
        child.stdin = None
        self.wait_file(ready, child)
        started = time.monotonic()
        child.terminate()
        output, error = child.communicate(timeout=10)
        self.assertEqual(child.returncode, 143, (output, error))
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(output, "")
        self.assertFalse((self.registry / "locks/allocation").exists())
        self.assertFalse((Path(a["destination"]) / "locks/mutation").exists())
        self.assertFalse((Path(a["destination"]) / "staging").exists())
        recovered = self.plan("alpha", self.worktree_a)
        self.assertEqual(recovered, a, "an uncertain creation was rebound to another UUID or plan")
        self.create(a)
        self.assertEqual([path.name for path in self.registry.iterdir() if path.name != "locks"],
                         [a["reference"]["instanceId"]])

    def test_copied_git_pointer_and_recreated_worktree_do_not_adopt_old_instance(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        pointer = self.worktree_b / ".git"
        original = pointer.read_bytes()
        pointer.write_bytes((self.worktree_a / ".git").read_bytes())
        blocked = self.json_result(self.run_fmx("instances", "resolve", "default", "--worktree", str(self.worktree_b), "--json"), "blocked")
        self.parse_core("parseFirstmateInstanceResolveResultV1", blocked)
        pointer.write_bytes(original)
        self.git("-C", str(self.project), "worktree", "remove", str(self.worktree_a))
        self.git("-C", str(self.project), "worktree", "add", "-q", "--detach", str(self.worktree_a), "HEAD")
        resolved = self.json_result(self.run_fmx("instances", "resolve", "default", "--worktree", str(self.worktree_a), "--json"), "not-found")
        self.assertNotEqual(resolved["worktree"]["generationDigest"], a["worktree"]["generationDigest"])
        denied = self.run_fmx("instances", "refresh-locator", "default", "--instance", a["reference"]["instanceId"],
                              "--worktree", str(self.worktree_a), "--json", "--expected-binding-digest", digest(a["worktree"]), "--confirm")
        self.assertNotEqual(denied.returncode, 0)

    def test_instance_bound_install_approval_and_shared_cache_reuse(self):
        a, b = self.plan("alpha", self.worktree_a), self.plan("beta", self.worktree_b)
        self.create(a)
        self.create(b)
        shutil.rmtree(healing.destination(self.case))
        options = ("--json", "--expected-source-revision", healing.REVISION)
        plans = []
        for plan in (a, b):
            result = self.json_result(self.selected("prepare", plan, *options))
            self.assertEqual(result["fleet"]["preparation"]["state"], "needs-consent", result)
            plans.append(result["fleet"]["preparation"]["installation"])
        self.assertNotEqual(plans[0]["identity"], plans[1]["identity"])
        self.assertEqual(plans[0]["destination"], plans[1]["destination"])
        before = healing.snapshot(self.home)
        denied = self.selected("prepare", b, *options, "--install-prerequisites", plans[0]["identity"])
        self.assertNotEqual(denied.returncode, 0)
        self.assertEqual(before, healing.snapshot(self.home))
        self.assertFalse((self.case / "network.log").exists())
        result = self.json_result(self.selected("prepare", a, *options, "--install-prerequisites", plans[0]["identity"]))
        self.assertEqual(result["fleet"]["preparation"]["state"], "ready", result)
        self.start_supervisor(a, "alpha")
        before = healing.snapshot(Path(a["destination"]))
        result = self.json_result(self.selected("prepare", b, *options))
        self.assertEqual(result["fleet"]["preparation"]["state"], "ready", result)
        self.assertEqual(before, healing.snapshot(Path(a["destination"])))

    def test_published_missing_identity_is_never_recreated(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        identity = Path(a["destination"]) / "receipts/instance.json"
        identity.unlink()
        before = healing.snapshot(self.home)
        self.create(a, "blocked")
        result = self.selected("prepare", a, "--json", "--expected-source-revision", healing.REVISION)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, healing.snapshot(self.home))
        listing = self.json_result(self.run_fmx("instances", "list", "default", "--json"), "page")
        self.assertEqual(listing["instances"][1]["creationState"], "missing-identity")
        self.parse_core("parseFirstmateInstanceListResultV1", listing)

    def test_selector_ambiguity_and_foreign_context_never_fall_back_to_legacy(self):
        a, b = self.plan("alpha", self.worktree_a), self.plan("beta", self.worktree_b)
        self.create(a)
        self.create(b)
        before = healing.snapshot(self.home)
        for arguments in (
            ("default", "--instance=" + a["reference"]["instanceId"]),
            ("default", "--instance", "alpha", "--instance", "beta"),
            ("default", "--instance", ""),
            ("default", "--instance", "missing", "--join"),
            ("prepare", "default", "--instance", "alpha", "--json", "--expected-source-revision", healing.REVISION,
             "--fmx-instance-context-json", json.dumps(self.context(b))),
            ("repair", "--all", "--instance", "alpha"),
            ("instances", "resolve", "default", "--worktree", str(self.worktree_a), "--name", "ignored", "--json"),
        ):
            refused = self.run_fmx(*arguments)
            self.assertNotEqual(refused.returncode, 0, refused.stdout)
            self.assertEqual(before, healing.snapshot(self.home))
        named = self.json_result(self.run_fmx("inventory", "default", "--instance", "alpha", "--json"))
        self.assertEqual(named["fleet"]["identity"]["instanceId"], a["reference"]["instanceId"])
        legacy = self.json_result(self.run_fmx("inventory", "default", "--instance", "legacy", "--json"))
        self.assertEqual(legacy["fleet"]["identity"]["home"], str(self.root / "home"))

    def test_named_variant_requires_both_layers_modes_and_full_union(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        root = Path(a["destination"])
        healthy = self.inventory(a)["overlay"]
        self.assertTrue(healthy["verified"])
        self.assertEqual(healthy["fileCount"], 15)
        self.assertEqual(healthy["manifestDigest"], digest(a["runtimeRequirements"]))
        self.assertEqual(healthy["contentDigest"], a["runtimeRequirements"]["effectiveContentDigest"])
        target = root / "runtime/bin/backends/tmux.sh"
        original, mode = target.read_bytes(), target.stat().st_mode & 0o777
        for change in ("base-only", "mode", "extra"):
            if change == "base-only":
                target.write_bytes((SOURCE / "tests/fixtures/firstmate" / healing.REVISION / "bin/backends/tmux.sh").read_bytes())
            elif change == "mode":
                target.chmod(0o755)
            else:
                healing.write(root / "runtime/.unapproved", "must not be ignored\n")
            result = self.inventory(a)
            self.assertFalse(result["overlay"]["verified"], change)
            launch = self.run_fmx("default", "--instance", a["reference"]["instanceId"],
                                  "--fmx-instance-context-json", json.dumps(self.context(a)))
            self.assertNotEqual(launch.returncode, 0, change)
            target.write_bytes(original)
            target.chmod(mode)
            (root / "runtime/.unapproved").unlink(missing_ok=True)
        self.assertTrue(self.inventory(a)["overlay"]["verified"])

    def test_missing_bootstrap_and_old_shared_writer_evidence_prevent_creation(self):
        installed_helper = self.runtime / "lib/native-claude"
        original = installed_helper.read_bytes()
        installed_helper.write_bytes(b"#!/bin/sh\nexit 0\n")
        before = healing.snapshot(self.home)
        blocked = self.json_result(self.run_fmx("instances", "plan", "default", "--name", "alpha",
                                                "--worktree", str(self.worktree_a), "--json",
                                                "--expected-source-revision", healing.REVISION), "blocked")
        self.assertEqual(blocked["diagnostics"][0]["code"], "upgrade-required")
        self.assertEqual(before, healing.snapshot(self.home))
        installed_helper.write_bytes(original)
        a = self.plan("alpha", self.worktree_a)
        shutil.rmtree(self.runtime.parent / "common/skills")
        before = healing.snapshot(self.home)
        result = self.create(a, "blocked")
        self.assertEqual(result["diagnostics"][0]["code"], "bootstrap-required")
        self.assertEqual(before, healing.snapshot(self.home))
        self.assertFalse(self.registry.exists())

    def test_shared_writers_refuse_active_and_ambiguous_named_state_before_recovery(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        captain = self.start_supervisor(a, "alpha")
        healing.HealingContract.shared_maintenance_artifacts(self, interrupted=True)
        shared = self.runtime.parent / "common"
        healing.write(shared / ".floating-retired/retained", "old shared backup\n")
        writer_bin = self.case / "writer-bin"
        healing.write(writer_bin / "claude", "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '2.1.233 (Claude Code)'; "
                      "else echo changed >\"$HOME/shared-cli-write\"; fi\n", 0o755)
        values = {"PATH": str(writer_bin) + ":" + healing.environment(self.case)["PATH"],
                  "TRELLAGE_CLAUDE_LAUNCHER_NAME": "fmx", "TRELLAGE_CLAUDE_RUNTIME_ROOT": str(self.package)}
        manager = REPO / "scripts/floating-skills.ts"
        js = """const m=await import(process.argv[1]); const mode=process.argv[2], cache=process.argv[3];
const opts={catalog:{sources:{},bundles:{}},bundleIds:['native-common'],cache,destination:cache};
if(mode==='sync') await m.syncSnapshot(process.argv[4],cache);
else await m[mode](opts);"""
        operations = [
            [self.case / "bin/bash", SOURCE / "install.sh"],
            [self.case / "bin/bash", SOURCE / "uninstall.sh"],
            [self.case / "bin/bash", REPO / "scripts/install-floating-skills-runtime.sh"],
            [self.case / "bin/bash", REPO / "prototypes/trellage-claude-common/native-claude", "harness-update"],
        ]
        for name in ("updateNative", "stageLatest", "checkNative", "sync"):
            operations.append([*BUN_EVAL, js, manager.as_uri(), name,
                               shared / "skills", shared / "skills"])
        for state in ("active", "ambiguous"):
            if state == "ambiguous":
                captain.terminate()
                captain.communicate(timeout=10)
                healing.write(Path(a["destination"]) / "locks/mutation", "unowned mutation record\n")
            before = healing.snapshot(self.home)
            for command in operations:
                with self.subTest(state=state, command=str(command[-1])):
                    refused = self.command(command, values)
                    self.assertNotEqual(refused.returncode, 0, (command, refused.stdout, refused.stderr))
                    self.assertRegex(refused.stderr, r"(?i)active|unsafe|unowned")
                    self.assertEqual(before, healing.snapshot(self.home))
        shutil.rmtree(healing.destination(self.case))
        before = healing.snapshot(self.home)
        refused = self.command([self.package / "lib/fmx-prerequisites", "install"])
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(before, healing.snapshot(self.home))
        self.assertFalse((self.case / "network.log").exists())

    def test_final_creation_publication_loss_reconciles_without_repair_or_new_uuid(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        path = self.registry / "locks/plans" / (a["reference"]["instanceId"] + ".json")
        record = json.loads(path.read_text())
        record["phase"] = "creating"
        path.write_text(json.dumps(record))
        denied = self.selected("prepare", a, "--json", "--expected-source-revision", healing.REVISION)
        self.assertNotEqual(denied.returncode, 0)
        before = healing.snapshot(Path(a["destination"]))
        self.create(a)
        self.assertEqual(before, healing.snapshot(Path(a["destination"])))
        self.assertEqual(json.loads(path.read_text())["phase"], "published")

    def test_bridge_preserves_destination_and_validates_named_and_legacy_origin(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        spec = importlib.util.spec_from_file_location("instance_bridge", REPO / "scripts/trellage-session-bridge.py")
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        legacy_id = json.loads((self.root / "receipts/instance.json").read_text())["instanceId"]
        legacy = {"schemaVersion": 1, "reference": {"schemaVersion": 1, "profile": "default", "mode": "legacy", "instanceId": legacy_id},
                  "expectedBindingDigest": None, "expectedRuntimeDigest": None, "entryWorktree": None, "selection": "confirmed-join"}
        for root, context in ((Path(a["destination"]), self.context(a)), (self.root, legacy)):
            values = healing.environment(self.case) | {
                "HERDR_PANE_ID": "destination:p1", "HERDR_SESSION": "destination",
                "FMX_LAUNCH_PROVENANCE_JSON": json.dumps(context), "FMX_PROFILE_ROOT": str(root),
                "FM_HOME": str(root / "home"), "CLAUDE_CONFIG_DIR": str(root / "captain/claude"),
            }
            with patch.dict(os.environ, values, clear=True), patch.object(bridge, "herdr_agent_context", return_value=(8, 42)), \
                    patch.object(bridge, "send_herdr_request") as sent:
                bridge.report_native_session("claude", "default", {"session_id": "session"})
                request = sent.call_args.args[0]
                self.assertEqual(request["params"]["pane_id"], "destination:p1")
                tokens = request["params"]["tokens"]
                self.assertEqual(tokens["trellage_profile"], "default")
                self.assertEqual(json.loads(tokens["trellage_firstmate_launch_origin"]), context)
                os.environ["CLAUDE_CONFIG_DIR"] = str(self.case / "wrong-captain")
                with self.assertRaises(bridge.BridgeError):
                    bridge.report_native_session("claude", "default", {"session_id": "session"})
                self.assertEqual(sent.call_count, 1)

    def start_creation(self, plan, values):
        child = subprocess.Popen([str(self.package / "bin/fmx"), "instances", "create", plan["reference"]["profile"],
                                  "--json", "--approve-creation", plan["approvalDigest"]],
                                 env=healing.environment(self.case) | values, cwd=self.case, text=True,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        self.children.append(child)
        child.stdin.write(json.dumps(plan))
        child.stdin.close()
        child.stdin = None
        return child

    def test_concurrent_allocation_rejects_competing_name_and_worktree(self):
        a, duplicate = self.plan("alpha", self.worktree_a), self.plan("alpha", self.worktree_a)
        ready, release = self.case / "create-ready", self.case / "create-release"
        child = self.start_creation(a, {"NATIVE_CLAUDE_PREPARE_READY": str(ready),
                                       "NATIVE_CLAUDE_PREPARE_RELEASE": str(release)})
        self.wait_file(ready, child)
        before = healing.snapshot(self.home)
        self.create(duplicate, "blocked")
        self.assertEqual(before, healing.snapshot(self.home))
        self.assertFalse(Path(duplicate["destination"]).exists())
        self.assertEqual(self.plan("alpha", self.worktree_a), a)
        release.touch()
        output, error = child.communicate(timeout=40)
        self.assertEqual(child.returncode, 0, error)
        self.assertEqual(json.loads(output)["descriptor"]["reference"], a["reference"])

    def allocation_barrier(self):
        root = self.case / "allocation-bin"
        script = """import os,pathlib,runpy,sys,time
target=sys.argv[1]
if pathlib.Path(target).name!='fmx-instances.py' or sys.argv[2:3]!=['create']:
    os.execv(sys.executable,[sys.executable,*sys.argv[1:]])
original=pathlib.Path.mkdir
def create(path,*args,**kwargs):
    result=original(path,*args,**kwargs)
    if path.name=='allocation':
        pathlib.Path(os.environ['ALLOCATION_READY']).touch()
        while not pathlib.Path(os.environ['ALLOCATION_RELEASE']).exists(): time.sleep(0.02)
    return result
pathlib.Path.mkdir=create
sys.path.insert(0,str(pathlib.Path(target).parent))
sys.argv=sys.argv[1:]
runpy.run_path(target,run_name='__main__')
"""
        healing.write(root / "python3", "#!" + sys.executable + "\n" + script, 0o755)
        return {"PATH": str(root) + ":" + healing.environment(self.case)["PATH"],
                "ALLOCATION_READY": str(self.case / "allocation-ready"),
                "ALLOCATION_RELEASE": str(self.case / "allocation-release")}

    def test_locked_source_and_namespace_recheck_preserve_existing_roots(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        b = self.plan("beta", self.worktree_b)
        collision = self.plan("collision", self.worktree_a, "pstack-workers")
        values = self.allocation_barrier()
        catalog_path = self.package / "catalog.json"
        original_catalog = catalog_path.read_bytes()
        for race in ("source", "namespace"):
            ready, release = Path(values["ALLOCATION_READY"]), Path(values["ALLOCATION_RELEASE"])
            ready.unlink(missing_ok=True)
            release.unlink(missing_ok=True)
            child = self.start_creation(b, values)
            self.wait_file(ready, child)
            if race == "source":
                changed = json.loads(original_catalog)
                changed["source"]["commit"] = "a" * 40
                catalog_path.write_text(json.dumps(changed))
            else:
                collision["taskIdPrefix"] = b["taskIdPrefix"]
                collision["approvalDigest"] = digest({key: value for key, value in collision.items() if key != "approvalDigest"})
                healing.write(self.registry / "locks/plans" / (collision["reference"]["instanceId"] + ".json"),
                              json.dumps({"schemaVersion": 1, "owner": "trellage-firstmate-instances-v1",
                                          "phase": "reserved", "plan": collision}))
            def state():
                return {name: item for name, item in healing.snapshot(self.home).items()
                        if "/locks/allocation" not in name}
            before = state()
            release.touch()
            output, error = child.communicate(timeout=30)
            self.assertTrue(child.returncode != 0 or json.loads(output)["state"] == "blocked", (output, error))
            self.assertEqual(before, state())
            self.assertFalse(Path(b["destination"]).exists())
            self.assertFalse((self.registry / "locks/allocation").exists())
            catalog_path.write_bytes(original_catalog)

    def test_shared_contract_fixtures_and_foreign_creation_destination(self):
        fixture = REPO / "packages/trellage-guide-core/test/fixtures/firstmate-instances-v1.json"
        values = json.loads(fixture.read_text())
        script = """import fs from 'node:fs';const core=await import(process.argv[1]),v=JSON.parse(fs.readFileSync(process.argv[2]));
for(const key of ['descriptor','legacyMissingIdentity']) core.parseFirstmateInstanceDescriptorV1(v[key]);
for(const key of ['list','listLastPage','listStaleCursor']) core.parseFirstmateInstanceListResultV1(v[key]);
for(const key of ['resolve','resolveBlocked']) core.parseFirstmateInstanceResolveResultV1(v[key]);
for(const key of ['plan','planBlocked']) core.parseFirstmateInstancePlanResultV1(v[key]);
for(const key of ['create','createBlocked','createIncomplete']) core.parseFirstmateInstanceCreateResultV1(v[key],v.plan.plan);
for(const key of ['controlContext','legacyControlContext']) core.parseFirstmateInstanceControlContextV1(v[key]);
console.log(JSON.stringify([core.firstmateWorktreeGenerationDigest(v.controlContext.entryWorktree.generation),
core.firstmateWorktreeBindingDigest(v.controlContext.entryWorktree),core.firstmateRuntimeVariantDigest(v.plan.plan.runtimeRequirements),
core.firstmateInstanceCreationPlanDigest(v.plan.plan)]));"""
        result = self.command([*BUN_EVAL, script, CORE, fixture])
        self.assertEqual(result.returncode, 0, result.stderr)
        plan, context = values["plan"]["plan"], values["controlContext"]
        expected = [digest(context["entryWorktree"]["generation"]), digest(context["entryWorktree"]),
                    digest(plan["runtimeRequirements"]), digest({key: value for key, value in plan.items() if key != "approvalDigest"})]
        self.assertEqual(json.loads(result.stdout), expected)
        before = healing.snapshot(self.home)
        refused = self.run_fmx("instances", "create", "default", "--json", "--approve-creation", plan["approvalDigest"], data=plan)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("HOME", refused.stderr)
        self.assertEqual(before, healing.snapshot(self.home))

    def test_normal_commits_keep_binding_and_unsafe_descriptor_does_not_rebind(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        healing.write(self.worktree_a / "next.txt", "ordinary commit\n")
        self.git("-C", str(self.worktree_a), "add", "next.txt")
        self.git("-C", str(self.worktree_a), "-c", "user.email=fixture@example.invalid", "-c", "user.name=fixture",
                 "commit", "-qm", "next")
        matched = self.json_result(self.run_fmx("instances", "resolve", "default", "--worktree", str(self.worktree_a), "--json"), "matched")
        self.assertEqual(matched["worktree"], a["worktree"])
        root = Path(a["destination"])
        path, saved = root / "instance.json", root / "original.json"
        path.rename(saved)
        path.symlink_to(saved)
        before = healing.snapshot(self.home)
        self.assertNotEqual(self.selected("prepare", a, "--json", "--expected-source-revision", healing.REVISION).returncode, 0)
        self.assertEqual(before, healing.snapshot(self.home))
        path.unlink()
        saved.rename(path)
        record = json.loads(path.read_text())
        record["reference"]["instanceId"] = str(uuid.uuid4())
        path.write_text(json.dumps(record))
        before = healing.snapshot(self.home)
        self.assertNotEqual(self.selected("repair", a).returncode, 0)
        self.assertEqual(before, healing.snapshot(self.home))

    def pinned_instance(self, plan):
        spec = importlib.util.spec_from_file_location("instance_pinned", SOURCE / "tests/pinned-contract.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        driver = object.__new__(module.Pinned)
        driver.package, driver.install = SOURCE, self.package
        driver.work = self.case / ("pinned-" + plan["name"])
        driver.work.mkdir()
        driver.profile = Path(plan["destination"])
        driver.runtime, driver.home = driver.profile / "runtime", driver.profile / "home"
        driver.prefix = plan["taskIdPrefix"]
        driver.external = driver.work / "external"
        driver.external.mkdir()
        driver.external_log, driver.launch_log = driver.work / "external.log", driver.work / "launch.log"
        driver.external_log.touch()
        driver.launch_log.touch()
        path = str(driver.external) + ":" + healing.environment(self.case)["PATH"]
        driver.env = healing.environment(self.case) | {
            "PATH": path, "FM_HOME": str(driver.home), "FM_ROOT_OVERRIDE": str(driver.runtime),
            "FMX_PROFILE": plan["reference"]["profile"], "FMX_INSTANCE_ID": plan["reference"]["instanceId"],
            "FMX_PROFILE_ROOT": str(driver.profile), "FMX_TASK_ID_PREFIX": driver.prefix,
            "FMX_WORKER_LAUNCHER": str(self.package / "lib/fmx-worker"), "FMX_WORKER_HOME": str(self.home),
            "FMX_WORKER_BASH": str(self.case / "bin/bash"), "FMX_WORKER_PATH": path,
            "FMX_GH_CONFIG_DIR": str(self.home / ".config/gh"), "FMX_CAPTAIN_PANE_ID": "",
            "FM_BACKEND": "tmux", "FM_SPAWN_NO_GUARD": "1", "TMUX": "other-session,1,0",
            "FM_TEST_EXTERNAL_LOG": str(driver.external_log), "FM_TEST_LAUNCH_LOG": str(driver.launch_log),
            "FM_TEST_ALLOWLIST_LOG": str(driver.work / "allowlist.log"),
            "FM_TEST_TASKS_STATE": str(driver.work / "tasks-state"),
            "FM_TEST_TMUX_SESSIONS": str(self.case / "tmux-sessions"),
            "FM_TEST_TMUX_WINDOWS": str(driver.work / "tmux-windows"),
        }
        Path(driver.env["FM_TEST_TASKS_STATE"]).mkdir()
        Path(driver.env["FM_TEST_TMUX_SESSIONS"]).mkdir(exist_ok=True)
        Path(driver.env["FM_TEST_TMUX_WINDOWS"]).mkdir()
        if plan["reference"]["profile"] == "pstack-workers":
            driver.env["FMX_WORKER_POLICY_FILE"] = str(driver.profile / "policy/worker-policy.md")
        driver.make_external_tools()
        module.executable(driver.external / "git",
                          'if [[ "${1-}" == -C && "${2-}" == ' + shlex.quote(str(driver.runtime)) +
                          ' && "${3-}" == rev-parse && "${4-}" == HEAD ]]; then printf "%s\\n" ' + healing.REVISION +
                          '; else exec ' + shlex.quote(REAL_GIT) + ' "$@"; fi\n')
        tmux = driver.external / "tmux"
        text = tmux.read_text()
        hook = r'''
case "$1" in
  has-session) test -f "$FM_TEST_TMUX_SESSIONS/${3#=}" ; exit $? ;;
  new-session)
    printf 'FMX_INSTANCE_ID=%s\nFMX_PROFILE_ROOT=%s\n' "$FMX_INSTANCE_ID" "$FMX_PROFILE_ROOT" \
      >"$FM_TEST_TMUX_SESSIONS/$4"; exit 0 ;;
  show-environment)
    grep "^$4=" "$FM_TEST_TMUX_SESSIONS/${3#=}"; exit $? ;;
  new-window)
    previous=''
    for value in "$@"; do
      if [[ "$previous" == -n ]]; then window=$value; fi
      previous=$value
    done
    jq -n --arg name "$window" '{name:$name,options:{}}' >"$FM_TEST_TMUX_WINDOWS/@42"
    if [[ -n "${FM_TEST_CONTROL_STATE:-}" ]]; then printf 'dead\n' >"$FM_TEST_CONTROL_STATE"; fi
    printf '@42\n'; exit 0 ;;
  set-window-option)
    jq --arg key "$4" --arg value "$5" '.options[$key]=$value' "$FM_TEST_TMUX_WINDOWS/$3" \
      >"$FM_TEST_TMUX_WINDOWS/update"
    mv "$FM_TEST_TMUX_WINDOWS/update" "$FM_TEST_TMUX_WINDOWS/$3"; exit 0 ;;
  show-window-options)
    jq -er --arg key "$5" '.options[$key]' "$FM_TEST_TMUX_WINDOWS/$4"; exit $? ;;
  list-panes)
    if [[ -n "${FM_TEST_CONTROL_STATE:-}" && "$(cat "$FM_TEST_CONTROL_STATE")" == absent ]]; then exit 1; fi
    window=$(jq -er .name "$FM_TEST_TMUX_WINDOWS/@42")
    case "$3" in
      '@42'|'%43') ;;
      "=firstmate-$FMX_TASK_ID_PREFIX:=$window") ;;
      *) exit 1 ;;
    esac
    printf 'firstmate-%s\t%s\t@42\t%%43\n' "$FMX_TASK_ID_PREFIX" "$window"; exit 0 ;;
esac
if [[ "$1" == send-keys ]]; then
  previous=''
  for value in "$@"; do
    if [[ "$previous" == -l && "$value" == *fmx-worker* ]]; then
      printf '%s\n' "$value" >"$FM_TEST_TMUX_WINDOWS/queued"
    fi
    previous=$value
  done
  if [[ "$previous" == Enter && -f "$FM_TEST_TMUX_WINDOWS/queued" && "${FM_TEST_DELAY_WORKER:-}" != 1 ]]; then
    /bin/sh -c "$(cat "$FM_TEST_TMUX_WINDOWS/queued")" >/dev/null
    rm "$FM_TEST_TMUX_WINDOWS/queued"
  fi
fi
'''
        tmux.write_text(text.replace('if [[ -n "${FM_TEST_CONTROL_STATE:-}" ]]', hook + '\nif [[ -n "${FM_TEST_CONTROL_STATE:-}" ]]', 1))
        return driver

    def test_real_named_spawn_worker_control_and_terminal_namespaces(self):
        a, b = self.plan("alpha", self.worktree_a), self.plan("beta", self.worktree_b)
        self.create(a)
        self.create(b)
        other_before = healing.snapshot(Path(b["destination"]))
        first = self.pinned_instance(a)
        first.originless("ship")
        self.assertEqual(other_before, healing.snapshot(Path(b["destination"])))
        second = self.pinned_instance(b)
        before_a = healing.snapshot(Path(a["destination"]))
        second.originless("ship")
        self.assertEqual(before_a, healing.snapshot(Path(a["destination"])))
        for driver, plan in ((first, a), (second, b)):
            task = driver.prefix + "-originless-ship"
            meta_path = driver.home / "state" / (task + ".meta")
            metadata = dict(line.split("=", 1) for line in meta_path.read_text().splitlines() if "=" in line)
            self.assertEqual(metadata["window"], "firstmate-" + driver.prefix + ":fm-" + task)
            self.assertEqual(metadata["fmx_instance_id"], plan["reference"]["instanceId"])
            self.assertEqual(metadata["fmx_profile_root"], plan["destination"])
            worker_path = driver.profile / "workers" / task / "worker.json"
            worker = json.loads(worker_path.read_text())
            self.assertEqual(worker["instanceId"], plan["reference"]["instanceId"])
            self.assertEqual(worker["profileRoot"], plan["destination"])
            state = driver.work / "terminal-state"
            state.write_text("alive\n")
            driver.env.update(FM_TEST_CONTROL_STATE=str(state), FM_TEST_CONTROL_TASK=task,
                              FM_CONTROL_POLL="0.01", FM_CONTROL_SETTLE_WAIT="0",
                              FM_CONTROL_EXIT_WAIT="0.2", FM_CONTROL_LAUNCH_WAIT="0.2")
            driver.launch_log.write_text("")
            driver.entry("fm-control.sh", task, "relaunch", "--model", "default", "--note", "Keep the same instance and task worktree.")
            self.assertEqual(state.read_text().strip(), "alive")
            self.assertIn("FMX_INSTANCE_ID='" + plan["reference"]["instanceId"] + "'", driver.launch_log.read_text())
            worker["instanceId"] = (b if plan is a else a)["reference"]["instanceId"]
            worker_path.write_text(json.dumps(worker))
            driver.refused("fm-control.sh", task, "relaunch")
            driver.refused("fm-control.sh", task, "interrupt")
            driver.refused("fm-spawn.sh", (b if plan is a else a)["taskIdPrefix"] + "-foreign", "project")
            driver.refused("fm-spawn.sh", driver.prefix + "-" + "x" * 56, "project")
            driver.refused("fm-spawn.sh", driver.prefix + "-remote", "host:project", "--secondmate")
        self.assertEqual(set(path.name for path in (self.case / "tmux-sessions").iterdir()),
                         {"firstmate-" + plan["taskIdPrefix"] for plan in (a, b)})

    def test_named_pstack_worker_retains_policy_and_source_worker_boundary(self):
        plan = self.plan("pstack", self.worktree_a, "pstack-workers")
        self.create(plan)
        driver = self.pinned_instance(plan)
        driver.originless("scout")
        worker = driver.profile / "workers" / (driver.prefix + "-originless-scout") / "worker.json"
        self.assertEqual(json.loads(worker.read_text())["instanceId"], plan["reference"]["instanceId"])
        self.assertFalse((self.package / "lib/__pycache__").exists())

    def shared_writer(self, label):
        ready = self.case / (label + "-ready")
        release = self.case / (label + "-release")
        directory = self.case / (label + "-bin")
        body = """import json,os,pathlib,signal,sys,time
if 'fetch' in sys.argv:
    signal.signal(signal.SIGTERM,signal.SIG_IGN)
    child=os.fork()
    if child==0:
        while not pathlib.Path(os.environ['WRITER_RELEASE']).exists(): time.sleep(0.02)
        pathlib.Path(os.environ['WRITER_LATE_ACTION']).touch()
        os._exit(0)
    pathlib.Path(os.environ['WRITER_READY']).write_text(json.dumps([os.getpid(),child]))
    while not pathlib.Path(os.environ['WRITER_RELEASE']).exists(): time.sleep(0.02)
os.execv(os.environ['WRITER_REAL_GIT'],[os.environ['WRITER_REAL_GIT'],*sys.argv[1:]])
"""
        healing.write(directory / "git", "#!" + sys.executable + "\n" + body, 0o755)
        options = {"catalog": {"sources": {"fixture": {"id": "fixture", "repository": str(self.project),
                    "select": ["fixture"], "adapter": "omp-native", "alwaysOn": False, "allowExecutables": False}},
                    "bundles": {"test": ["fixture"]}}, "bundleIds": ["test"],
                    "cache": str(self.runtime.parent / "common/skills")}
        code = "const m=await import(process.argv[1]);await m.updateNative(JSON.parse(process.argv[2]));"
        values = healing.environment(self.case) | {
            "PATH": str(directory) + ":" + healing.environment(self.case)["PATH"], "WRITER_REAL_GIT": REAL_GIT,
            "WRITER_READY": str(ready), "WRITER_RELEASE": str(release), "WRITER_LATE_ACTION": str(self.case / "late-action"),
        }
        child = subprocess.Popen([*BUN_EVAL, code,
                                  (REPO / "scripts/floating-skills.ts").as_uri(), json.dumps(options)],
                                 env=values, cwd=self.case, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(child)
        self.wait_file(ready, child)
        return child, json.loads(ready.read_text()), release

    def assert_owned_processes_stopped(self, pids):
        for pid in pids:
            until = time.monotonic() + 5
            while True:
                result = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, check=False)
                if result.returncode or not result.stdout.strip() or result.stdout.strip().startswith("Z"):
                    break
                self.assertLess(time.monotonic(), until, "owned child survived cancellation")
                time.sleep(0.03)

    def test_shared_writer_parent_term_cleans_descendants_and_owned_stage(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        before = healing.snapshot(self.home)
        child, descendants, release = self.shared_writer("cancel")
        started = time.monotonic()
        child.terminate()
        output, error = child.communicate(timeout=10)
        self.assertNotEqual(child.returncode, 0, (output, error))
        self.assertLess(time.monotonic() - started, 10)
        self.assert_owned_processes_stopped(descendants)
        release.touch()
        self.assertFalse((self.case / "late-action").exists())
        self.assertEqual(before, healing.snapshot(self.home))

    def test_dead_lease_helper_cannot_allow_a_live_writer_to_publish_without_admission(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        before = healing.snapshot(self.home)
        child, descendants, release = self.shared_writer("holder")
        process_list = subprocess.check_output(["ps", "-o", "pid=,ppid=", "-g", str(child.pid)], text=True)
        helpers = [int(pid) for pid, parent in (line.split() for line in process_list.splitlines()) if int(parent) == child.pid]
        self.assertEqual(len(helpers), 1, process_list)
        os.kill(child.pid, signal.SIGSTOP)
        try:
            os.kill(helpers[0], signal.SIGKILL)
            lock = self.runtime.parent / ".fmx-install.lock"
            self.assertEqual((lock / "pid").read_text().strip(), str(child.pid))
            held = healing.snapshot(self.home)
            refused = self.command([sys.executable, self.package / "lib/fmx-registry.py", "lease", "--", "/usr/bin/true"])
            self.assertNotEqual(refused.returncode, 0)
            self.assertEqual(held, healing.snapshot(self.home))
        finally:
            os.kill(child.pid, signal.SIGCONT)
        child.communicate(timeout=10)
        self.assertNotEqual(child.returncode, 0)
        self.assert_owned_processes_stopped(descendants)
        release.touch()
        self.assertFalse((self.case / "late-action").exists())
        recovered = self.command([sys.executable, self.package / "lib/fmx-registry.py", "lease", "--", "/usr/bin/true"])
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assertEqual(before, healing.snapshot(self.home))

    def test_command_lease_guard_death_keeps_actual_writer_excluded(self):
        ready, release = self.case / "command-ready", self.case / "command-release"
        script = """import os,pathlib,subprocess,sys,time
code='import pathlib,sys,time;pathlib.Path(sys.argv[1]).touch()\\nwhile not pathlib.Path(sys.argv[2]).exists(): time.sleep(0.02)'
delegated=sys.argv[1]+'.delegated'
child=subprocess.Popen([sys.executable,sys.argv[3],'lease','--',sys.executable,'-c',code,delegated,sys.argv[2]],
 pass_fds=(int(os.environ['FMX_SHARED_LEASE_FD']),))
while not pathlib.Path(delegated).exists():
 if child.poll() is not None: sys.exit(child.returncode or 1)
 time.sleep(0.02)
pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))
sys.exit(child.wait())
"""
        argv = [sys.executable, str(self.package / "lib/fmx-registry.py"), "lease", "--",
                sys.executable, "-c", script, str(ready), str(release), str(self.package / "lib/fmx-registry.py")]
        guard = subprocess.Popen(argv, env=healing.environment(self.case), cwd=self.case,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(guard)
        self.wait_file(ready, guard)
        writer = int(ready.read_text())
        try:
            lock = self.runtime.parent / ".fmx-install.lock"
            self.assertEqual(int((lock / "pid").read_text()), writer)
            os.kill(guard.pid, signal.SIGKILL)
            guard.wait(timeout=10)
            os.kill(writer, 0)
            before = healing.snapshot(self.home)
            denied = self.command([sys.executable, self.package / "lib/fmx-registry.py", "lease", "--", "/usr/bin/true"])
            self.assertNotEqual(denied.returncode, 0)
            self.assertEqual(before, healing.snapshot(self.home))
        finally:
            release.touch()
        self.assert_owned_processes_stopped([writer])
        recovered = self.command([sys.executable, self.package / "lib/fmx-registry.py", "lease", "--", "/usr/bin/true"])
        self.assertEqual(recovered.returncode, 0, recovered.stderr)

    def test_command_lease_guard_death_before_handoff_cancels_writer(self):
        ready, effect = self.case / "launch-ready", self.case / "launch-effect"
        script = """import importlib.util,pathlib,subprocess,sys,time
spec=importlib.util.spec_from_file_location('registry',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
original=subprocess.Popen
def launch(*args,**kwargs):
 child=original(*args,**kwargs)
 pathlib.Path(sys.argv[2]).write_text(str(child.pid))
 while True: time.sleep(0.02)
subprocess.Popen=launch
m.run_lease_command(['--',sys.executable,'-c','import pathlib,sys;pathlib.Path(sys.argv[1]).touch()',sys.argv[3]])
"""
        guard = subprocess.Popen([sys.executable, "-c", script, str(self.package / "lib/fmx-registry.py"),
                                  str(ready), str(effect)], env=healing.environment(self.case), cwd=self.case,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(guard)
        self.wait_file(ready, guard)
        writer = int(ready.read_text())
        os.kill(guard.pid, signal.SIGKILL)
        guard.wait(timeout=10)
        self.assert_owned_processes_stopped([writer])
        self.assertFalse(effect.exists())
        recovered = self.command([sys.executable, self.package / "lib/fmx-registry.py", "lease", "--", "/usr/bin/true"])
        self.assertEqual(recovered.returncode, 0, recovered.stderr)

    def test_idle_real_installer_preserves_registry_and_installed_instance_routing(self):
        a = self.plan("alpha", self.worktree_a)
        self.create(a)
        common = self.package.parent / "trellage-claude-common"
        shutil.copyfile(SOURCE / "install.sh", self.package / "install.sh")
        shutil.copyfile(REPO / "prototypes/trellage-claude-common/native-skills.ts", common / "native-skills.ts")
        shutil.copyfile(REPO / "scripts/trellage-session-bridge.py", self.case / "scripts/trellage-session-bridge.py")
        (self.case / "scripts/install-floating-skills-runtime.sh").chmod(0o755)
        before = healing.snapshot(self.registry)
        installed = self.command([self.case / "bin/bash", self.package / "install.sh"])
        self.assertEqual(installed.returncode, 0, installed.stderr)
        self.assertEqual(before, healing.snapshot(self.registry))
        result = self.json_result(self.selected("inventory", a, "--json", context=False, installed=True))
        self.assertTrue(result["overlay"]["verified"])
        self.assertEqual(result["fleet"]["identity"]["instanceId"], a["reference"]["instanceId"])
        prepared = self.json_result(self.selected("prepare", a, "--json", "--expected-source-revision", healing.REVISION, installed=True))
        self.assertEqual(prepared["fleet"]["preparation"]["state"], "ready", prepared)
        self.assertEqual(self.plan("alpha", self.worktree_a), a)

    def test_terminal_collision_refusal_and_exact_herdr_parent_identity(self):
        plan = self.plan("alpha", self.worktree_a)
        self.create(plan)
        driver = self.pinned_instance(plan)
        session = self.case / "tmux-sessions" / ("firstmate-" + driver.prefix)
        session.write_text("FMX_INSTANCE_ID=foreign\nFMX_PROFILE_ROOT=foreign\n")
        code = 'source "$1/bin/fm-backend.sh"; fm_backend_source tmux; fm_backend_tmux_container_ensure'
        refused = self.command([self.case / "bin/bash", "-c", code, "fixture", driver.runtime], driver.env)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("not owned", refused.stderr)
        self.assertEqual(session.read_text(), "FMX_INSTANCE_ID=foreign\nFMX_PROFILE_ROOT=foreign\n")
        herdr = """import json,os,sys
args=sys.argv[1:]; pane=os.environ.get('HERDR_PANE_ID','captain:p1'); workspace='owned-space'
if args[:2]==['session','list']: result={'sessions':[{'name':'placement','running':True,'socket_path':os.environ['HERDR_SOCKET_PATH']}]}
elif args[:2]==['pane','get']: result={'result':{'pane':{'pane_id':pane,'tab_id':'owned-tab','workspace_id':workspace}}}
elif args[:2]==['tab','get']: result={'result':{'tab':{'tab_id':'owned-tab','workspace_id':os.environ.get('WRONG_WORKSPACE',workspace)}}}
elif args[:2]==['workspace','list']: result={'result':{'workspaces':[{'workspace_id':'foreign-space','label':'firstmate-'+os.environ['FMX_TASK_ID_PREFIX']},{'workspace_id':workspace,'label':'firstmate-'+os.environ['FMX_TASK_ID_PREFIX']}]}}
else: raise SystemExit('unexpected terminal mutation')
print(json.dumps(result))
"""
        healing.write(driver.external / "herdr", "#!" + sys.executable + "\n" + herdr, 0o755)
        values = driver.env | {"HERDR_ENV": "1", "HERDR_PANE_ID": "captain:p1", "HERDR_SESSION": "placement",
                               "HERDR_SOCKET_PATH": str(self.case / "herdr.sock")}
        code = 'source "$1/bin/fm-backend.sh"; fm_backend_source herdr; fm_backend_herdr_workspace_ensure placement "$PWD" launcher-home'
        before = healing.snapshot(self.home)
        selected = self.command([self.case / "bin/bash", "-c", code, "fixture", driver.runtime], values)
        self.assertEqual(selected.returncode, 0, selected.stderr)
        self.assertEqual(selected.stdout, "owned-space")
        wrong = self.command([self.case / "bin/bash", "-c", code, "fixture", driver.runtime], values | {"WRONG_WORKSPACE": "foreign-space"})
        self.assertNotEqual(wrong.returncode, 0)
        no_parent = self.command([self.case / "bin/bash", "-c", code, "fixture", driver.runtime], values | {"HERDR_PANE_ID": ""})
        self.assertNotEqual(no_parent.returncode, 0)
        self.assertIn("label adoption is disabled", no_parent.stderr)
        self.assertEqual(before, healing.snapshot(self.home))

    def test_existing_named_terminal_refuses_recreated_foreign_session(self):
        plan = self.plan("alpha", self.worktree_a)
        self.create(plan)
        driver = self.pinned_instance(plan)
        driver.originless("ship")
        task = driver.prefix + "-originless-ship"
        state = driver.work / "terminal-state"
        state.write_text("alive\n")
        driver.env.update(FM_TEST_CONTROL_STATE=str(state), FM_TEST_CONTROL_TASK=task,
                          FM_CONTROL_POLL="0.01", FM_CONTROL_SETTLE_WAIT="0",
                          FM_CONTROL_EXIT_WAIT="0.2", FM_CONTROL_LAUNCH_WAIT="0.2")
        session = self.case / "tmux-sessions" / ("firstmate-" + driver.prefix)
        session.write_text("FMX_INSTANCE_ID=foreign\nFMX_PROFILE_ROOT=foreign\n")
        send = 'source "$1/bin/fm-backend.sh"; target=$(fm_backend_resolve_selector "$2" "$FM_HOME/state") || exit; fm_backend_send_key tmux "$target" C-c'
        commands = [[self.case / "bin/bash", "-c", send, "fixture", driver.runtime, task]]
        commands += [[driver.runtime / "bin/fm-control.sh", task, action]
                     for action in ("interrupt", "exit", "relaunch")]
        for command in commands:
            with self.subTest(command=command):
                state.write_text("alive\n")
                driver.external_log.write_text("")
                before = healing.snapshot(driver.home)
                result = self.command(command, driver.env)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                side_effects = [line for line in driver.external_log.read_text().splitlines()
                                if line.startswith(("tmux send-keys", "tmux kill-window", "tmux new-window"))]
                self.assertEqual(side_effects, [])
                self.assertEqual(state.read_text(), "alive\n")
                self.assertEqual(before, healing.snapshot(driver.home))

    def test_queued_spawn_keeps_exclusion_until_worker_owns_startup(self):
        plan = self.plan("alpha", self.worktree_a)
        self.create(plan)
        driver = self.pinned_instance(plan)
        task = driver.prefix + "-delayed"
        project, worktree = driver.create_worktree(task)
        driver.env["FM_TEST_WORKTREE"] = str(worktree)
        driver.env["FMX_WORKER_START_WAIT_SECONDS"] = "8"
        driver.entry("fm-brief.sh", task, project, "--mode", "no-mistakes")
        brief = driver.home / "data" / task / "brief.md"
        brief.write_text(brief.read_text().replace("{TASK}", "Wait for the owned worker.")
                         .replace("{FIRSTMATE_SPEC}", "Keep maintenance excluded during backend delivery."))
        ready = driver.work / "backend-queued"
        tmux = driver.external / "tmux"
        hook = r'''
if [[ "$1" == send-keys && "$*" == *" Enter" ]] && grep -q fmx-worker "$FM_TEST_LAUNCH_LOG"; then
  : >"$FM_TEST_BACKEND_QUEUED"
fi
'''
        tmux.write_text(tmux.read_text().replace('case "$1" in', hook + '\ncase "$1" in', 1))
        values = driver.env | {"FM_TEST_BACKEND_QUEUED": str(ready), "FM_TEST_DELAY_WORKER": "1"}
        child = subprocess.Popen([str(driver.runtime / "bin/fm-spawn.sh"), task, str(project),
                                  "--mode", "no-mistakes", "--yolo", "off"],
                                 env=values, cwd=driver.runtime, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(child)
        self.wait_file(ready, child)
        until = time.monotonic() + 2
        while time.monotonic() < until and child.poll() is None:
            time.sleep(0.03)
        shared = self.command([sys.executable, self.package / "lib/fmx-registry.py", "lease", "--", "/usr/bin/true"])
        self.assertNotEqual(shared.returncode, 0, "queued delivery released the shared-writer exclusion")
        repair = self.selected("repair", plan)
        self.assertNotEqual(repair.returncode, 0, "queued delivery admitted instance repair")
        self.assertIsNone(child.poll(), "backend ACK was reported as a completed worker handoff")
        launch = driver.launch_log.read_text().strip()
        worker = subprocess.Popen(["/bin/sh", "-c", launch], env=driver.env, cwd=worktree,
                                  stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, start_new_session=True)
        self.children.append(worker)
        output, error = worker.communicate(timeout=20)
        self.assertEqual(worker.returncode, 0, output + error)
        output, error = child.communicate(timeout=20)
        self.assertEqual(child.returncode, 0, output + error)
        self.assertIn("spawned " + task, output)
        self.assertEqual(list((driver.profile / "locks/operations").iterdir()), [])

    def test_direct_task_control_holds_shared_exclusion_without_a_supervisor(self):
        plan = self.plan("alpha", self.worktree_a)
        self.create(plan)
        driver = self.pinned_instance(plan)
        driver.originless("ship")
        task = driver.prefix + "-originless-ship"
        state, ready, release = driver.work / "terminal-state", driver.work / "control-ready", driver.work / "control-release"
        state.write_text("alive\n")
        values = driver.env | {"FM_TEST_CONTROL_STATE": str(state), "FM_TEST_CONTROL_TASK": task,
                              "FM_CONTROL_POLL": "0.01", "FM_CONTROL_SETTLE_WAIT": "0",
                              "FM_CONTROL_EXIT_WAIT": "0.2", "FM_CONTROL_LAUNCH_WAIT": "0.2",
                              "FM_TEST_ACTIVITY_READY": str(ready), "FM_TEST_ACTIVITY_RELEASE": str(release)}
        tmux = driver.external / "tmux"
        original = tmux.read_text()
        barrier = r'''
if [[ "$*" == *"/exit"* ]]; then
  : >"$FM_TEST_ACTIVITY_READY"
  while [[ ! -f "$FM_TEST_ACTIVITY_RELEASE" ]]; do /bin/sleep 0.02; done
fi
'''
        tmux.write_text(original.replace('printf \'%s\\n\' "tmux $*"', barrier + '\nprintf \'%s\\n\' "tmux $*"', 1))
        child = subprocess.Popen([str(driver.runtime / "bin/fm-control.sh"), task, "relaunch", "--note", "Preserve this task."],
                                 env=values, cwd=driver.runtime, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.children.append(child)
        self.wait_file(ready, child)
        before = healing.snapshot(self.home)
        refused = self.command([sys.executable, self.package / "lib/fmx-registry.py", "lease", "--", "/usr/bin/true"])
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("task startup or control is active", refused.stderr)
        self.assertEqual(before, healing.snapshot(self.home))
        release.touch()
        output, error = child.communicate(timeout=30)
        self.assertEqual(child.returncode, 0, (output, error))
        allowed = self.command([sys.executable, self.package / "lib/fmx-registry.py", "lease", "--", "/usr/bin/true"])
        self.assertEqual(allowed.returncode, 0, allowed.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)
