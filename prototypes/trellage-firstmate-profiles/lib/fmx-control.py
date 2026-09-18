#!/usr/bin/env python3
"""Owned fleet identity and bounded text-inbox transport for fmx."""

from __future__ import annotations

import contextlib
import hashlib
import importlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

sys.dont_write_bytecode = True
controls = importlib.import_module("fmx-controls")
registry = importlib.import_module("fmx-registry")
OWNER = controls.OWNER
MARKER = controls.MARKER
MAX_REQUEST = 524288
MAX_IDENTITY = 65536
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
EMPTY_ID = "00000000-0000-4000-8000-000000000000"
PACKAGE = Path(__file__).resolve().parent.parent


class Failure(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def exact(value, keys, name):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise Failure("invalid-request", f"{name} has missing or unsupported fields")


def text(value, maximum, name, multiline=False):
    if not isinstance(value, str) or not value.replace("\ufeff", "").strip():
        raise Failure("invalid-request", f"{name} must be nonempty text")
    if any(0xD800 <= ord(char) <= 0xDFFF for char in value):
        raise Failure("invalid-request", f"{name} contains an unpaired Unicode surrogate")
    if len(value.encode("utf-16-le")) // 2 > maximum:
        raise Failure("invalid-request", f"{name} exceeds {maximum} UTF-16 characters")
    pattern = r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]" if multiline else r"[\x00-\x1f\x7f-\x9f]"
    if re.search(pattern, value):
        raise Failure("invalid-request", f"{name} contains control characters")
    return value


def identifier(value, name):
    result = text(value, 128, name)
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", result):
        raise Failure("invalid-request", f"{name} must be a lowercase kebab-case identifier")
    return result


def project_name(value):
    result = text(value, 128, "projectName")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9._-]{0,127}", result):
        raise Failure("invalid-request", "projectName must be a safe basename without whitespace or path separators")
    return result


def absolute(value, name):
    result = text(value, 4096, name)
    if not Path(result).is_absolute():
        raise Failure("invalid-request", f"{name} must be absolute")
    return result


def fleet(value):
    exact(value, ("profile", "instanceId", "home", "sourceRevision"), "expectedFleet")
    identifier(value["profile"], "profile")
    if not isinstance(value["instanceId"], str) or not UUID.fullmatch(value["instanceId"]):
        raise Failure("invalid-request", "instanceId must be a lowercase version-4 UUID")
    absolute(value["home"], "home")
    if not isinstance(value["sourceRevision"], str) or not re.fullmatch(r"[a-f0-9]{40}", value["sourceRevision"]):
        raise Failure("invalid-request", "sourceRevision must be a 40-character commit")


def source(value):
    exact(value, ("kind", "location"), "source")
    if value["kind"] == "local":
        absolute(value["location"], "location")
        return
    if value["kind"] != "git":
        raise Failure("invalid-request", "source kind must be local or git")
    location = text(value["location"], 4096, "location")
    if re.fullmatch(r"[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+", location):
        return
    parsed = urlsplit(location)
    _ = parsed.port
    if parsed.scheme not in ("https", "ssh") or not parsed.hostname or parsed.path in ("", "/"):
        raise Failure("invalid-request", "Git source must identify an HTTPS or SSH repository")
    if parsed.password or (parsed.scheme == "https" and parsed.username) or parsed.query or parsed.fragment:
        raise Failure("invalid-request", "Git source cannot contain credentials, query data, or fragments")


def project(value):
    if value is None:
        return
    exact(value, ("schemaVersion", "projectName", "source", "entryWorktree", "baseRevision", "dirty", "dirtyChanges"), "projectTarget")
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1 or value["dirtyChanges"] != "excluded":
        raise Failure("invalid-request", "invalid project target version or dirty-change policy")
    if value["projectName"] is not None:
        project_name(value["projectName"])
    if value["entryWorktree"] is not None:
        absolute(value["entryWorktree"], "entryWorktree")
    if value["baseRevision"] is not None and (
        not isinstance(value["baseRevision"], str)
        or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", value["baseRevision"])
    ):
        raise Failure("invalid-request", "baseRevision must be a resolved Git object ID")
    if value["dirty"] is not None and type(value["dirty"]) is not bool:
        raise Failure("invalid-request", "dirty must be a boolean or null")
    project_source(value)


def project_source(value):
    if value["source"] is None:
        if value["projectName"] is None:
            raise Failure("invalid-request", "a project name or source is required")
        if any(value[key] is not None for key in ("entryWorktree", "baseRevision", "dirty")):
            raise Failure("invalid-request", "Git inspection fields require an explicit source")
        return
    source(value["source"])
    if value["baseRevision"] is None:
        raise Failure("invalid-request", "an explicit source requires its resolved base revision")
    if value["source"]["kind"] == "local" and (value["entryWorktree"] is None or value["dirty"] is None):
        raise Failure("invalid-request", "a local source requires inspected worktree and dirty state")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def request(mode, receipt):
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise Failure("request-too-large", "JSON input exceeds 524288 bytes")
    value = json.loads(raw, object_pairs_hook=controls.unique_object)
    if isinstance(value, dict) and isinstance(value.get("requestId"), str) and UUID.fullmatch(value["requestId"]):
        receipt["requestId"] = value["requestId"]
    keys = ["schemaVersion", "requestId", "expectedFleet"]
    if mode == "submit":
        keys += ["originalIntent", "generatedSpec", "workflowId", "projectTarget"]
    exact(value, keys, mode)
    if type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1:
        raise Failure("invalid-request", "schemaVersion must equal 1")
    if not isinstance(value["requestId"], str) or not UUID.fullmatch(value["requestId"]):
        raise Failure("invalid-request", "requestId must be a lowercase version-4 UUID")
    fleet(value["expectedFleet"])
    if mode == "submit":
        text(value["originalIntent"], 60000, "originalIntent", True)
        text(value["generatedSpec"], 8000, "generatedSpec", True)
        identifier(value["workflowId"], "workflowId")
        project(value["projectTarget"])
    if len(canonical(value)) > MAX_REQUEST:
        raise Failure("request-too-large", "canonical request exceeds 524288 bytes")
    return value


def owned_root(root):
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise Failure("unsafe-fleet", "profile directory is missing or unsafe")
    if controls.regular(root / MARKER).decode().strip() != OWNER:
        raise Failure("unsafe-fleet", "profile ownership does not match")
    for path in (root / "home", root / "home/state", root / "home/config", root / "locks", root / "receipts"):
        if path.is_symlink() or not path.is_dir():
            raise Failure("unsafe-fleet", f"managed directory is missing or unsafe: {path}")


