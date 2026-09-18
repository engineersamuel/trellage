#!/usr/bin/env python3
"""Firstmate instance authority, worktree generations, and shared writer leases."""

from __future__ import annotations

import contextlib
import ctypes
import hashlib
import json
import os
import re
import signal
import stat
import struct
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.dont_write_bytecode = True
OWNER = "trellage-firstmate-profiles-v1"
MARKER = ".managed-by-trellage-firstmate-profiles"
REGISTRY_OWNER = "trellage-firstmate-instances-v1"
INSTALL_OWNER = "trellage-firstmate-install-lock-v1"
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
PREFIX = re.compile(r"fi[a-f0-9]{6}")
PROFILES = {"default": "fmd", "pstack-workers": "fmp"}
LIMIT = 65536
ACTIONS = {"setup", "repair", "prepare", "update", "launch", "submit", "receipt",
           "doctor", "skills-update", "refresh-locator"}
COMPATIBILITY = {"schemaVersion": 1, "owner": REGISTRY_OWNER, "kind": "shared-writer-interlock"}
DIAGNOSTICS = {"worktree-missing", "worktree-replaced", "worktree-moved", "generation-unavailable",
               "ambiguous-worktree", "name-conflict", "worktree-conflict", "namespace-conflict",
               "source-mismatch", "runtime-missing", "runtime-drift", "missing-identity", "unsafe-state",
               "upgrade-required", "bootstrap-required", "busy", "stale-plan", "creation-incomplete",
               "not-found", "approval-mismatch", "stale-cursor"}


class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def refuse(message, code="unsafe-state"):
    raise Refusal(code, message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            refuse("duplicate JSON field: " + key)
        result[key] = value
    return result


def exact(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        refuse(label + " has missing or unsupported fields")
    if "schemaVersion" in keys and (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1):
        refuse(label + " requires schemaVersion 1")
    return value


def text(value, maximum=4096):
    if (not isinstance(value, str) or not value.strip()
        or re.search(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]", value)
        or len(value.encode("utf-16-le")) // 2 > maximum):
        refuse("invalid or oversized text")
    return value


def sha(value, length=64):
    if not isinstance(value, str) or not re.fullmatch("[a-f0-9]{" + str(length) + "}", value):
        refuse("invalid lowercase digest")
    return value


def locator(value):
    text(value)
    if not Path(value).is_absolute() or os.path.normpath(value) != value or value.startswith("//"):
        refuse("expected a canonical absolute path")
    return Path(value)


def json_value(raw):
    if len(raw) > LIMIT:
        refuse("instance JSON exceeds 65536 bytes")
    value = json.loads(raw, object_pairs_hook=unique, parse_constant=lambda _: refuse("non-finite JSON number"))
    if len(canonical(value)) > LIMIT:
        refuse("canonical instance JSON exceeds 65536 bytes")
    return value


def safe(path, directory=False, required=True, private=False):
    path = Path(path)
    for parent in (path, *path.parents):
        if parent.is_symlink():
            refuse("symlinked managed path: " + str(parent))
    try:
        info = path.stat()
    except FileNotFoundError:
        if required:
            refuse("missing managed path: " + str(path))
        return None
    shape = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    if (not shape or info.st_uid != os.getuid() or info.st_mode & 0o022
        or (private and stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600))):
        refuse("unsafe or unowned managed path: " + str(path))
    return info


def read(path, limit=LIMIT, private=False):
    info = safe(path, private=private)
    if info.st_size > limit:
        refuse("managed file exceeds its size bound: " + str(path))
    return Path(path).read_bytes()


def read_json(path, private=False):
    return json_value(read(path, private=private))


def atomic_json(path, value):
    safe(path.parent, True)
    safe(path, required=False)
    stage = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    with defer_signals():
        fd = os.open(stage, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(canonical(value) + b"\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(stage, path)
            parent = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        finally:
            stage.unlink(missing_ok=True)


@contextlib.contextmanager
def defer_signals():
    previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM, signal.SIGINT, signal.SIGHUP})
    try:
        yield
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous)


def home():
    path = locator(os.environ.get("HOME", ""))
    if path.is_symlink():
        refuse("HOME must not be a symlink")
    path = path.resolve(strict=True)
    if path == Path("/"):
        refuse("HOME cannot be the filesystem root")
    safe(path, True)
    return path


def profiles_root():
    current = home()
    for component in (".local", "share", "trellage", "profiles", "firstmate"):
        current /= component
        safe(current, True, required=False)
    return current


def registry_root():
    root = profiles_root() / "instances"
    safe(root, True, required=False, private=True)
    return root


def shared_lock():
    return home() / ".local/share/trellage/.fmx-install.lock"


def ensure_chain(path):
    relative = path.relative_to(home())
    current = home()
    for component in relative.parts:
        current /= component
        safe(current, True, required=False)
        if not current.exists():
            current.mkdir(mode=0o700)


def profile_name(value):
    if value not in PROFILES:
        refuse("unknown Firstmate profile", "not-found")
    return value


def instance_name(value):
    text(value, 64)
    if (not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value) or value == "legacy"
        or re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value)):
        refuse("instance names must be lowercase kebab-case, not legacy or a UUID")
    return value


