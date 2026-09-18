#!/usr/bin/env python3
"""Bounded named-instance discovery and approved, same-UUID creation."""

from __future__ import annotations

import argparse
import importlib
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
registry = importlib.import_module("fmx-registry")
control = importlib.import_module("fmx-control")
overlay = importlib.import_module("fmx-overlay")
PACKAGE = Path(__file__).resolve().parent.parent


def requirements():
    catalog = registry.read_json(PACKAGE / "catalog.json")
    revision = catalog["source"]["commit"]
    return overlay.variant_requirement(PACKAGE / "overlay" / revision / "manifest.json",
                                       PACKAGE / "instance-overlay" / revision / "manifest.json", revision)


def verify_runtime(root):
    revision = requirements()["sourceRevision"]
    try:
        overlay.verify_variant(root / "runtime", PACKAGE / "overlay" / revision / "manifest.json",
                               PACKAGE / "instance-overlay" / revision / "manifest.json", revision)
        return "verified"
    except (OSError, ValueError, overlay.OverlayError, subprocess.SubprocessError):
        return "drift" if (root / "runtime").exists() else "missing"


def notice(code, message):
    return {"code": code, "message": control.wire_limit(" ".join(control.diagnostic(message).split()), 2000)}


def descriptor_from_plan(plan, state="creating"):
    return {"schemaVersion": 1, "profile": plan["reference"]["profile"], "mode": "named", "name": plan["name"],
            "reference": plan["reference"], "root": plan["destination"], "taskIdPrefix": plan["taskIdPrefix"],
            "creationState": state, "worktree": {"status": "bound", "evidence": plan["worktree"]},
            "runtime": {"state": "missing", "required": plan["runtimeRequirements"]},
            "diagnostics": [notice("creation-incomplete", "Reconcile this UUID with its original approved plan.")]}


def describe(row):
    root = Path(row["plan"]["destination"])
    descriptor = (registry.named_descriptor(root) if (root / "instance.json").exists()
                  else descriptor_from_plan(row["plan"], "incomplete"))
    descriptor["diagnostics"] = []
    identity = root / "receipts/instance.json"
    if row["phase"] == "published" and not identity.exists():
        descriptor["creationState"] = "missing-identity"
        descriptor["diagnostics"].append(notice("missing-identity", "Published identity is missing; restore the original UUID, never recreate this instance."))
    elif row["phase"] != "published":
        descriptor["creationState"] = "incomplete"
        descriptor["diagnostics"].append(notice("creation-incomplete", "Creation is incomplete; use the original approved plan and UUID."))
    status = registry.binding_status(descriptor["worktree"]["evidence"])
    descriptor["worktree"]["status"] = status
    if status != "bound":
        code = {"missing": "worktree-missing", "moved": "worktree-moved", "replaced": "worktree-replaced"}.get(status, "ambiguous-worktree")
        descriptor["diagnostics"].append(notice(code, "The bound worktree must be inspected; no automatic rebinding is permitted."))
    runtime = verify_runtime(root)
    descriptor["runtime"]["state"] = runtime
    if runtime != "verified":
        descriptor["diagnostics"].append(notice("runtime-missing" if runtime == "missing" else "runtime-drift",
                                               "The required named runtime variant is not verified."))
    return descriptor


def legacy_descriptor(profile):
    root = registry.profiles_root() / profile
    ref = None
    if (root / "receipts/instance.json").exists():
        if registry.read(root / registry.MARKER).decode().strip() != registry.OWNER:
            registry.refuse("legacy root is unowned")
        value = registry.identity_record(root, profile)
        ref = {"schemaVersion": 1, "profile": profile, "mode": "legacy", "instanceId": value["instanceId"]}
    return {"schemaVersion": 1, "profile": profile, "mode": "legacy", "name": "legacy",
            "reference": ref, "root": str(root), "taskIdPrefix": registry.PROFILES[profile],
            "creationState": "published" if ref else "missing-identity",
            "worktree": {"status": "unbound", "evidence": None}, "runtime": {"state": "legacy"},
            "diagnostics": [] if ref else [notice("missing-identity", "Legacy identity is missing; inspect it without allocating a UUID.")]}