def instance_record(root, profile, complete=True):
    if complete:
        owned_root(root)
    path = root / "receipts/instance.json"
    record = controls.read_json(path)
    exact(record, ("schemaVersion", "owner", "profile", "instanceId", "home", "prerequisitesConsent"), "fleet instance")
    if type(record["schemaVersion"]) is not int or record["schemaVersion"] != 1 or record["owner"] != OWNER or record["profile"] != profile:
        raise Failure("unsafe-fleet", "fleet instance ownership does not match")
    if record["home"] != str(root / "home") or not UUID.fullmatch(str(record["instanceId"])):
        raise Failure("unsafe-fleet", "fleet instance home or UUID does not match")
    if stat.S_IMODE(path.stat().st_mode) != 0o600 or type(record["prerequisitesConsent"]) is not bool:
        raise Failure("unsafe-fleet", "fleet instance permissions or consent record are unsafe")
    if root.parent.name == "instances":
        selected, _, _ = registry.resolve(profile, root.name)
        if root != selected or record["instanceId"] != root.name:
            raise Failure("unsafe-fleet", "named root and immutable instance identity disagree")
    return record


def identity(root, profile, revision):
    record = instance_record(root, profile)
    return {key: record[key] for key in ("profile", "instanceId", "home")} | {"sourceRevision": revision}


def verify_expected_identity(root, profile, revision, raw):
    if len(raw.encode("utf-8")) > MAX_IDENTITY:
        raise Failure("identity-too-large", "expected fleet identity exceeds 65536 bytes")
    expected = json.loads(raw, object_pairs_hook=controls.unique_object)
    fleet(expected)
    lock = root / "locks/mutation"
    if (
        controls.regular(lock / "owner").decode().strip() != OWNER
        or controls.regular(lock / "action").decode().strip() != "launch"
        or controls.regular(lock / "pid", 32).decode().strip() != str(os.getppid())
    ):
        raise Failure("unsafe-fleet", "expected fleet identity requires the owning launch mutation gate")
    if expected != identity(root, profile, revision):
        raise Failure("fleet-changed", "expected fleet identity differs from the owned current fleet")


def new_instance_record(root, profile, automatic):
    if root.parent.name == "instances":
        raise Failure("unsafe-fleet", "named identity is missing; reconcile the original approved UUID, never initialize a replacement")
    inbox = root / "home/state/inbox"
    if automatic and (inbox.is_symlink() or (inbox.exists() and any(inbox.rglob("*.note")))):
        raise Failure("unsafe-fleet", "saved inbox requests require recovery of the original fleet identity")
    return dict(schemaVersion=1, owner=OWNER, profile=profile, instanceId=str(uuid.uuid4()),
                home=str(root / "home"), prerequisitesConsent=not automatic)