def reference(value, named=False):
    exact(value, ("schemaVersion", "profile", "mode", "instanceId"), "instance reference")
    profile_name(value["profile"])
    if value["mode"] not in ("named", "legacy") or (named and value["mode"] != "named"):
        refuse("invalid instance reference mode")
    if not isinstance(value["instanceId"], str) or not UUID.fullmatch(value["instanceId"]):
        refuse("invalid instance UUID")
    return value


def runtime_variant(value):
    exact(value, ("schemaVersion", "variant", "sourceRevision", "baseManifestDigest",
                  "supplementManifestDigest", "effectiveContentDigest"), "runtime variant")
    if value["variant"] != "firstmate-instance-v1":
        refuse("named instances require firstmate-instance-v1", "runtime-drift")
    sha(value["sourceRevision"], 40)
    for key in ("baseManifestDigest", "supplementManifestDigest", "effectiveContentDigest"):
        sha(value[key])
    return value


def worktree_evidence(value):
    exact(value, ("schemaVersion", "locators", "generation", "generationDigest"), "worktree evidence")
    exact(value["locators"], ("worktree", "privateGitDir", "commonGitDir"), "worktree locators")
    generation = exact(value["generation"], ("schemaVersion", "kind", "worktree", "privateGitDir", "commonGitDir"), "worktree generation")
    if generation["kind"] != "stat-birthtime-v1":
        refuse("unsupported filesystem generation", "generation-unavailable")
    for key in ("worktree", "privateGitDir", "commonGitDir"):
        locator(value["locators"][key])
        item = exact(generation[key], ("device", "inode", "birthtimeNs"), "filesystem generation")
        for field, number in item.items():
            if (not isinstance(number, str) or not re.fullmatch(r"0|[1-9][0-9]{0,39}", number)
                or (field != "device" and number == "0")):
                refuse("invalid filesystem generation", "generation-unavailable")
    if value["generationDigest"] != digest(generation):
        refuse("worktree generation digest does not match")
    paths = value["locators"]
    if paths["worktree"] in (paths["privateGitDir"], paths["commonGitDir"]):
        refuse("worktree and Git directories must be distinct")
    if paths["privateGitDir"] == paths["commonGitDir"] and generation["privateGitDir"] != generation["commonGitDir"]:
        refuse("one Git directory cannot have two generations")
    return value


def native_birthtime(path):
    libc = ctypes.CDLL(None, use_errno=True)
    buffer = ctypes.create_string_buffer(256)
    if sys.platform == "linux":
        if not hasattr(libc, "statx") or libc.statx(-100, os.fsencode(path), 0x100, 0x800, buffer) != 0:
            refuse("reliable filesystem birth-time evidence is unavailable", "generation-unavailable")
        if not struct.unpack_from("=I", buffer.raw)[0] & 0x800:
            refuse("filesystem does not report birth time", "generation-unavailable")
        seconds, nanoseconds = struct.unpack_from("=qI", buffer.raw, 80)
    elif sys.platform == "darwin":
        # Python versions without st_birthtime_ns expose a rounded float.
        # getattrlist returns the original timespec, without that precision loss.
        attributes = ctypes.create_string_buffer(struct.pack("=HHIIIII", 5, 0, 0x200, 0, 0, 0, 0))
        if libc.getattrlist(os.fsencode(path), attributes, buffer, len(buffer), 1) != 0:
            refuse("reliable filesystem birth-time evidence is unavailable", "generation-unavailable")
        if struct.unpack_from("=I", buffer.raw)[0] < 20:
            refuse("filesystem birth-time record is incomplete", "generation-unavailable")
        seconds, nanoseconds = struct.unpack_from("=qq", buffer.raw, 4)
    else:
        refuse("filesystem birth-time evidence is unsupported on this host", "generation-unavailable")
    if seconds <= 0 or not 0 <= nanoseconds < 1_000_000_000:
        refuse("filesystem birth-time record is invalid", "generation-unavailable")
    return seconds * 1_000_000_000 + nanoseconds


def filesystem_generation(path):
    info = safe(path, True)
    birth = getattr(info, "st_birthtime_ns", None)
    if birth is None:
        birth = native_birthtime(path)
    if birth is None or birth <= 0:
        refuse("reliable filesystem birth-time evidence is unavailable", "generation-unavailable")
    return {"device": str(info.st_dev), "inode": str(info.st_ino), "birthtimeNs": str(birth)}