def list_instances(profile, limit, cursor):
    if not 1 <= limit <= 32:
        registry.refuse("--limit must be 1 through 32")
    base = {"schemaVersion": 1, "profile": profile, "diagnostics": []}
    try:
        rows = registry.registry_entries()
        descriptors = [legacy_descriptor(profile)]
        descriptors += [describe(row) for row in rows if row["plan"]["reference"]["profile"] == profile]
        snapshot = registry.digest({"schemaVersion": 1, "profile": profile, "instances": descriptors})
        offset = 0
        if cursor:
            import re
            match = re.fullmatch(r"v1\.([a-f0-9]{64})\.(0|[1-9][0-9]{0,6})", cursor)
            if not match:
                registry.refuse("invalid instance page cursor")
            offset = int(match[2])
            if match[1] != snapshot or offset >= len(descriptors):
                return {**base, "state": "stale-cursor", "instances": [], "page": None,
                        "diagnostics": [notice("stale-cursor", "Registry evidence changed; restart without a cursor.")]}
        return bounded_page(base, descriptors, snapshot, offset, limit)
    except registry.Refusal as error:
        return {**base, "state": "blocked", "instances": [], "page": None, "diagnostics": [notice(error.code, error)]}


def bounded_page(base, descriptors, snapshot, offset, limit):
    page = descriptors[offset:offset + limit]
    while page:
        end = offset + len(page)
        result = {**base, "state": "page", "instances": page,
                  "page": {"snapshotDigest": snapshot, "offset": offset, "total": len(descriptors),
                           "nextCursor": f"v1.{snapshot}.{end}" if end < len(descriptors) else None}}
        if len(registry.canonical(result)) < registry.LIMIT:
            return result
        page.pop()
    registry.refuse("one instance descriptor exceeds the discovery envelope bound")


def matching_rows(profile, evidence, rows):
    return [row for row in rows if row["plan"]["reference"]["profile"] == profile
            and row["plan"]["worktree"]["generationDigest"] == evidence["generationDigest"]]


def resolve_worktree(profile, path):
    base = {"schemaVersion": 1, "profile": profile, "diagnostics": []}
    evidence = None
    try:
        evidence = registry.inspect_worktree(path)
        rows = matching_rows(profile, evidence, registry.registry_entries())
        if not rows:
            return {**base, "state": "not-found", "worktree": evidence, "descriptor": None}
        descriptor = describe(rows[0])
        if descriptor["worktree"]["status"] != "bound" or descriptor["worktree"]["evidence"] != evidence:
            registry.refuse("same generation has different locators; explicitly refresh the original instance", "worktree-moved")
        return {**base, "state": "matched", "worktree": evidence, "descriptor": descriptor}
    except (registry.Refusal, OSError) as error:
        return {**base, "state": "blocked", "worktree": evidence, "descriptor": None,
                "diagnostics": [notice(getattr(error, "code", "worktree-missing"), error)]}


def shared_sources():
    installed = (PACKAGE / "lib/native-claude").exists()
    native = PACKAGE / "lib/native-claude" if installed else PACKAGE.parent / "trellage-claude-common/native-claude"
    manager = (PACKAGE.parent / "common/floating-skills-runtime/scripts/floating-skills.ts" if installed
               else PACKAGE.parent.parent / "scripts/floating-skills.ts")
    return native, manager