def initialize(root, profile, automatic=False):
    owned_root(root)
    lock = root / "locks/mutation"
    action = controls.regular(lock / "action").decode().strip()
    allowed = ("prepare",) if automatic else ("setup", "repair")
    if (action not in allowed
        or controls.regular(lock / "owner").decode().strip() != OWNER
        or controls.regular(lock / "pid").decode().strip() != str(os.getppid())):
        raise Failure("unsafe-fleet", "fleet identity requires the owning idle setup, repair, or preparation operation")
    path = root / "receipts/instance.json"
    if path.exists() or path.is_symlink():
        record = instance_record(root, profile)
        if automatic or record["prerequisitesConsent"]:
            return
        record["prerequisitesConsent"] = True
    else:
        record = new_instance_record(root, profile, automatic)
    # Automatic migration cannot manufacture prior setup consent. Neither kind
    # of setup consent authorizes installation of a prerequisite plan.
    stage = path.with_name(f".instance-{uuid.uuid4().hex}")
    fd = os.open(stage, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(canonical(record) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(stage, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        stage.unlink(missing_ok=True)


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def retire_lock(lock):
    if lock.is_symlink() or not lock.is_dir():
        raise Failure("busy", "profile mutation lock is unsafe")
    names = {path.name for path in lock.iterdir()}
    if names != {"owner", "pid", "action"}:
        raise Failure("busy", "profile mutation lock is incomplete or ambiguous")
    if controls.regular(lock / "owner").decode().strip() != OWNER:
        raise Failure("busy", "profile mutation lock is not owned")
    action = controls.regular(lock / "action").decode().strip()
    if action not in registry.ACTIONS:
        raise Failure("busy", "profile mutation lock action is not owned")
    value = controls.regular(lock / "pid", 32).decode().strip()
    if not re.fullmatch(r"[1-9][0-9]{0,9}", value) or int(value) > 2147483647 or pid_alive(int(value)):
        raise Failure("busy", "another profile operation is active or indeterminate")
    old = lock.with_name(f".mutation-stale.{os.getpid()}")
    if old.exists() or old.is_symlink():
        raise Failure("busy", "stale lock retirement path is occupied")
    os.rename(lock, old)
    for name in names:
        (old / name).unlink()
    old.rmdir()


def reclaim(lock):
    import fcntl

    guard = lock.with_name(".mutation-reclaim")
    fd = os.open(guard, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, "r+") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise Failure("busy", "mutation reclaim guard is not owned")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Failure("busy", "another operation is reclaiming the mutation lock") from error
        retire_lock(lock)


@contextlib.contextmanager
def mutation(root, mode):
    owned_root(root)
    package_locks = (PACKAGE.parent / ".fmx-install.lock",
                     Path(os.environ["HOME"]) / ".local/share/trellage/.fmx-install.lock")
    lock = root / "locks/mutation"
    if any(path.exists() or path.is_symlink() for path in package_locks):
        raise Failure("busy", "launcher installation is active or requires recovery")
    try:
        lock.mkdir(mode=0o700)
    except FileExistsError:
        reclaim(lock)
        lock.mkdir(mode=0o700)
    claimed = lock.stat()
    try:
        for name, value in (("owner", OWNER), ("action", mode), ("pid", str(os.getpid()))):
            fd = os.open(lock / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(value + "\n")
        if any(path.exists() or path.is_symlink() for path in package_locks):
            raise Failure("busy", "launcher installation is active")
        yield
    finally:
        if lock.is_dir() and not lock.is_symlink() and lock.stat().st_ino == claimed.st_ino:
            for name in ("owner", "pid", "action"):
                (lock / name).unlink(missing_ok=True)
            lock.rmdir()


def selected_root(profile):
    selector = os.environ.get("FMX_SELECTED_INSTANCE", "legacy")
    if selector == "legacy":
        return registry.profiles_root() / registry.profile_name(profile)
    return registry.resolve(profile, selector)[0]


def launcher_arguments(mode, profile, *args):
    command = [str(PACKAGE / "bin/fmx"), mode, profile, *args]
    selector = os.environ.get("FMX_SELECTED_INSTANCE", "legacy")
    context = os.environ.get("FMX_INSTANCE_CONTEXT_JSON", "")
    if selector != "legacy" or context:
        command += ["--instance", selector]
    if context and mode not in ("inventory", "_control-readiness"):
        command += ["--fmx-instance-context-json", context]
    return command


def selected_context(profile):
    selector = os.environ.get("FMX_SELECTED_INSTANCE", "legacy")
    raw = os.environ.get("FMX_INSTANCE_CONTEXT_JSON", "")
    if selector == "legacy" and not raw:
        return None
    value = registry.validate_context(profile, selector, raw)
    require_runtime_context(value)
    return value


def require_runtime_context(value):
    if value is None or value["reference"]["mode"] != "named":
        return
    overlay = importlib.import_module("fmx-overlay")
    revision = controls.read_json(PACKAGE / "catalog.json")["source"]["commit"]
    try:
        required = overlay.variant_requirement(PACKAGE / "overlay" / revision / "manifest.json",
                                               PACKAGE / "instance-overlay" / revision / "manifest.json", revision)
    except (overlay.OverlayError, OSError, ValueError) as error:
        raise Failure("source-mismatch", "named runtime requirements are missing or unsafe") from error
    if registry.digest(required) != value["expectedRuntimeDigest"]:
        raise Failure("source-mismatch", "named runtime requirements changed; prior control approval cannot authorize a new variant")


def readiness(profile):
    process = subprocess.run(
        launcher_arguments("_control-readiness", profile),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=60, check=False,
    )
    if process.returncode or len(process.stdout) > 65536:
        raise Failure("unavailable", "fleet readiness could not be verified")
    return json.loads(process.stdout)


def producer(root, args, body=None):
    helper = PACKAGE / "lib/native-claude"
    if not helper.exists():
        helper = PACKAGE.parent / "trellage-claude-common/native-claude"
    runtime = root / "runtime"
    env = {key: value for key, value in os.environ.items() if not key.startswith(("FM_", "FMX_"))}
    env.update(FM_HOME=str(root / "home"), FM_ROOT_OVERRIDE=str(runtime),
               TRELLAGE_CLAUDE_LAUNCHER_NAME="fmx", TRELLAGE_CLAUDE_RUNTIME_ROOT=str(runtime))
    if root.parent.name == "instances":
        descriptor = registry.named_descriptor(root, identity_required=True)
        env.update(FMX_PROFILE=descriptor["profile"], FMX_PROFILE_ROOT=str(root),
                   FMX_INSTANCE_ID=root.name, FMX_TASK_ID_PREFIX=descriptor["taskIdPrefix"],
                   FMX_WORKER_LAUNCHER=str(PACKAGE / "lib/fmx-worker"))
    bash = str(Path(os.environ.get("FMX_CONTROL_BASH", "/bin/bash")).resolve())
    return subprocess.run(
        [str(helper), "exec-clean", "--interpreter", bash, "--", str(runtime / "bin/fm-inbox.sh"), *args],
        input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, cwd=runtime,
        timeout=30, check=False,
    )


def inspect_note(root, request_id):
    if root.parent.name == "instances":
        return owned_note_receipt(root, request_id)
    result = producer(root, ["receipt", "--request-id", request_id, "--json"])
    if result.returncode or len(result.stdout) > 4096:
        raise Failure("receipt-unavailable", "the canonical inbox producer could not inspect this request")
    return json.loads(result.stdout)


@contextlib.contextmanager
def receipt_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_nlink != 1 or info.st_mode & 0o022):
            raise Failure("receipt-unavailable", "inbox receipt is not an owned regular file")
        yield handle


def receipt_bytes(path, limit):
    with receipt_file(path) as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise Failure("receipt-unavailable", "inbox receipt exceeds its size limit")
    return data


def note_location(inbox, request_id):
    handled = inbox / "handled"
    registry.safe(handled, True, required=False)
    paths = [path for path in (inbox / (request_id + ".note"), handled / (request_id + ".note"))
             if path.exists() or path.is_symlink()]
    if len(paths) > 1:
        raise Failure("receipt-unavailable", "request has ambiguous pending and handled records")
    return paths[0] if paths else None


def note_digest(path, request_id):
    header, separator, payload = receipt_bytes(path, MAX_REQUEST + 1024).partition(b"\n--\n")
    if not separator or not payload.endswith(b"\n"):
        raise Failure("receipt-unavailable", "request note is incomplete")
    fields = {}
    for line in header.decode("ascii").splitlines():
        key, equals, value = line.partition("=")
        if not equals or key in fields:
            raise Failure("receipt-unavailable", "request note header is ambiguous")
        fields[key] = value
    digest = hashlib.sha256(payload[:-1]).hexdigest()
    if fields.get("id") != request_id or fields.get("source") != "text" or fields.get("request_sha256") != digest:
        raise Failure("receipt-unavailable", "request note identity or content differs")
    return digest


def saved_note_receipt(inbox, request_id, result):
    path = note_location(inbox, request_id)
    if path is None:
        return result
    digest = note_digest(path, request_id)
    announcement = "pending"
    signal_path = inbox / ".requests" / (request_id + ".announcement")
    if signal_path.exists() or signal_path.is_symlink():
        signal_value = json.loads(receipt_bytes(signal_path, 1024), object_pairs_hook=controls.unique_object)
        exact(signal_value, ("digest", "announcement"), "request announcement")
        if signal_value["digest"] != digest or signal_value["announcement"] not in ("sent", "failed"):
            raise Failure("receipt-unavailable", "request announcement does not match the saved note")
        announcement = signal_value["announcement"]
    handled = path.parent != inbox
    return dict(result, digest=digest, noteId=request_id, state="handled" if handled else "saved",
                announcement="not-needed" if handled else announcement)


def owned_note_receipt(root, request_id):
    import fcntl

    if not UUID.fullmatch(request_id):
        raise Failure("invalid-request", "receipt requires a version-4 request UUID")
    result = dict(schemaVersion=1, state="not-found", noteId=None, digest=None, announcement="not-needed")
    inbox = root / "home/state/inbox"
    if registry.safe(inbox, True, required=False) is None:
        return result
    records = inbox / ".requests"
    if registry.safe(records, True, required=False, private=True) is None:
        if note_location(inbox, request_id) is not None:
            raise Failure("receipt-unavailable", "request registry is missing for an existing note")
        return result
    lock = records / (request_id + ".lock")
    if not lock.exists() and not lock.is_symlink():
        if note_location(inbox, request_id) is not None:
            raise Failure("receipt-unavailable", "request lock is missing for an existing note")
        return result
    with receipt_file(lock) as handle:
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Failure("receipt-unavailable", "request publication is still active")
                time.sleep(0.05)
        return saved_note_receipt(inbox, request_id, result)


def base_receipt(request_id=EMPTY_ID):
    return dict(schemaVersion=1, requestId=request_id, digest=None, fleet=None, state="rejected",
                noteId=None, announcement="not-needed", supervisorState="unsafe", error=None)


def send_submission(root, value, receipt):
    body = canonical(value)
    digest = hashlib.sha256(body).hexdigest()
    receipt["digest"] = digest
    try:
        result = producer(root, ["note", "--request-id", value["requestId"], "-"], body)
        output, status = result.stdout, result.returncode
    except subprocess.TimeoutExpired as error:
        output, status = error.stdout or b"", 1
    if ("queued " + value["requestId"]).encode("ascii") in output.splitlines():
        receipt.update(state="saved", noteId=value["requestId"], digest=digest,
                       announcement="pending")
    return digest, status


def receipt_status(receipt, producer_status):
    if receipt["announcement"] == "failed":
        receipt["error"] = {
            "code": "wake-failed",
            "message": "the note is saved but its announcement failed; inspect or retry this same request ID",
        }
        return 1
    if producer_status and receipt["state"] != "handled":
        receipt["error"] = {"code": "save-incomplete", "message": "the producer did not finish; inspect this request ID before retrying"}
        return 1
    return 0


def transfer(root, profile, mode, value, receipt):
    current = readiness(profile)
    receipt["fleet"] = current["identity"]
    receipt["supervisorState"] = current["supervisor"]["state"]
    if current["identity"] != value["expectedFleet"]:
        raise Failure("fleet-changed", "the selected fleet identity has changed")
    if (mode == "submit" or root.parent.name != "instances") and (
        current["runtime"] != "ready" or current["supervisor"]["state"] == "unsafe"
    ):
        raise Failure("runtime-not-ready", "the owned fleet runtime is not ready")
    if mode == "submit" and not current["actions"]["submit"]["allowed"]:
        raise Failure("submit-not-allowed", current["actions"]["submit"]["reason"])
    producer_status = 0
    if mode == "submit":
        expected_digest, producer_status = send_submission(root, value, receipt)
    note = inspect_note(root, value["requestId"])
    if mode == "submit" and note["state"] not in ("saved", "handled"):
        raise Failure("receipt-unavailable", "the submitted request has no confirmed saved or handled receipt")
    if mode == "submit" and note["state"] in ("saved", "handled") and note["digest"] != expected_digest:
        raise Failure("request-conflict", "this request ID already belongs to different content; the prior accepted request is unchanged")
    receipt.update({key: note[key] for key in ("digest", "state", "noteId", "announcement")})
    return receipt_status(receipt, producer_status)


def failure_receipt(mode, validated, receipt, error):
    invalid_payload = not validated and isinstance(error, (Failure, controls.Refusal, ValueError, TypeError))
    details = {"code": getattr(error, "code", "invalid-request" if invalid_payload else "unavailable"),
               "message": str(error)[:4000] or "request failed"}
    if receipt["state"] in ("saved", "handled"):
        receipt["error"] = details
        return True
    if mode == "submit" and (invalid_payload or details["code"] == "request-conflict"):
        receipt.update(state="rejected", noteId=None, error=details)
        return True
    print(f'fmx control: request {receipt["requestId"]} outcome unknown ({details["code"]}); '
          f'inspect or retry this same request ID. {details["message"]}', file=sys.stderr)
    return False


def control(mode, profile):
    receipt = base_receipt()
    validated = False
    try:
        value = request(mode, receipt)
        validated = True
        receipt["requestId"] = value["requestId"]
        identifier(profile, "profile")
        home = Path(os.environ["HOME"])
        if not home.is_absolute() or home.is_symlink() or not home.is_dir() or home.resolve() == Path("/"):
            raise Failure("unsafe-fleet", "HOME is missing or unsafe")
        root = selected_root(profile)
        with mutation(root, mode):
            if mode == "submit":
                selected_context(profile)
            status = transfer(root, profile, mode, value, receipt)
    except (Failure, controls.Refusal, registry.Refusal, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        if not failure_receipt(mode, validated, receipt, error):
            return 1
        status = 1
    print(json.dumps(receipt, ensure_ascii=True, separators=(",", ":")))
    return status


def safe_preparation_path(path, directory=False):
    for entry in (path, *path.parents):
        if entry.is_symlink():
            raise Failure("unsafe-fleet", f"automatic preparation refuses a symlink: {entry}")
    if not path.exists():
        return
    info = path.stat()
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    if not expected or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise Failure("unsafe-fleet", f"automatic preparation refuses an unsafe or unowned path: {path}")


def preparation_safety(root, profile):
    safe_preparation_path(root, True)
    if not root.is_dir() or controls.regular(root / MARKER).decode().strip() != OWNER:
        raise Failure("unsafe-fleet", "automatic preparation requires an existing owned profile; use explicit setup")
    for suffix in ("home", "home/config", "home/data", "home/state", "home/projects",
                   "captain", "captain/claude", "workers", "receipts", "locks", "policy",
                   "runtime", "runtime.previous", "staging", "task-work"):
        safe_preparation_path(root / suffix, True)
    for suffix in ("home/.fmx-managed", "home/.tasks.toml", "home/backlog.md",
                   "home/data/backlog.md", "home/config/crew-harness", "home/config/secondmate-harness",
                   "home/config/crew-dispatch.json", "receipts/source.json", "receipts/instance.json",
                   "receipts.previous.json", "policy/worker-policy.md", "locks/generation"):
        safe_preparation_path(root / suffix)
    if (root / "receipts/instance.json").exists():
        instance_record(root, profile, complete=False)
    for home in preparation_homes(root):
        preparation_claude_safety(home)


def preparation_homes(root):
    homes = [root / "captain"]
    workers = root / "workers"
    if workers.exists():
        for worker in workers.iterdir():
            safe_preparation_path(worker, True)
            if controls.regular(worker / MARKER).decode().strip() != OWNER:
                raise Failure("unsafe-fleet", "automatic preparation refuses an unowned worker home")
            homes.append(worker)
    return homes


def preparation_claude_safety(home):
    marker = home / MARKER
    safe_preparation_path(marker)
    if marker.exists():
        if controls.regular(marker).decode().strip() != OWNER:
            raise Failure("unsafe-fleet", "automatic preparation refuses a foreign Claude ownership marker")
    elif home.exists() and any(home.iterdir()):
        raise Failure("unsafe-fleet", "automatic preparation cannot claim a nonempty unowned Claude home")
    config = home / "claude"
    for suffix in ("", ".trellage", "skills"):
        safe_preparation_path(config / suffix, True)
    for suffix in (".claude.json", "settings.json", ".trellage/trellage-session-bridge.py"):
        safe_preparation_path(config / suffix)
    for suffix in (".credentials.json", "credentials.json", "auth.json"):
        if (config / suffix).exists() or (config / suffix).is_symlink():
            raise Failure("authentication", "automatic preparation will not change an authenticated Claude profile")
    for suffix in (".claude.json", "settings.json"):
        preparation_auth_config(config / suffix)


def preparation_auth_config(path):
    if not path.exists():
        return
    value = controls.read_json(path)
    if not isinstance(value, dict):
        raise Failure("unsafe-fleet", "managed Claude configuration is not an object")
    if any(key in value for key in ("oauthAccount", "oauthToken", "primaryApiKey", "apiKeyHelper")):
        raise Failure("authentication", "automatic preparation will not change Claude authentication configuration")
    environment = value.get("env", {})
    if isinstance(environment, dict) and any(
        re.search(r"TOKEN|API_KEY|SECRET|CREDENTIAL|AUTH|BASE_URL|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY", key)
        for key in environment
    ):
        raise Failure("authentication", "automatic preparation will not change Claude provider configuration")


def require_cached_skills():
    data = Path(os.environ.get("XDG_DATA_HOME", str(Path(os.environ["HOME"]) / ".local/share")))
    cache = data / "trellage/common/skills"
    safe_preparation_path(cache, True)
    safe_preparation_path(cache / "skills", True)
    try:
        names = controls.regular(cache / "managed-skills.txt").decode().splitlines()
        controls.regular(cache / "always-on.md")
    except (OSError, controls.Refusal) as error:
        raise Failure("skills-cache", "automatic preparation requires the existing shared skill cache; run trx skills update first") from error
    if not names or len(set(names)) != len(names) or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) for name in names):
        raise Failure("skills-cache", "the shared skill cache manifest is unsafe; automatic fetching is disabled")
    if {entry.name for entry in (cache / "skills").iterdir()} != set(names):
        raise Failure("skills-cache", "the shared skill cache does not match its manifest")
    for name in names:
        safe_preparation_path(cache / "skills" / name, True)
        controls.regular(cache / "skills" / name / "SKILL.md", 1024 * 1024)
    count = 0
    for entry in cache.rglob("*"):
        count += 1
        if count > 100000:
            raise Failure("skills-cache", "the shared skill cache exceeds the preparation limit")
        safe_preparation_path(entry, entry.is_dir())


class PreparationCancelled(BaseException):
    def __init__(self, number):
        self.number = number


preparation_child = None
preparation_cancellation_depth = 0
preparation_pending_signal = None


@contextlib.contextmanager
def defer_preparation_cancellation():
    global preparation_cancellation_depth, preparation_pending_signal
    preparation_cancellation_depth += 1
    try:
        yield
    finally:
        preparation_cancellation_depth -= 1
        if preparation_cancellation_depth == 0 and preparation_pending_signal is not None:
            number = preparation_pending_signal
            preparation_pending_signal = None
            cancel_preparation(number, None)


def stop_preparation_child():
    global preparation_child
    child = preparation_child
    if child is None:
        return
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=5)
    preparation_child = None


def cancel_preparation(number, _frame):
    global preparation_pending_signal
    if preparation_cancellation_depth:
        preparation_pending_signal = preparation_pending_signal or number
        return
    with defer_preparation_cancellation():
        stop_preparation_child()
    raise PreparationCancelled(number)


def preparation_process(arguments, timeout=60):
    global preparation_child
    child = None
    try:
        # Deferring the handler does not block signals in the spawned process.
        with defer_preparation_cancellation():
            child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, start_new_session=True)
            preparation_child = child
        return preparation_output(child, arguments, timeout)
    finally:
        with defer_preparation_cancellation():
            if child is not None:
                if preparation_child is child:
                    stop_preparation_child()
                child.stdout.close()
                child.stderr.close()