def git(path, *arguments):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C")
    result = subprocess.run(["git", "-C", str(path), *arguments], env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=False)
    if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
        refuse("cannot verify the registered Git worktree", "ambiguous-worktree")
    return result.stdout.decode("utf-8")


def verify_git_registration(root, private, common):
    pointer = root / ".git"
    if private == common:
        if pointer != private:
            refuse("separate or redirected primary Git directories are not supported", "ambiguous-worktree")
        safe(pointer, True)
    else:
        if private.parent != common / "worktrees":
            refuse("linked worktree Git directory is not registered in its common directory", "ambiguous-worktree")
        backlink = Path(read(private / "gitdir").decode().strip())
        forward = read(pointer).decode().strip()
        if (backlink != pointer or not forward.startswith("gitdir: ")
            or (root / forward[8:]).resolve(strict=True) != private
            or (private / read(private / "commondir").decode().strip()).resolve(strict=True) != common):
            refuse("Git worktree registration or backlinks disagree", "ambiguous-worktree")
    registered = [field[9:] for field in git(root, "worktree", "list", "--porcelain", "-z").split("\0")
                  if field.startswith("worktree ")]
    if registered.count(str(root)) != 1:
        refuse("worktree registration is missing or ambiguous", "ambiguous-worktree")


def inspect_worktree(path):
    candidate = Path(text(str(path))).resolve(strict=True)
    safe(candidate, True)
    if git(candidate, "rev-parse", "--is-inside-work-tree").strip() != "true":
        refuse("a non-bare Git worktree is required", "ambiguous-worktree")
    root = Path(git(candidate, "rev-parse", "--show-toplevel").strip()).resolve(strict=True)
    private = Path(git(candidate, "rev-parse", "--absolute-git-dir").strip()).resolve(strict=True)
    common = Path(git(candidate, "rev-parse", "--path-format=absolute", "--git-common-dir").strip()).resolve(strict=True)
    locations = {"worktree": root, "privateGitDir": private, "commonGitDir": common}
    generation = {key: filesystem_generation(value) for key, value in locations.items()}
    verify_git_registration(root, private, common)
    if any(filesystem_generation(path) != generation[key] for key, path in locations.items()):
        refuse("worktree generation changed during inspection", "worktree-replaced")
    generation = {"schemaVersion": 1, "kind": "stat-birthtime-v1", **generation}
    return worktree_evidence({"schemaVersion": 1, "locators": {key: str(path) for key, path in locations.items()},
                              "generation": generation, "generationDigest": digest(generation)})


def binding_status(evidence):
    try:
        current = inspect_worktree(evidence["locators"]["worktree"])
        if current["generationDigest"] != evidence["generationDigest"]:
            return "replaced"
        return "bound" if current == evidence else "moved"
    except FileNotFoundError:
        return "missing"
    except (OSError, Refusal, subprocess.SubprocessError, ValueError):
        return "unverifiable"


def creation_plan(value):
    exact(value, ("schemaVersion", "reference", "name", "sourceRevision", "taskIdPrefix", "destination",
                  "worktree", "runtimeRequirements", "permittedWrites", "approvalDigest"), "creation plan")
    ref = reference(value["reference"], True)
    instance_name(value["name"])
    sha(value["sourceRevision"], 40)
    if not isinstance(value["taskIdPrefix"], str) or not PREFIX.fullmatch(value["taskIdPrefix"]):
        refuse("invalid reserved task namespace")
    root = registry_root() / ref["instanceId"]
    if locator(value["destination"]) != root:
        refuse("creation destination must be this HOME's exact UUID root")
    worktree_evidence(value["worktree"])
    runtime_variant(value["runtimeRequirements"])
    if value["runtimeRequirements"]["sourceRevision"] != value["sourceRevision"]:
        refuse("runtime and source revision disagree")
    if value["permittedWrites"] != [{"kind": "instance-root", "path": str(root)},
                                     {"kind": "registry-locks", "path": str(root.parent / "locks")}]:
        refuse("creation writes must be only the UUID root and registry locks")
    if sha(value["approvalDigest"]) != digest({key: item for key, item in value.items() if key != "approvalDigest"}):
        refuse("creation approval digest does not match", "approval-mismatch")
    return value


def validate_registry():
    root = registry_root()
    if not root.exists():
        return root
    safe(root / "locks", True, private=True)
    if read_json(root / "locks/registry.json", private=True) != {"schemaVersion": 1, "owner": REGISTRY_OWNER}:
        refuse("unowned or unsupported Firstmate instance registry")
    if read_json(root / "locks/mutation", private=True) != COMPATIBILITY:
        refuse("unsafe Firstmate compatibility record; do not remove it as a stale lock")
    safe(root / "locks/plans", True, private=True)
    for item in (root / "locks").iterdir():
        if item.name not in ("registry.json", "mutation", "plans", "allocation"):
            refuse("unknown registry control state: " + str(item))
    return root