def require_shared_support():
    installed = registry.home() / ".local/share/trellage/fmx"
    common = installed.parent / "common/floating-skills-runtime"
    if registry.read(installed / registry.MARKER).decode().strip() != registry.OWNER:
        registry.refuse("install the complete registry-aware Native/shared writer set while all fleets are idle", "upgrade-required")
    for relative in ("bin/fmx", "lib/fmx-registry.py", "lib/fmx-instances.py", "lib/fmx-prerequisites",
                     "lib/fmx-control.py", "lib/fmx-controls.py", "lib/fmx-worker", "lib/fmx-overlay.py", "catalog.json"):
        if registry.read(installed / relative, 1024 * 1024) != registry.read(PACKAGE / relative, 1024 * 1024):
            registry.refuse("installed Native writers differ; install the coherent candidate set while all fleets are idle", "upgrade-required")
    require_installed_overlays(installed)
    native, manager = shared_sources()
    installed_shape = (PACKAGE / "lib/native-claude").exists()
    native_skills = PACKAGE / "native-skills.ts" if installed_shape else native.parent / "native-skills.ts"
    bridge = (PACKAGE / "lib/trellage-session-bridge.py" if installed_shape
              else PACKAGE.parent.parent / "scripts/trellage-session-bridge.py")
    for source, target in ((native_skills, installed / "native-skills.ts"),
                           (bridge, installed / "lib/trellage-session-bridge.py")):
        if registry.read(source, 1024 * 1024) != registry.read(target, 1024 * 1024):
            registry.refuse("installed shared helpers differ from the candidate; complete the idle upgrade", "upgrade-required")
    expected = registry.read(native, 1024 * 1024)
    writers = list(installed.parent.glob("*/lib/native-claude")) + list(installed.parent.glob("*/native-claude"))
    if not writers or any(registry.read(path, 1024 * 1024) != expected for path in writers):
        registry.refuse("an installed shared-Claude writer is not registry-aware; upgrade all affected launchers while idle", "upgrade-required")
    if (registry.read(common / "scripts/floating-skills.ts", 1024 * 1024) != registry.read(manager, 1024 * 1024)
        or registry.read(common / "prototypes/trellage-firstmate-profiles/lib/fmx-registry.py", 1024 * 1024) != registry.read(PACKAGE / "lib/fmx-registry.py", 1024 * 1024)):
        registry.refuse("shared skills writer support is missing or differs; perform the complete idle upgrade", "upgrade-required")


def require_installed_overlays(installed):
    revision = requirements()["sourceRevision"]
    for layer in ("overlay", "instance-overlay"):
        source, target = PACKAGE / layer / revision, installed / layer / revision
        registry.safe(source, True)
        registry.safe(target, True)
        files = {path.name for path in source.iterdir()}
        if files != {path.name for path in target.iterdir()}:
            registry.refuse("installed runtime overlay inputs differ from the candidate", "upgrade-required")
        for name in files:
            if registry.read(source / name, 1024 * 1024) != registry.read(target / name, 1024 * 1024):
                registry.refuse("installed runtime overlay inputs differ from the candidate", "upgrade-required")


def require_bootstrap():
    try:
        require_shared_support()
    except (OSError, registry.Refusal) as error:
        registry.refuse("coherent installed shared-writer support is unavailable; upgrade the complete set while idle: "
                        + str(error), "upgrade-required")
    try:
        control.require_cached_skills()
        executable = shutil.which("claude")
        if executable is None or not Path(executable).resolve().is_file():
            registry.refuse("an existing Claude executable is required", "bootstrap-required")
    except (control.Failure, control.controls.Refusal) as error:
        registry.refuse("existing shared CLI and skills bootstrap is required; creation does not install it: " + str(error), "bootstrap-required")


def validate_plan_current(plan, revision, rows):
    if plan["reference"]["instanceId"] in registry.legacy_instance_ids():
        registry.refuse("creation UUID is already reserved by a legacy fleet", "stale-plan")
    if plan["sourceRevision"] != revision or plan["runtimeRequirements"] != requirements():
        registry.refuse("source or named runtime requirements changed", "source-mismatch")
    if registry.inspect_worktree(plan["worktree"]["locators"]["worktree"]) != plan["worktree"]:
        registry.refuse("approved worktree evidence changed", "stale-plan")
    for row in rows:
        validate_allocation_collision(plan, row["plan"])


def validate_allocation_collision(plan, other):
    if other["reference"]["instanceId"] == plan["reference"]["instanceId"]:
        if other != plan:
            registry.refuse("the same UUID already has another approved creation plan", "stale-plan")
        return
    same_profile = other["reference"]["profile"] == plan["reference"]["profile"]
    if same_profile and other["name"] == plan["name"]:
        registry.refuse("instance name is already reserved in this profile", "name-conflict")
    if same_profile and other["worktree"]["generationDigest"] == plan["worktree"]["generationDigest"]:
        registry.refuse("this profile/worktree already has a reserved instance", "worktree-conflict")
    if other["taskIdPrefix"] == plan["taskIdPrefix"]:
        registry.refuse("task namespace is already reserved", "namespace-conflict")