def preparation_output(child, arguments, timeout):
    streams = {child.stdout: bytearray(), child.stderr: bytearray()}
    deadline = time.monotonic() + timeout
    with selectors.DefaultSelector() as selector:
        for stream in streams:
            selector.register(stream, selectors.EVENT_READ)
        while selector.get_map():
            if time.monotonic() >= deadline:
                raise Failure("timeout", "automatic preparation reached its time limit; owned child work was stopped")
            for key, _ in selector.select(min(0.2, max(0, deadline - time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 8192)
                if not data:
                    selector.unregister(key.fileobj)
                else:
                    streams[key.fileobj].extend(data)
                    if len(streams[key.fileobj]) > 65536:
                        raise Failure("output-limit", "preparation output exceeded its safe limit")
    status = child.wait(timeout=max(0.01, deadline - time.monotonic()))
    return subprocess.CompletedProcess(arguments, status, bytes(streams[child.stdout]), bytes(streams[child.stderr]))


def wire_limit(value, maximum):
    return value.encode("utf-16-le", errors="replace")[:maximum * 2].decode("utf-16-le", errors="ignore")


def diagnostic(raw):
    value = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
    value = re.sub(r"https?://[^\s]+", lambda match: redact_url(match[0]), value)
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]", "", value).strip()
    return wire_limit(value, 4000) or "automatic preparation could not finish"


def tool_report(ready, description, managed, host):
    description = re.sub(r"[\x00-\x20\x7f-\x9f]", " ", diagnostic(description))
    return dict(ready=ready, description=wire_limit(description, 2000), managedMissing=managed, hostMissing=host)


def redact_url(value):
    try:
        url = urlsplit(value)
        if url.username or url.password or url.query or url.fragment:
            return f"{url.scheme}://{url.hostname}/[credential details omitted]"
    except ValueError:
        return "[unsafe URL omitted]"
    return value


NPM_NETWORK_KEYS = (
    "registry", "proxy", "https-proxy", "noproxy", "strict-ssl", "ca", "cafile",
    "local-address", "offline", "prefer-offline", "prefer-online", "cache",
)
NPM_PROXY_ENV = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                 "http_proxy", "https_proxy", "all_proxy", "no_proxy")