def ensure_registry():
    root = registry_root()
    if root.exists():
        return validate_registry()
    ensure_chain(root)
    (root / "locks").mkdir(mode=0o700)
    (root / "locks/plans").mkdir(mode=0o700)
    atomic_json(root / "locks/registry.json", {"schemaVersion": 1, "owner": REGISTRY_OWNER})
    atomic_json(root / "locks/mutation", COMPATIBILITY)
    return root


def plan_record(path):
    item = exact(read_json(path, private=True), ("schemaVersion", "owner", "phase", "plan"), "creation reservation")
    if item["owner"] != REGISTRY_OWNER or item["phase"] not in ("reserved", "creating", "published"):
        refuse("unknown creation reservation ownership or phase")
    plan = creation_plan(item["plan"])
    if path.name != plan["reference"]["instanceId"] + ".json":
        refuse("creation reservation UUID differs from its filename")
    return item


def identity_record(root, profile, expected_id=None):
    value = read_json(root / "receipts/instance.json", private=True)
    exact(value, ("schemaVersion", "owner", "profile", "instanceId", "home", "prerequisitesConsent"), "fleet identity")
    if (value["owner"] != OWNER or value["profile"] != profile or value["home"] != str(root / "home")
        or not isinstance(value["instanceId"], str) or not UUID.fullmatch(value["instanceId"])
        or type(value["prerequisitesConsent"]) is not bool
        or (expected_id is not None and value["instanceId"] != expected_id)):
        refuse("owned fleet UUID, profile, or home differs")
    return value


def legacy_instance_ids():
    identities = set()
    for profile in PROFILES:
        root = profiles_root() / profile
        path = root / "receipts/instance.json"
        if path.exists() or path.is_symlink():
            if read(root / MARKER).decode().strip() != OWNER:
                refuse("legacy fleet identity has no owned root")
            identities.add(identity_record(root, profile)["instanceId"])
    return identities


def descriptor_fields(value, root):
    exact(value, ("schemaVersion", "profile", "mode", "name", "reference", "root", "taskIdPrefix",
                  "creationState", "worktree", "runtime", "diagnostics"), "instance descriptor")
    ref = reference(value["reference"], True)
    if value["mode"] != "named" or value["profile"] != ref["profile"] or value["root"] != str(root):
        refuse("descriptor and owned root disagree")
    if root != registry_root() / ref["instanceId"]:
        refuse("descriptor UUID and directory UUID disagree")
    instance_name(value["name"])
    if not isinstance(value["taskIdPrefix"], str) or not PREFIX.fullmatch(value["taskIdPrefix"]):
        refuse("invalid instance task namespace")
    if value["creationState"] not in ("creating", "published", "incomplete", "missing-identity", "unsafe"):
        refuse("unsupported instance creation state")
    exact(value["worktree"], ("status", "evidence"), "instance worktree")
    worktree_evidence(value["worktree"]["evidence"])
    if value["worktree"]["status"] not in ("bound", "missing", "moved", "replaced", "unverifiable"):
        refuse("unsupported worktree status")
    exact(value["runtime"], ("state", "required"), "instance runtime")
    runtime_variant(value["runtime"]["required"])
    if value["runtime"]["state"] not in ("verified", "missing", "drift", "unsafe"):
        refuse("unsupported runtime status")
    descriptor_diagnostics(value)


def descriptor_diagnostics(value):
    diagnostics = value["diagnostics"]
    if not isinstance(diagnostics, list) or len(diagnostics) > 16:
        refuse("invalid descriptor diagnostic list")
    for item in diagnostics:
        exact(item, ("code", "message"), "diagnostic")
        if item["code"] not in DIAGNOSTICS:
            refuse("unknown instance diagnostic code")
        text(item["message"], 2000)
    if value["creationState"] != "published" and not diagnostics:
        refuse("unpublished state requires a diagnostic")


def named_descriptor(root, identity_required=False):
    safe(root, True, private=True)
    if read(root / MARKER).decode().strip() != OWNER:
        refuse("named instance root is not owned")
    value = read_json(root / "instance.json", private=True)
    descriptor_fields(value, root)
    reservation = plan_record(root.parent / "locks/plans" / (root.name + ".json"))
    plan = reservation["plan"]
    if reservation["phase"] == "published" and value["creationState"] != "published":
        refuse("published creation record and descriptor state disagree")
    if (value["reference"] != plan["reference"] or value["name"] != plan["name"]
        or value["taskIdPrefix"] != plan["taskIdPrefix"] or value["runtime"]["required"] != plan["runtimeRequirements"]
        or value["worktree"]["evidence"]["generationDigest"] != plan["worktree"]["generationDigest"]):
        refuse("descriptor differs from its immutable approved creation plan")
    identity_path = root / "receipts/instance.json"
    if identity_required or identity_path.exists() or identity_path.is_symlink():
        identity_record(root, value["profile"], root.name)
    return value