def make_plan(profile, name, path, revision):
    base = {"schemaVersion": 1, "profile": profile, "diagnostics": []}
    try:
        registry.instance_name(name)
        current = requirements()
        if registry.sha(revision, 40) != current["sourceRevision"]:
            registry.refuse("Firstmate source revision changed", "source-mismatch")
        evidence = registry.inspect_worktree(path)
        rows = registry.registry_entries()
        candidates = matching_rows(profile, evidence, rows)
        if candidates and candidates[0]["plan"]["name"] == name:
            plan = candidates[0]["plan"]
            validate_plan_current(plan, revision, rows)
            return {**base, "state": "ready", "plan": plan}
        require_bootstrap()
        used = {row["plan"]["taskIdPrefix"] for row in rows}
        prefix = "fi" + secrets.token_hex(3)
        while prefix in used:
            prefix = "fi" + secrets.token_hex(3)
        instance_id = str(registry.uuid.uuid4())
        while instance_id in registry.legacy_instance_ids() or any(row["plan"]["reference"]["instanceId"] == instance_id for row in rows):
            instance_id = str(registry.uuid.uuid4())
        destination = registry.registry_root() / instance_id
        plan = {"schemaVersion": 1, "reference": {"schemaVersion": 1, "profile": profile, "mode": "named", "instanceId": instance_id},
                "name": name, "sourceRevision": revision, "taskIdPrefix": prefix, "destination": str(destination),
                "worktree": evidence, "runtimeRequirements": current,
                "permittedWrites": [{"kind": "instance-root", "path": str(destination)},
                                    {"kind": "registry-locks", "path": str(destination.parent / "locks")}]}
        plan["approvalDigest"] = registry.digest(plan)
        validate_plan_current(plan, revision, rows)
        return {**base, "state": "ready", "plan": plan}
    except (registry.Refusal, OSError, overlay.OverlayError) as error:
        return {**base, "state": "blocked", "plan": None, "diagnostics": [notice(getattr(error, "code", "unsafe-state"), error)]}


def publish_reserved_root(plan):
    root = Path(plan["destination"])
    registry.safe(root, True, required=False, private=True)
    if root.exists() and (root / "instance.json").exists():
        descriptor = registry.named_descriptor(root, identity_required=False)
        if not (root / "receipts/instance.json").exists():
            if descriptor != descriptor_from_plan(plan):
                registry.refuse("cannot restore identity outside the original unpublished creation")
            registry.atomic_json(root / "receipts/instance.json",
                                 {"schemaVersion": 1, "owner": registry.OWNER, "profile": plan["reference"]["profile"],
                                  "instanceId": root.name, "home": str(root / "home"), "prerequisitesConsent": True})
        registry.named_descriptor(root, identity_required=True)
        return
    if root.exists() and any(root.iterdir()):
        registry.refuse("cannot claim a nonempty incomplete instance root")
    root.mkdir(mode=0o700, exist_ok=True)
    marker = root / registry.MARKER
    fd = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(registry.OWNER + "\n")
    for suffix in ("home", "home/config", "home/state", "home/data", "home/projects", "captain", "workers", "receipts", "locks"):
        (root / suffix).mkdir(mode=0o700, exist_ok=True)
    registry.atomic_json(root / "instance.json", descriptor_from_plan(plan))
    registry.atomic_json(root / "receipts/instance.json",
                         {"schemaVersion": 1, "owner": registry.OWNER, "profile": plan["reference"]["profile"],
                          "instanceId": root.name, "home": str(root / "home"), "prerequisitesConsent": True})