def npm_command(arguments, environment, content=None, install=False):
    command = ["npm", *arguments, "--loglevel=silent", "--logs-max=0", "--update-notifier=false"]
    result = subprocess.run(command, env=environment, input=content, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=180 if install else 30, check=False)
    if result.returncode or len(result.stdout) > 65536:
        operation = "install the approved locked packages" if install else "read the effective host npm configuration"
        raise Failure("npm-configuration", f"npm could not {operation}; check host feed access and npm configuration")
    return result.stdout


def npm_configuration(environment, prefix=None, content=None):
    arguments = ["config", "list", "--json"]
    if content is not None:
        arguments += ["--prefix", str(prefix), "--userconfig=/dev/stdin", "--globalconfig=/dev/null"]
    value = json.loads(npm_command(arguments, environment, content), object_pairs_hook=controls.unique_object)
    if not isinstance(value, dict) or value.get("global"):
        raise Failure("npm-configuration", "managed prerequisites require local npm mode; global installation is not supported")
    return value


def npmrc_content(path):
    path = Path(path)
    if not path.is_absolute():
        raise Failure("npm-configuration", "npm configuration paths must be absolute")
    try:
        with path.open("rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid()) or info.st_mode & 0o022:
                raise Failure("npm-configuration", "npm configuration must be an owned or administrator-managed regular file")
            value = handle.read(1024 * 1024 + 1)
    except FileNotFoundError:
        if path.is_symlink():
            raise Failure("npm-configuration", "an npm configuration link is unavailable")
        return b""
    if len(value) > 1024 * 1024:
        raise Failure("npm-configuration", "npm configuration exceeds the safe snapshot limit")
    return value


def merge_npmrc(contents):
    merged = {}
    for content in contents:
        layer = {}
        for line in content.decode("utf-8-sig").splitlines():
            if not line.strip() or line.lstrip().startswith(("#", ";")):
                continue
            match = re.fullmatch(r"\s*([A-Za-z0-9_@./:!-]+)(\[\])?\s*(?:=.*)?", line)
            if match is None:
                raise Failure("npm-configuration", "automatic installation cannot safely snapshot this npmrc syntax; retain host policy and use an approved manual installation")
            layer.setdefault(match[1], []).append(line)
        merged.update(layer)
    return ("\n".join(line for lines in merged.values() for line in lines) + "\n").encode(), set(merged)


def require_reviewable_npm_configuration(config, declared, environment, scopes):
    declared = {key.lower() for key in declared}
    declared.update(key[11:].lower().replace("_", "-") for key in environment if key.lower().startswith("npm_config_"))
    required = {"registry", "proxy", "https-proxy"}
    required.update(scope + ":registry" for scope in scopes if scope + ":registry" in declared)
    if not required.issubset(config):
        raise Failure("npm-configuration", "an effective npm registry or proxy is protected and cannot be safely reviewed; use npmrc authentication fields without URL credentials")


def prerequisite_data(manifest_path, artifact, npm_prefix=None):
    manifest_path = Path(manifest_path)
    allowed = (PACKAGE / "prerequisites/manifest.json", PACKAGE / "prerequisite-lock/manifest.json")
    if manifest_path not in allowed:
        raise Failure("artifact-lock", "the prerequisite manifest must belong to the executing runtime")
    npm_prefix = npm_prefix or manifest_path.parent / "npm"
    paths = (manifest_path, npm_prefix / "package.json", npm_prefix / "package-lock.json")
    contents = [controls.regular(path, 8 * 1024 * 1024) for path in paths]
    digest = hashlib.sha256()
    for label, content in zip(("manifest", "package", "lock"), contents):
        digest.update(label.encode() + b"\0" + content + b"\0")
    if artifact != digest.hexdigest():
        raise Failure("artifact-lock", "prerequisite artifact lock changed; refresh preparation")
    return (json.loads(contents[0], object_pairs_hook=controls.unique_object),
            json.loads(contents[2], object_pairs_hook=controls.unique_object))


def npm_locked_scopes(lock):
    scopes = set()
    for location, metadata in lock["packages"].items():
        if "resolved" in metadata or metadata.get("link"):
            raise Failure("npm-configuration", "the prerequisite lock contains a fixed URL or local link; its sources cannot be safely represented")
        names = location.split("node_modules/")[1:] + [metadata.get("name", "")]
        for name in names:
            if name.startswith("@"):
                scopes.add(name.split("/")[0])
        scopes.update(npm_dependency_scopes(metadata))
    if any(not re.fullmatch(r"@[A-Za-z0-9][A-Za-z0-9._-]{0,127}", scope) for scope in scopes):
        raise Failure("npm-configuration", "the prerequisite lock has an invalid npm scope")
    return sorted(scopes)


def npm_dependency_scopes(metadata):
    scopes = set()
    for field in ("dependencies", "optionalDependencies", "devDependencies"):
        for value in metadata.get(field, {}).values():
            scope = npm_registry_dependency(value)
            if scope:
                scopes.add(scope)
    return scopes


def npm_registry_dependency(value):
    scope = None
    if isinstance(value, str) and value.startswith("npm:"):
        alias = re.fullmatch(r"npm:(?:(@[A-Za-z0-9._-]+)/)?[A-Za-z0-9_][A-Za-z0-9._-]*(?:@(.*))?", value)
        if alias is None:
            raise Failure("npm-configuration", "the prerequisite lock contains an unsupported npm alias")
        scope, version = alias.groups()
        value = version or "*"
    if (not isinstance(value, str) or not value or value.startswith(".")
        or re.search(r"[:/\\#@]|\.(?:tgz|tar\.gz)$", value)):
        raise Failure("npm-configuration", "non-registry npm dependencies are not supported by managed prerequisite plans")
    return scope


def npm_network_configuration(config, scopes):
    values = {key: config.get(key) for key in NPM_NETWORK_KEYS}
    values.update({scope + ":registry": config.get(scope + ":registry") or config.get("registry") for scope in scopes})
    return values


def reviewed_url(value, label, proxy=False):
    if not isinstance(value, str) or len(value.encode("utf-16-le")) // 2 > 1500:
        raise Failure("npm-configuration", f"{label} must be a bounded URL")
    try:
        parsed = urlsplit(value)
        valid_scheme = parsed.scheme in (("http", "https") if proxy else ("https",))
        if not valid_scheme or not parsed.hostname or parsed.port == 0 or any(ord(char) < 33 for char in value):
            raise ValueError()
    except ValueError as error:
        raise Failure("npm-configuration", f"{label} must use a valid {'HTTP or HTTPS' if proxy else 'HTTPS'} URL") from error
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise Failure("npm-configuration", f"{label} contains credentials or query data and cannot be safely reviewed; retain host policy and use npmrc authentication fields or an approved manual installation")
    return value


def npm_proxy_sources(config, environment):
    sources = []
    for key in ("proxy", "https-proxy"):
        if config.get(key) not in (None, False, ""):
            sources.append(f"Configured npm {key}: {reviewed_url(config[key], 'npm ' + key, proxy=True)}")
    for key in NPM_PROXY_ENV:
        if key.lower() != "no_proxy" and environment.get(key):
            sources.append(f"Configured npm environment {key}: {reviewed_url(environment[key], key, proxy=True)}")
    return sources


class NpmSnapshot:
    def __init__(self, npm_source, scopes):
        self.environment = dict(os.environ)
        self.scopes = scopes
        if (npm_source / ".npmrc").exists() or (npm_source / ".npmrc").is_symlink():
            raise Failure("npm-configuration", "the prerequisite lock directory contains an unexpected npmrc")
        original = npm_configuration(self.environment)
        project = Path(npm_command(["prefix"], self.environment).decode().strip()) / ".npmrc"
        paths = [Path(original[key]) for key in ("globalconfig", "userconfig")] + [project]
        contents = [npmrc_content(path) for path in paths]
        self.content, declared = merge_npmrc(contents)
        self.config = npm_configuration(self.environment, npm_source, self.content)
        require_reviewable_npm_configuration(self.config, declared, self.environment, scopes)
        if contents != [npmrc_content(path) for path in paths]:
            raise Failure("npm-configuration", "host npm configuration changed while it was read; refresh the installation plan")
        if npm_network_configuration(original, scopes) != npm_network_configuration(self.config, scopes):
            raise Failure("npm-configuration", "this npm configuration cannot be reproduced safely in the managed install; no feed was substituted")
        self.registry = reviewed_url(self.config.get("registry"), "npm registry")
        self.registries = {scope: reviewed_url(self.config.get(scope + ":registry") or self.registry, scope + " registry")
                           for scope in scopes}
        self.cache = Path(absolute(self.config.get("cache"), "npm cache")).resolve()

    def sources(self):
        values = [f"Configured host npm registry: {self.registry}"]
        values += [f"Configured npm scope {scope}: {registry}" for scope, registry in self.registries.items()
                   if registry != self.registry]
        return values + npm_proxy_sources(self.config, self.environment)

    def fingerprint(self):
        return dict(configuration=npm_network_configuration(self.config, self.scopes),
                    proxyEnvironment={key: self.environment.get(key) for key in NPM_PROXY_ENV})

    def install(self, prefix):
        if (prefix / ".npmrc").exists() or (prefix / ".npmrc").is_symlink():
            raise Failure("npm-configuration", "the staged npm directory contains an unexpected npmrc")
        arguments = ["ci", "--prefix", str(prefix), "--userconfig=/dev/stdin", "--globalconfig=/dev/null",
                     "--registry=" + self.registry, "--cache=" + str(self.cache),
                     "--ignore-scripts", "--no-audit", "--no-fund", "--progress=false"]
        arguments += ["--" + scope + ":registry=" + registry for scope, registry in self.registries.items()]
        npm_command(arguments, self.environment, self.content, install=True)


def prerequisite_plan(manifest_path, artifact, destination, home, platform):
    manifest, lock = prerequisite_data(manifest_path, artifact)
    snapshot = NpmSnapshot(Path(manifest_path).parent / "npm", npm_locked_scopes(lock))
    tools = [{"name": name, "version": version} for name, version in manifest["npm"]["tools"].items()]
    sources = snapshot.sources()
    for name, binary in manifest["binaries"].items():
        asset = binary["assets"][platform]
        tools.append({"name": name, "version": binary["version"]})
        sources.append(f'Checksum-verified release: https://github.com/{binary["repository"]}/releases/download/'
                       f'{binary["tag"]}/{asset["archive"]} (SHA-256 {asset["sha256"]})')
    if len(sources) > 8:
        raise Failure("npm-configuration", "the effective npm feeds and proxies exceed the reviewable source limit; use an approved manual installation")
    plan = dict(destination=destination, tools=sorted(tools, key=lambda entry: entry["name"]), sources=sources,
                statePaths=list(dict.fromkeys([home + "/.no-mistakes", str(snapshot.cache)])))
    authority = dict(schemaVersion=1, artifactLock=artifact, plan=plan, npm=snapshot.fingerprint())
    selector = os.environ.get("FMX_SELECTED_INSTANCE", "legacy")
    if selector != "legacy":
        context = registry.control_context(registry.json_value(os.environ.get("FMX_INSTANCE_CONTEXT_JSON", "").encode()))
        profile = context["reference"]["profile"]
        validated = registry.validate_context(profile, selector, canonical(context).decode())
        require_runtime_context(validated)
        authority["instance"] = {"context": validated, "root": str(selected_root(profile))}
    identity = hashlib.sha256(canonical(authority)).hexdigest()
    return dict(identity=identity, **plan), snapshot


def require_npm_install_locks(destination, prefix):
    root = Path(destination).parent.parent
    for lock, owner in ((root.parent / ".fmx-install.lock", "trellage-firstmate-install-lock-v1"),
                        (root / "prerequisites/.install-lock", "trellage-firstmate-prerequisites-v1")):
        if (controls.regular(lock / "owner").decode().strip() != owner
            or controls.regular(lock / "pid").decode().strip() != str(os.getppid())):
            raise Failure("unsafe-install", "npm installation requires the owning runtime and prerequisite locks")
    if prefix.parent.parent != root / "prerequisites" or not prefix.parent.name.startswith(".stage."):
        raise Failure("unsafe-install", "npm installation requires the owned prerequisite stage")
    safe_preparation_path(prefix, True)


def npm_operation(mode, arguments):
    expected = 5 if mode == "npm-plan" else 8
    if len(arguments) != expected:
        raise Failure("invalid-operation", "invalid internal npm plan operation")
    manifest, artifact, destination, home, platform = arguments[:5]
    if mode == "npm-ci":
        prefix, approved, revision = arguments[5:]
        require_npm_install_locks(destination, Path(prefix))
    plan, snapshot = prerequisite_plan(manifest, artifact, destination, home, platform)
    if mode == "npm-plan":
        print(json.dumps(plan, ensure_ascii=True, separators=(",", ":")))
        return 0
    if plan["identity"] != approved:
        raise Failure("stale-plan", "prerequisite installation plan changed; review the current destination and sources")
    prerequisite_data(manifest, artifact)
    prerequisite_data(manifest, artifact, Path(prefix))
    if revision and controls.read_json(PACKAGE / "catalog.json")["source"]["commit"] != revision:
        raise Failure("stale-source", "Firstmate source revision changed before npm installation")
    snapshot.install(Path(prefix))
    return 0


def preparation_helper(*arguments):
    helper = PACKAGE / "lib/native-claude"
    if not helper.exists():
        helper = PACKAGE.parent / "trellage-claude-common/native-claude"
    return preparation_process([
        "env", "TRELLAGE_CLAUDE_LAUNCHER_NAME=fmx", f"TRELLAGE_CLAUDE_RUNTIME_ROOT={PACKAGE}",
        str(helper), "exec-clean", "--", str(PACKAGE / "lib/fmx-prerequisites"), *arguments,
    ])


def preparation_inventory(profile):
    result = preparation_process(launcher_arguments("inventory", profile, "--json"))
    if result.returncode:
        raise Failure("unavailable", "preparation could not inspect the current fleet: " + diagnostic(result.stderr))
    return json.loads(result.stdout, object_pairs_hook=controls.unique_object)


def preparation_expectations(revision, approved):
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise Failure("invalid-request", "expected source revision must be a lowercase 40-character SHA")
    if approved and not re.fullmatch(r"[a-f0-9]{64}", approved):
        raise Failure("invalid-request", "approved prerequisite identity must be a lowercase SHA-256")
    catalog = controls.read_json(PACKAGE / "catalog.json")
    if catalog["source"]["commit"] != revision:
        raise Failure("stale-source", "Firstmate source revision changed; refresh the profile catalog")
    result = preparation_helper("identity")
    if result.returncode:
        raise Failure("resolver", diagnostic(result.stderr))
    identity = result.stdout.decode("ascii").strip()
    if not re.fullmatch(r"[a-f0-9]{64}", identity):
        raise Failure("resolver", "the prerequisite helper returned an invalid lock identity")
    if approved and approved != preparation_plan()["identity"]:
        raise Failure("stale-plan", "prerequisite installation plan changed; review the current destination and sources")
    return identity


def preparation_plan():
    result = preparation_helper("plan")
    if result.returncode:
        raise Failure("installation-plan", diagnostic(result.stderr))
    return json.loads(result.stdout, object_pairs_hook=controls.unique_object)


def finish_preparation(inventory, state, message=None, repairs=None, installation=None):
    fleet = inventory["fleet"]
    for entry in fleet["prerequisites"]:
        entry["status"] = ("ready" if entry["ready"] else
                           "not-checked" if entry["description"].startswith("Not checked:") else "blocked")
    fleet["preparation"] = dict(schemaVersion=1, state=state, diagnostic=diagnostic(message) if message is not None else None,
                               repairs=repairs or [], installation=installation)
    print(json.dumps(inventory, ensure_ascii=True, separators=(",", ":")))
    return 0


def preparation_maintenance(profile, revision, identity, approved, inventory, repair_cache):
    fleet = inventory["fleet"]
    repair_needed = (fleet["runtime"] != "ready" or fleet["identity"] is None
                     or any(not row["ready"] for row in fleet["prerequisites"] if row["id"] in ("claude", "skills")))
    if not repair_needed and not approved and not repair_cache:
        return inventory, [], None
    result = preparation_process(launcher_arguments("_prepare-owned", profile,
                                  revision, identity, approved, "true" if repair_cache else "false"), timeout=240)
    repairs = [wire_limit(line, 512) for line in result.stdout.decode("utf-8", errors="replace").splitlines() if line.strip()][:16]
    failure = diagnostic(result.stderr) if result.returncode else None
    return preparation_inventory(profile), repairs, failure


def preparation_tools_result(inventory, report, repairs, cache_status):
    if not report["managedMissing"] and cache_status in (0, 3):
        return finish_preparation(inventory, "blocked", report["description"], repairs)
    try:
        plan = preparation_plan()
    except (Failure, controls.Refusal, OSError, ValueError, TypeError) as error:
        return finish_preparation(inventory, "blocked", diagnostic(error), repairs)
    return finish_preparation(inventory, "needs-consent", report["description"], repairs, plan)


def preparation_result(profile, inventory, repairs, failure, cache_status):
    fleet = inventory["fleet"]
    if failure:
        return finish_preparation(inventory, "blocked", failure, repairs)
    if fleet["runtime"] != "ready":
        return finish_preparation(inventory, "blocked", f'Owned fleet runtime is {fleet["runtime"]}; automatic preparation cannot change this state.', repairs)
    tools = preparation_process(launcher_arguments("_preparation-tools", profile))
    if tools.returncode:
        return finish_preparation(inventory, "blocked", diagnostic(tools.stderr), repairs)
    report = json.loads(tools.stdout)
    if not report["ready"]:
        return preparation_tools_result(inventory, report, repairs, cache_status)
    if fleet["consentRequired"]:
        return finish_preparation(inventory, "blocked", "The owned identity is ready, but explicit setup consent is missing. Run fmx repair " + profile + "; this does not approve tool installation.", repairs)
    missing = [row["description"] for row in fleet["prerequisites"] if not row["ready"]]
    if missing:
        return finish_preparation(inventory, "blocked", diagnostic("; ".join(missing)), repairs)
    return finish_preparation(inventory, "ready", repairs=repairs)


def preparation_cache(approved):
    cache = preparation_helper("path")
    recovery = preparation_helper("recoverable") if cache.returncode != 0 else None
    if recovery is not None and recovery.returncode not in (0, 3):
        raise Failure("cache-recovery", diagnostic(recovery.stderr))
    if approved or cache.returncode not in (0, 3):
        preparation_plan()
    return cache.returncode, recovery is not None and recovery.returncode == 0


def prepare(profile, revision, approved):
    for number in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(number, cancel_preparation)
    identifier(profile, "profile")
    selected_context(profile)
    identity = preparation_expectations(revision, approved)
    inventory = preparation_inventory(profile)
    fleet = inventory["fleet"]
    active = fleet["supervisor"]["state"] == "running" or fleet["activeWorkers"] > 0
    if active or fleet["runtime"] == "busy":
        if active and fleet["actions"]["submit"]["allowed"] and not approved:
            return finish_preparation(inventory, "ready", "Active fleet inspected; no maintenance was done.")
        return finish_preparation(inventory, "blocked", "Preparation cannot change an active or busy fleet; its existing actions remain available.")
    if inventory["readiness"] == "healthy" and not approved:
        return finish_preparation(inventory, "ready")
    root = selected_root(profile)
    try:
        preparation_safety(root, profile)
        cache_status, repair_cache = preparation_cache(approved)
    except (Failure, controls.Refusal, OSError, ValueError, TypeError) as error:
        return finish_preparation(inventory, "blocked", diagnostic(error))
    inventory, repairs, failure = preparation_maintenance(profile, revision, identity, approved, inventory, repair_cache)
    return preparation_result(profile, inventory, repairs, failure, cache_status)


def helper_operation(mode, root, profile):
    if mode == "init":
        initialize(root, profile)
    elif mode == "init-automatic":
        initialize(root, profile, automatic=True)
    elif mode == "prepare-safe":
        preparation_safety(root, profile)
    elif mode == "cached-skills":
        require_cached_skills()
    elif mode == "reclaim":
        owned_root(root)
        reclaim(root / "locks/mutation")
    elif mode == "identity":
        print(json.dumps(identity(root, profile, sys.argv[4]), separators=(",", ":")))
    elif mode == "verify-expected":
        if len(sys.argv) != 6:
            raise Failure("invalid-operation", "expected fleet identity requires one JSON argument")
        verify_expected_identity(root, profile, sys.argv[4], sys.argv[5])
    elif mode == "consent":
        if not instance_record(root, profile)["prerequisitesConsent"]:
            return 1
    else:
        raise Failure("invalid-operation", "unsupported control helper operation")
    return 0


def main():
    mode = sys.argv[1]
    if mode in ("submit", "receipt"):
        return control(mode, sys.argv[2])
    try:
        if mode in ("npm-plan", "npm-ci"):
            return npm_operation(mode, sys.argv[2:])
        if mode == "tool-report":
            if len(sys.argv) != 6 or sys.argv[2] not in ("true", "false"):
                raise Failure("invalid-operation", "invalid internal prerequisite report")
            print(json.dumps(tool_report(sys.argv[2] == "true", *sys.argv[3:]), ensure_ascii=True, separators=(",", ":")))
            return 0
        if mode == "prepare":
            if len(sys.argv) != 5:
                raise Failure("invalid-operation", "invalid internal preparation arguments")
            return prepare(sys.argv[2], sys.argv[3], sys.argv[4])
        return helper_operation(mode, Path(sys.argv[2]), sys.argv[3])
    except PreparationCancelled as error:
        print("fmx prepare: cancelled; owned child work was stopped", file=sys.stderr)
        return 128 + error.number
    except (Failure, controls.Refusal, registry.Refusal, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        print(f"fmx control: {error}", file=sys.stderr)
        return 1
if __name__ == "__main__":
    sys.exit(main())