def registry_entries():
    root = validate_registry()
    if not root.exists():
        return []
    entries = []
    seen_ids, names, bindings, prefixes = legacy_instance_ids(), set(), set(), set()
    records = root / "locks/plans"
    for path in sorted(records.iterdir()):
        record = plan_record(path)
        plan = record["plan"]
        ref = plan["reference"]
        instance_id = ref["instanceId"]
        name = (ref["profile"], plan["name"])
        binding = (ref["profile"], plan["worktree"]["generationDigest"])
        prefix = plan["taskIdPrefix"]
        if instance_id in seen_ids or name in names or binding in bindings or prefix in prefixes:
            refuse("duplicate UUID, name, worktree association, or namespace in the registry")
        seen_ids.add(instance_id)
        names.add(name)
        bindings.add(binding)
        prefixes.add(prefix)
        entries.append(record)
        target = root / instance_id
        safe(target, True, required=False, private=True)
        if (target / "instance.json").exists():
            named_descriptor(target)
        elif target.exists() and any(target.iterdir()):
            refuse("reserved root has unknown or incomplete ownership")
    owned_ids = {row["plan"]["reference"]["instanceId"] for row in entries}
    for path in root.iterdir():
        if path.name != "locks" and path.name not in owned_ids:
            refuse("unreserved or unowned instance root: " + str(path))
    if len(entries) > 999999:
        refuse("instance registry exceeds the supported bound")
    return entries


def resolve(profile, selector="legacy", complete=False):
    profile_name(profile)
    if selector == "legacy":
        root = profiles_root() / profile
        safe(root, True, required=False)
        return root, PROFILES[profile], None
    if not UUID.fullmatch(selector):
        instance_name(selector)
    candidates = [row for row in registry_entries()
                  if row["plan"]["reference"]["profile"] == profile
                  and selector in (row["plan"]["reference"]["instanceId"], row["plan"]["name"])]
    if len(candidates) != 1:
        refuse("instance selector does not identify one owned instance", "not-found")
    root = registry_root() / candidates[0]["plan"]["reference"]["instanceId"]
    descriptor = named_descriptor(root, identity_required=complete)
    return root, descriptor["taskIdPrefix"], descriptor


def control_context(value):
    exact(value, ("schemaVersion", "reference", "expectedBindingDigest", "expectedRuntimeDigest",
                  "entryWorktree", "selection"), "instance control context")
    ref = reference(value["reference"])
    if value["selection"] not in ("entry-match", "confirmed-join"):
        refuse("invalid instance selection")
    entry = value["entryWorktree"]
    if entry is not None:
        worktree_evidence(entry)
    if ref["mode"] == "named":
        sha(value["expectedBindingDigest"])
        sha(value["expectedRuntimeDigest"])
    elif value["expectedBindingDigest"] is not None or value["expectedRuntimeDigest"] is not None or value["selection"] != "confirmed-join":
        refuse("legacy context must be an explicit join without named expectations")
    if value["selection"] == "entry-match" and (entry is None or digest(entry) != value["expectedBindingDigest"]):
        refuse("entry-match requires the exact captured worktree binding")
    return value


def legacy_context(root, profile, raw):
    if not raw:
        return None
    value = control_context(json_value(raw.encode()))
    identity = identity_record(root, profile)
    if value["reference"] != {"schemaVersion": 1, "profile": profile, "mode": "legacy", "instanceId": identity["instanceId"]}:
        refuse("legacy control context identifies another fleet")
    return value


def fresh_context(descriptor, join):
    entry = None
    try:
        entry = inspect_worktree(os.getcwd())
    except (OSError, Refusal, subprocess.SubprocessError):
        pass
    evidence = descriptor["worktree"]["evidence"]
    if entry != evidence and not join:
        refuse("foreign or unavailable entry worktree requires explicit --join", "worktree-conflict")
    return {"schemaVersion": 1, "reference": descriptor["reference"], "expectedBindingDigest": digest(evidence),
            "expectedRuntimeDigest": digest(descriptor["runtime"]["required"]), "entryWorktree": entry,
            "selection": "confirmed-join" if join else "entry-match"}