def create_locked(plan, path):
    rows = registry.registry_entries()
    validate_plan_current(plan, requirements()["sourceRevision"], rows)
    if registry.shared_lock().exists() or registry.shared_lock().is_symlink():
        registry.refuse("shared Native maintenance is active", "busy")
    require_bootstrap()
    record = registry.plan_record(path) if path.exists() else None
    if record is not None and record["phase"] == "published":
        descriptor = describe(record)
        if (descriptor["creationState"] != "published" or descriptor["worktree"]["status"] != "bound"
            or descriptor["runtime"]["state"] != "verified"):
            registry.refuse("published instance needs inspection or repair, not recreation", "missing-identity")
        return "existing", descriptor
    if record is not None and recover_published_descriptor(plan, path):
        return "created", registry.named_descriptor(Path(plan["destination"]), identity_required=True)
    with registry.defer_signals():
        registry.atomic_json(path, {"schemaVersion": 1, "owner": registry.REGISTRY_OWNER, "phase": "reserved", "plan": plan})
        publish_reserved_root(plan)
        registry.atomic_json(path, {"schemaVersion": 1, "owner": registry.REGISTRY_OWNER, "phase": "creating", "plan": plan})
    result = control.preparation_process(
        [str(PACKAGE / "bin/fmx"), "_create-owned", plan["reference"]["profile"], plan["approvalDigest"],
         "--instance", plan["reference"]["instanceId"]], timeout=240)
    if result.returncode:
        registry.refuse("creation did not complete; reconcile this approved UUID: " + control.diagnostic(result.stderr), "creation-incomplete")
    validate_plan_current(plan, requirements()["sourceRevision"], registry.registry_entries())
    require_bootstrap()
    descriptor = registry.named_descriptor(Path(plan["destination"]), identity_required=True)
    if verify_runtime(Path(plan["destination"])) != "verified":
        registry.refuse("created runtime failed variant verification", "runtime-drift")
    descriptor.update(creationState="published", diagnostics=[])
    descriptor["runtime"]["state"] = "verified"
    with registry.defer_signals():
        registry.atomic_json(Path(plan["destination"]) / "instance.json", descriptor)
        registry.atomic_json(path, {"schemaVersion": 1, "owner": registry.REGISTRY_OWNER, "phase": "published", "plan": plan})
    return "created", descriptor


def recover_published_descriptor(plan, path):
    root = Path(plan["destination"])
    if not (root / "instance.json").exists():
        return False
    descriptor = registry.named_descriptor(root, identity_required=False)
    if descriptor["creationState"] != "published":
        return False
    registry.named_descriptor(root, identity_required=True)
    registry.check_idle(root)
    if verify_runtime(root) != "verified":
        registry.refuse("interrupted publication must retain its verified runtime", "runtime-drift")
    registry.atomic_json(path, {"schemaVersion": 1, "owner": registry.REGISTRY_OWNER, "phase": "published", "plan": plan})
    return True


def create_instance(profile, approved):
    plan = registry.creation_plan(registry.json_value(sys.stdin.buffer.read(registry.LIMIT + 1)))
    base = {"schemaVersion": 1, "reference": plan["reference"], "approvalDigest": plan["approvalDigest"]}
    path = registry.registry_root() / "locks/plans" / (plan["reference"]["instanceId"] + ".json")
    try:
        if profile != plan["reference"]["profile"] or approved != plan["approvalDigest"]:
            registry.refuse("explicit approval must match this complete creation plan", "approval-mismatch")
        validate_plan_current(plan, requirements()["sourceRevision"], registry.registry_entries())
        require_bootstrap()
        if registry.shared_lock().exists() or registry.shared_lock().is_symlink():
            registry.refuse("shared Native maintenance is active", "busy")
        with registry.defer_signals():
            root = registry.ensure_registry()
        with registry.lease(root / "locks/allocation", registry.REGISTRY_OWNER):
            state, descriptor = create_locked(plan, path)
        return {**base, "state": state, "descriptor": descriptor, "diagnostics": []}
    except (registry.Refusal, OSError, control.Failure) as error:
        incomplete = path.exists() and registry.plan_record(path)["phase"] != "published"
        code = "creation-incomplete" if incomplete else getattr(error, "code", "unsafe-state")
        return {**base, "state": "incomplete" if incomplete else "blocked", "descriptor": None,
                "diagnostics": [notice(code, error)]}


def check_creation(profile, selector, approved):
    root, _, descriptor = registry.resolve(profile, selector, complete=True)
    record = registry.plan_record(root.parent / "locks/plans" / (selector + ".json"))
    pid, _ = registry.lock_record(root.parent / "locks/allocation", owner=registry.REGISTRY_OWNER, kind="")
    parent = subprocess.check_output(["ps", "-o", "ppid=", "-p", str(os.getppid())], text=True).strip()
    if (str(pid) != parent or record["phase"] != "creating" or record["plan"]["approvalDigest"] != approved
        or descriptor["creationState"] not in ("creating", "incomplete")):
        registry.refuse("private creation requires the original owning allocation process")
    validate_plan_current(record["plan"], requirements()["sourceRevision"], registry.registry_entries())
    require_bootstrap()