def validate_context(profile, selector, raw="", join=False):
    root, _, descriptor = resolve(profile, selector, complete=True)
    if descriptor is None:
        return legacy_context(root, profile, raw)
    if not is_published(root, descriptor):
        refuse("new control requires a published instance; reconcile the approved creation", "creation-incomplete")
    evidence = descriptor["worktree"]["evidence"]
    if binding_status(evidence) != "bound":
        refuse("bound worktree is missing, moved, replaced, or unverifiable; inspect or refresh its locator", "worktree-replaced")
    value = control_context(json_value(raw.encode())) if raw else fresh_context(descriptor, join)
    if (value["reference"] != descriptor["reference"] or value["expectedBindingDigest"] != digest(evidence)
        or value["expectedRuntimeDigest"] != digest(descriptor["runtime"]["required"])):
        refuse("instance control expectations changed; refresh selection", "stale-plan")
    if value["entryWorktree"] is not None:
        current = inspect_worktree(value["entryWorktree"]["locators"]["worktree"])
        if current != value["entryWorktree"]:
            refuse("captured entry worktree generation or locators changed", "worktree-replaced")
    return value


def is_published(root, descriptor):
    record = plan_record(root.parent / "locks/plans" / (root.name + ".json"))
    return record["phase"] == "published" and descriptor["creationState"] == "published"


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def pid_text(raw):
    value = raw.decode().strip()
    if not re.fullmatch(r"[1-9][0-9]{0,9}", value) or int(value) > 2147483647:
        refuse("invalid process identity in an owned lock", "busy")
    return int(value)


def lock_record(path, owner=OWNER, kind="action"):
    safe(path, True)
    expected = {"owner", "pid"} | ({kind} if kind else set())
    if {entry.name for entry in path.iterdir()} != expected or read(path / "owner").decode().strip() != owner:
        refuse("incomplete or unowned mutation/session lock: " + str(path), "busy")
    pid = pid_text(read(path / "pid", 32))
    value = read(path / kind).decode().strip() if kind else ""
    if (kind == "action" and value not in ACTIONS) or (kind == "backend" and value not in ("herdr", "tmux")):
        refuse("unknown mutation/session lock state", "busy")
    return pid, value


def check_instance_locks(root, allowed_pid, allowed_actions):
    for name, kind in (("session", "backend"), ("mutation", "action")):
        path = root / "locks" / name
        if path.exists() or path.is_symlink():
            pid, action = lock_record(path, kind=kind)
            if name == "mutation" and pid == allowed_pid and action in allowed_actions:
                continue
            if alive(pid):
                refuse("Firstmate fleet or profile mutation is active: " + str(root), "busy")


def check_idle(root, allowed_pid=None, allowed_actions=()):
    check_instance_locks(root, allowed_pid, allowed_actions)
    check_operations(root)
    paths = [root / "home/state/.lock"]
    workers = root / "workers"
    safe(workers, True, required=False)
    if workers.exists():
        for worker in workers.iterdir():
            safe(worker, True)
            paths.append(worker / ".active")
    for path in paths:
        if path.exists() or path.is_symlink():
            if alive(pid_text(read(path, 32))):
                refuse("Firstmate worker or supervisor is active: " + str(root), "busy")


def operation_record(path, root):
    value = read_json(path, private=True)
    fields = {"schemaVersion", "owner", "instanceId", "pid", "operation"}
    if isinstance(value, dict):
        fields.update(value.keys() & {"operationId", "handoff", "taskIds"})
    exact(value, fields, "instance operation")
    if (value["owner"] != OWNER or value["instanceId"] != root.name
        or type(value["pid"]) is not int or not 1 <= value["pid"] <= 2147483647
        or value["operation"] not in ("spawn", "control", "worker") or path.name != str(value["pid"]) + ".json"):
        refuse("unowned or ambiguous instance operation", "busy")
    operation_handoff(value)
    return value


def operation_handoff(value):
    if "operationId" in value and not UUID.fullmatch(str(value["operationId"])):
        refuse("invalid instance operation identity", "busy")
    if "taskIds" in value:
        if value["operation"] != "spawn" or "operationId" not in value or not isinstance(value["taskIds"], list) or not value["taskIds"]:
            refuse("invalid spawn task authority", "busy")
        for task in value["taskIds"]:
            operation_task(task)
        if len(set(value["taskIds"])) != len(value["taskIds"]):
            refuse("spawn task authority is ambiguous", "busy")
    if "handoff" not in value:
        return
    handoff = exact(value["handoff"], ("operationId", "taskId"), "worker startup handoff")
    if (value["operation"] != "worker" or "operationId" not in value
        or not UUID.fullmatch(str(handoff["operationId"]))):
        refuse("invalid worker startup handoff", "busy")
    operation_task(handoff["taskId"])


def operation_task(value):
    if not isinstance(value, str) or len(value) > 64 or not re.fullmatch(r"fi[a-f0-9]{6}-[A-Za-z0-9._-]{1,59}", value):
        refuse("invalid instance operation task", "busy")


def check_operations(root):
    directory = root / "locks/operations"
    safe(directory, True, required=False, private=True)
    if not directory.exists():
        return
    for path in directory.iterdir():
        record = operation_record(path, root)
        if alive(record["pid"]):
            refuse("Firstmate task startup or control is active: " + str(root), "busy")


def check_legacy_idle(base, allowed_pid, allowed_actions):
    for path in base.iterdir():
        if path.name == "instances":
            continue
        safe(path, True)
        if path.name not in PROFILES:
            refuse("unknown legacy Firstmate profile root")
        if any(path.iterdir()) and read(path / MARKER).decode().strip() != OWNER:
            refuse("unowned legacy Firstmate profile")
        check_idle(path, allowed_pid, allowed_actions)


def check_shared_idle(allowed_pid=None, allowed_actions=()):
    base = profiles_root()
    if not base.exists():
        return
    check_legacy_idle(base, allowed_pid, allowed_actions)
    entries = registry_entries()
    root = registry_root()
    allocation = root / "locks/allocation"
    if allocation.exists() or allocation.is_symlink():
        pid, _ = lock_record(allocation, owner=REGISTRY_OWNER, kind="")
        if alive(pid):
            refuse("Firstmate instance allocation is active", "busy")
    for row in entries:
        path = Path(row["plan"]["destination"])
        if row["phase"] != "published":
            refuse("incomplete instance creation requires same-UUID reconciliation", "creation-incomplete")
        descriptor = named_descriptor(path, identity_required=True)
        if descriptor["creationState"] != "published":
            refuse("instance creation state is unsafe")
        check_idle(path, allowed_pid, allowed_actions)


def claim_lease(path, owner):
    try:
        path.mkdir(mode=0o700)
    except FileExistsError:
        pid, _ = lock_record(path, owner=owner, kind="")
        if alive(pid):
            refuse("another shared or allocation operation is active", "busy")
        # An advisory lock on the old inode prevents two stale reclaimers
        # from unlinking a newly acquired directory with the same pathname.
        import fcntl
        fd = os.open(path / "owner", os.O_RDONLY | os.O_NOFOLLOW)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if os.fstat(fd).st_ino != (path / "owner").stat().st_ino:
                refuse("mutation lock changed during stale recovery", "busy")
            for name in ("owner", "pid"):
                (path / name).unlink()
            path.rmdir()
            path.mkdir(mode=0o700)
        finally:
            os.close(fd)


@contextlib.contextmanager
def lease(path, owner, admit=None, holder_pid=None):
    ensure_chain(path.parent)
    safe(path, True, required=False)
    inode = None
    try:
        with defer_signals():
            claim_lease(path, owner)
            inode = path.stat().st_ino
            for name, value in (("owner", owner), ("pid", str(os.getpid() if holder_pid is None else holder_pid))):
                fd = os.open(path / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "w") as stream:
                    stream.write(value + "\n")
        if admit is not None:
            admit()
        yield
    finally:
        if inode is not None and path.exists() and not path.is_symlink() and path.stat().st_ino == inode:
            for name in ("owner", "pid"):
                (path / name).unlink(missing_ok=True)
            path.rmdir()


def require_parent_shared_lock():
    pid, _ = lock_record(shared_lock(), owner=INSTALL_OWNER, kind="")
    if pid != os.getppid():
        refuse("shared writer must own the immediate parent runtime lease", "busy")


def parent_pid(pid):
    value = subprocess.check_output(["ps", "-o", "ppid=", "-p", str(pid)], text=True).strip()
    return int(value)


def inherited_lease():
    value = os.environ.get("FMX_SHARED_LEASE_FD", "")
    if not value:
        return None
    if not re.fullmatch(r"[1-9][0-9]{0,3}", value) or not 3 <= int(value) <= 4096:
        refuse("invalid inherited shared lease descriptor")
    fd = int(value)
    held = os.fstat(fd)
    current = safe(shared_lock() / "owner")
    if (held.st_dev, held.st_ino) != (current.st_dev, current.st_ino):
        refuse("inherited shared lease is not the current owned lock")
    pid, _ = lock_record(shared_lock(), owner=INSTALL_OWNER, kind="")
    ancestor = os.getppid()
    for _ in range(32):
        if ancestor == pid:
            return fd
        if ancestor <= 1:
            break
        ancestor = parent_pid(ancestor)
    refuse("shared lease was not delegated by an owning ancestor")