def refresh_locator(profile, selector, path, expected, confirm):
    if not confirm or not registry.UUID.fullmatch(selector):
        registry.refuse("locator refresh requires a UUID and explicit --confirm")
    root, _, before = registry.resolve(profile, selector, complete=True)
    if before["creationState"] != "published" or registry.digest(before["worktree"]["evidence"]) != expected:
        registry.refuse("locator refresh expectations changed", "stale-plan")
    with registry.lease(registry.registry_root() / "locks/allocation", registry.REGISTRY_OWNER):
        with control.mutation(root, "refresh-locator"):
            registry.check_idle(root, os.getpid(), ("refresh-locator",))
            current = registry.named_descriptor(root, identity_required=True)
            if registry.digest(current["worktree"]["evidence"]) != expected:
                registry.refuse("binding changed under the locator refresh gate", "stale-plan")
            evidence = registry.inspect_worktree(path)
            if evidence["generationDigest"] != current["worktree"]["evidence"]["generationDigest"]:
                registry.refuse("locator refresh cannot adopt a recreated or different worktree", "worktree-replaced")
            current["worktree"] = {"status": "bound", "evidence": evidence}
            registry.atomic_json(root / "instance.json", current)
    return describe(registry.plan_record(root.parent / "locks/plans" / (selector + ".json")))


def reject_duplicate_options(parser):
    seen = set()
    for argument in sys.argv[1:]:
        if argument.startswith("--"):
            flag = argument.partition("=")[0]
            if flag in seen:
                parser.error(flag + " was supplied more than once")
            seen.add(flag)


def arguments():
    parser = argparse.ArgumentParser(allow_abbrev=False)
    reject_duplicate_options(parser)
    commands = parser.add_subparsers(dest="operation", required=True)
    for operation in ("list", "resolve", "plan", "create", "refresh-locator"):
        command = commands.add_parser(operation, allow_abbrev=False)
        command.add_argument("profile", choices=registry.PROFILES)
        command.add_argument("--json", required=True, action="store_true")
        if operation == "list":
            command.add_argument("--limit", type=int, default=32)
            command.add_argument("--cursor")
        if operation in ("resolve", "plan", "refresh-locator"):
            command.add_argument("--worktree", required=True)
        if operation == "plan":
            command.add_argument("--name", required=True)
            command.add_argument("--expected-source-revision", required=True)
        if operation == "create":
            command.add_argument("--approve-creation")
        if operation == "refresh-locator":
            command.add_argument("--instance", required=True)
            command.add_argument("--expected-binding-digest", required=True)
            command.add_argument("--confirm", action="store_true", required=True)
    return parser.parse_args()


def main():
    if len(sys.argv) == 6 and sys.argv[1] == "_context":
        profile, selector, join, raw = sys.argv[2:]
        value = registry.validate_context(profile, selector, raw, join == "true")
        control.require_runtime_context(value)
        print(registry.canonical(value).decode())
        return 0
    if len(sys.argv) == 5 and sys.argv[1] == "_check-creation":
        check_creation(*sys.argv[2:])
        return 0
    args = arguments()
    profile = args.profile
    for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(number, control.cancel_preparation)
    if args.operation == "list":
        result = list_instances(profile, args.limit, args.cursor)
    elif args.operation == "resolve":
        result = resolve_worktree(profile, args.worktree)
    elif args.operation == "plan":
        result = make_plan(profile, args.name, args.worktree, args.expected_source_revision)
    elif args.operation == "create":
        result = create_instance(profile, args.approve_creation)
    else:
        result = refresh_locator(profile, args.instance, args.worktree, args.expected_binding_digest, args.confirm)
    encoded = registry.canonical(result)
    if len(encoded) >= registry.LIMIT:
        registry.refuse("instance result exceeds 65536 bytes; request a smaller --limit")
    print(encoded.decode())
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except control.PreparationCancelled as error:
        print("fmx instances: cancelled; reconcile the same approved UUID", file=sys.stderr)
        sys.exit(128 + error.number)
    except (registry.Refusal, control.Failure, control.controls.Refusal, OSError, ValueError, TypeError,
            KeyError, overlay.OverlayError, subprocess.SubprocessError) as error:
        print("fmx instances: " + str(error), file=sys.stderr)
        sys.exit(1)