def shared_admission(parent_root):
    if parent_root is None:
        check_shared_idle()
        return
    root = locator(parent_root)
    if root.parent != profiles_root() or root.name not in PROFILES:
        refuse("shared bootstrap cannot use named instance creation as consent")
    if read(root / MARKER).decode().strip() != OWNER:
        refuse("unowned bootstrap parent")
    pid, action = lock_record(root / "locks/mutation")
    if pid != os.getppid() or action not in ("setup", "repair"):
        refuse("bootstrap requires the direct explicit setup/repair parent")
    check_shared_idle(pid, ("setup", "repair"))


def stop_child(child):
    if child is None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=3)
    except subprocess.TimeoutExpired:
        pass
    except ProcessLookupError:
        pass
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=3)


def run_lease_command(args):
    parent_root = None
    if args[:1] == ["--parent-mutation"] and len(args) > 2:
        parent_root, args = args[1], args[2:]
    if not args or args[0] != "--":
        refuse("shared lease requires an explicit command")
    inherited = inherited_lease()
    gate = contextlib.nullcontext() if inherited is not None else lease(
        shared_lock(), INSTALL_OWNER, lambda: shared_admission(parent_root))
    child = None
    with gate:
        fd = inherited if inherited is not None else os.open(shared_lock() / "owner", os.O_RDONLY | os.O_NOFOLLOW)
        ready, release = os.pipe()
        try:
            with defer_signals():
                child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "lease-exec",
                                          str(ready), *args[1:]],
                                         start_new_session=True, pass_fds=(fd, ready),
                                         env=dict(os.environ, FMX_SHARED_LEASE_FD=str(fd)),
                                         preexec_fn=lambda: signal.pthread_sigmask(signal.SIG_SETMASK, set()))
                os.close(ready)
                ready = None
                if inherited is None:
                    # The child cannot execute until its PID owns admission. If
                    # this guard dies in the launch window, EOF cancels the child.
                    stage = shared_lock().parent / (".fmx-lease-pid-" + uuid.uuid4().hex)
                    try:
                        handle = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                        with os.fdopen(handle, "w") as stream:
                            stream.write(str(child.pid) + "\n")
                            stream.flush()
                            os.fsync(stream.fileno())
                        os.replace(stage, shared_lock() / "pid")
                    finally:
                        stage.unlink(missing_ok=True)
                os.write(release, b"1")
                os.close(release)
                release = None
            return child.wait()
        finally:
            for pipe in (ready, release):
                if pipe is not None:
                    os.close(pipe)
            stop_child(child)
            if inherited is None:
                os.close(fd)


def shared_operation(mode, args):
    for number in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(number, lambda signum, _frame: (_ for _ in ()).throw(KeyboardInterrupt(signum)))
    try:
        if mode == "lease":
            return run_lease_command(args)
        # The actual writer owns this pipe-held lease. If this helper dies,
        # stale recovery must still wait for the writer to finish its cleanup.
        # TERM is deferred until the writer closes the pipe after that cleanup.
        with defer_signals():
            with lease(shared_lock(), INSTALL_OWNER, check_shared_idle, holder_pid=os.getppid()):
                print("ready", flush=True)
                sys.stdin.buffer.read()
    except KeyboardInterrupt as error:
        return 128 + (error.args[0] if error.args else signal.SIGINT)
    return 0


def check_shared_arguments(args):
    allowed = int(args[0]) if args else None
    if allowed is not None and allowed != parent_pid(os.getppid()):
        refuse("shared mutation delegation is not the direct caller")
    actions = ("launch", "prepare") if len(args) > 1 and args[1] == "prepare" else ("launch",)
    check_shared_idle(allowed, actions if allowed else ())


def main():
    mode, *args = sys.argv[1:]
    if mode == "lease-exec":
        fd = int(args[0])
        approved = os.read(fd, 1)
        os.close(fd)
        if approved != b"1":
            return 1
        os.execvpe(args[1], args[1:], os.environ)
    if mode in ("lease", "lease-pipe"):
        return shared_operation(mode, args)
    if mode == "resolve":
        root, prefix, descriptor = resolve(*args)
        print(json.dumps({"root": str(root), "taskIdPrefix": prefix, "descriptor": descriptor}, separators=(",", ":")))
    elif mode == "context":
        profile, selector, join, raw = args
        print(canonical(validate_context(profile, selector, raw, join == "true")).decode())
    elif mode == "check-shared":
        check_shared_arguments(args)
    elif mode == "check-parent":
        require_parent_shared_lock()
        check_shared_idle()
    elif mode == "check-operations":
        root, _, _ = resolve(*args, complete=True)
        check_operations(root)
    elif mode == "check-delegation":
        if inherited_lease() is None:
            refuse("an inherited owned shared lease is required")
    else:
        refuse("unsupported registry operation")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Refusal, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        print("fmx registry: " + str(error), file=sys.stderr)
        sys.exit(1)
