#!/usr/bin/env python3
"""Read-only admission for managed Firstmate worker entry points."""

from __future__ import annotations

import contextlib
import json
import importlib
import os
import re
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.dont_write_bytecode = True

OWNER = "trellage-firstmate-profiles-v1"
MARKER = ".managed-by-trellage-firstmate-profiles"
EFFORTS = {"low", "medium", "high", "xhigh", "max"}
LIMIT = 64 * 1024


class Refusal(Exception):
    pass


def regular(path: Path, limit: int = LIMIT) -> bytes:
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise Refusal(f"unsafe path: {parent}")
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise Refusal(f"not an owned regular file: {path}")
    if info.st_size > limit:
        raise Refusal(f"file exceeds {limit} bytes: {path}")
    return path.read_bytes()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refusal(f"duplicate JSON field: {key}")
        result[key] = value
    return result


def read_json(path: Path):
    return json.loads(regular(path), object_pairs_hook=unique_object)


def named_context(root, profile, prefix, instance_id, published, verify_runtime):
    registry = importlib.import_module("fmx-registry")
    overlay = importlib.import_module("fmx-overlay")
    try:
        if os.environ.get("FM_ROOT_OVERRIDE", "") not in ("", str(root / "runtime")):
            raise Refusal("FM_ROOT_OVERRIDE cannot redirect the managed instance")
        selected, namespace, descriptor = registry.resolve(profile, instance_id, complete=True)
        if selected != root or namespace != prefix or (published and not registry.is_published(root, descriptor)):
            raise Refusal("instance UUID, root, or task namespace does not match published state")
        if published and verify_runtime:
            package = Path(__file__).resolve().parent.parent
            revision = read_json(package / "catalog.json")["source"]["commit"]
            required = overlay.verify_variant(root / "runtime", package / "overlay" / revision / "manifest.json",
                                              package / "instance-overlay" / revision / "manifest.json", revision)
            if required != descriptor["runtime"]["required"]:
                raise Refusal("worker runtime differs from the approved instance variant")
    except (registry.Refusal, overlay.OverlayError) as error:
        raise Refusal(str(error)) from error


def operational_paths(root):
    home = root / "home"
    if os.environ.get("FM_HOME") != str(home):
        raise Refusal("FM_HOME must name this profile's operational home")
    for key, suffix in (
        ("FM_STATE_OVERRIDE", "state"), ("FM_DATA_OVERRIDE", "data"),
        ("FM_CONFIG_OVERRIDE", "config"), ("FM_PROJECTS_OVERRIDE", "projects"),
    ):
        if os.environ.get(key, "") not in ("", str(home / suffix)):
            raise Refusal(f"{key} cannot redirect the managed profile")
    for path in (root, home, home / "state", home / "config", root / "task-work"):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise Refusal(f"unsafe managed directory: {path}")
    return home


def context(published=False, verify_runtime=True) -> tuple[Path, str]:
    root = Path(os.environ.get("FMX_PROFILE_ROOT", ""))
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise Refusal("FMX_PROFILE_ROOT must name an owned absolute profile directory")
    if regular(root / MARKER).decode().strip() != OWNER:
        raise Refusal("profile ownership differs")
    profile = os.environ.get("FMX_PROFILE", "")
    prefix = os.environ.get("FMX_TASK_ID_PREFIX", "")
    instance_id = os.environ.get("FMX_INSTANCE_ID", "")
    if instance_id or root.parent.name == "instances" or prefix.startswith("fi"):
        named_context(root, profile, prefix, instance_id, published, verify_runtime)
    elif {"default": "fmd", "pstack-workers": "fmp"}.get(profile) != prefix:
        raise Refusal("the profile and task namespace do not match")
    home = operational_paths(root)
    return home, prefix


def native_json(command: str):
    package = Path(__file__).resolve().parent.parent
    helper = package / "lib/native-claude"
    if not helper.exists():
        helper = package.parent / "trellage-claude-common/native-claude"
    env = dict(os.environ, TRELLAGE_CLAUDE_LAUNCHER_NAME="fmx",
               TRELLAGE_CLAUDE_RUNTIME_ROOT=str(package))
    result = subprocess.run(
        [str(helper), command, "--json"], env=env, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=False,
    )
    if result.returncode or len(result.stdout) > LIMIT:
        raise Refusal("shared Claude model configuration or proxy is unavailable")
    return json.loads(result.stdout)


def normalize_model(model: str, aliases: dict, available: list | None) -> str:
    if not isinstance(model, str) or len(model) > 128:
        raise Refusal("invalid Claude model")
    resolved = aliases.get(model or "default", model)
    if not isinstance(resolved, str) or not re.fullmatch(r"claude-[A-Za-z0-9][A-Za-z0-9._-]*", resolved):
        raise Refusal(f"unsupported Claude model: {model}")
    if available is not None and resolved not in available:
        raise Refusal(f"Claude model is not available from the shared proxy: {resolved}")
    return resolved


def effort(value: str) -> str:
    if value in ("", "default"):
        return ""
    if value not in EFFORTS:
        raise Refusal(f"unsupported Claude effort: {value}")
    return value


def dispatch_profile(value, aliases: dict, available: list | None) -> None:
    if not isinstance(value, dict) or set(value) - {"harness", "model", "effort"}:
        raise Refusal("dispatch profiles must be single objects; arrays and commands are not supported")
    if value.get("harness") != "claude":
        raise Refusal("dispatch profiles must use harness claude")
    normalize_model(value.get("model", "default"), aliases, available)
    if "effort" in value and value["effort"] not in EFFORTS:
        raise Refusal("dispatch effort must be low, medium, high, xhigh, or max")


def dispatch_rule(rule, aliases: dict, available: list | None) -> None:
    if not isinstance(rule, dict) or set(rule) - {"when", "use", "why"}:
        raise Refusal("invalid dispatch rule fields")
    when = rule.get("when")
    if not isinstance(when, str) or not when.strip() or len(when) > 4000:
        raise Refusal("dispatch rules require a bounded natural-language when condition")
    if "why" in rule and (not isinstance(rule["why"], str) or len(rule["why"]) > 4000):
        raise Refusal("dispatch why must be bounded text")
    dispatch_profile(rule.get("use"), aliases, available)


def dispatch_config(home: Path, aliases: dict, available: list | None) -> None:
    path = home / "config/crew-dispatch.json"
    if not path.exists() and not path.is_symlink():
        return
    config = read_json(path)
    if not isinstance(config, dict) or set(config) - {"rules", "default"}:
        raise Refusal("crew-dispatch.json requires rules and an optional default")
    rules = config.get("rules", [])
    if not isinstance(rules, list) or len(rules) > 32 or (not rules and "default" not in config):
        raise Refusal("crew-dispatch.json requires up to 32 rules or a default")

    for rule in rules:
        dispatch_rule(rule, aliases, available)
    if "default" in config:
        dispatch_profile(config["default"], aliases, available)


def metadata(home: Path, task: str) -> dict[str, str]:
    fields = {}
    for line in regular(home / "state" / f"{task}.meta").decode().splitlines():
        key, separator, value = line.partition("=")
        if not separator or key in fields:
            raise Refusal("task metadata is incomplete or ambiguous")
        fields[key] = value
    if any(fields.get(key) for key in ("remote_host", "remote_root", "remote_target")):
        raise Refusal("remote secondmate recovery is not supported by fmx")
    fields.setdefault("backend", "tmux")
    instance_id = os.environ.get("FMX_INSTANCE_ID", "")
    if instance_id:
        if fields.get("fmx_instance_id") != instance_id or fields.get("fmx_profile_root") != str(home.parent):
            raise Refusal("recorded worker belongs to another instance")
        if fields["backend"] == "tmux" and fields.get("window") != (
            "firstmate-" + os.environ["FMX_TASK_ID_PREFIX"] + ":fm-" + task
        ):
            raise Refusal("recorded tmux endpoint is outside this instance namespace")
    return fields


def tmux_read(*args):
    result = subprocess.run(["tmux", *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, timeout=5, check=False)
    if result.returncode or len(result.stdout) > LIMIT:
        raise Refusal("live tmux ownership could not be verified")
    return result.stdout.rstrip("\n")


def tmux_endpoint(prefix, target):
    namespace = "firstmate-" + prefix
    if re.fullmatch(r"[@%][0-9]+", target):
        exact_target = target
    else:
        session, separator, window = target.partition(":")
        if not separator or session.lstrip("=") != namespace or not window.lstrip("=").startswith("fm-"):
            raise Refusal("tmux target is outside this instance")
        task_id(window.lstrip("=")[3:], prefix)
        exact_target = "=" + namespace + ":=" + window.lstrip("=")
    rows = tmux_read("list-panes", "-t", exact_target, "-F",
                     "#{session_name}\t#{window_name}\t#{window_id}\t#{pane_id}").splitlines()
    fields = rows[0].split("\t") if len(rows) == 1 else []
    if (len(fields) != 4 or fields[0] != namespace or not fields[1].startswith("fm-")
        or not re.fullmatch(r"@[0-9]+", fields[2]) or not re.fullmatch(r"%[0-9]+", fields[3])):
        raise Refusal("tmux endpoint does not identify one exact owned instance pane")
    task_id(fields[1][3:], prefix)
    if not re.fullmatch(r"[@%][0-9]+", target) and exact_target != "=" + fields[0] + ":=" + fields[1]:
        raise Refusal("tmux returned a different task endpoint")
    return fields


def live_tmux_target(home, prefix, target):
    fields = tmux_endpoint(prefix, target)
    for key, expected in (("FMX_INSTANCE_ID", os.environ["FMX_INSTANCE_ID"]),
                          ("FMX_PROFILE_ROOT", str(home.parent))):
        if tmux_read("show-environment", "-t", "=" + fields[0], key) != key + "=" + expected:
            raise Refusal("live tmux session is not owned by this instance")
    for key, expected in (("@fmx_instance_id", os.environ["FMX_INSTANCE_ID"]),
                          ("@fmx_profile_root", str(home.parent)), ("@fmx_task_id", fields[1][3:])):
        if tmux_read("show-window-options", "-qv", "-t", fields[2], key) != expected:
            raise Refusal("live tmux window is not owned by this instance task")
    return {"target": fields[3], "window": fields[2]}


def live_recorded_target(home, prefix, record):
    if os.environ.get("FMX_INSTANCE_ID") and record["backend"] == "tmux":
        live_tmux_target(home, prefix, record["window"])


def flag_value(args: list[str], index: int) -> tuple[str, str, int]:
    value_flags = {"harness", "model", "effort", "backend", "mode", "yolo",
                   "traceparent", "note", "note-file"}
    arg = args[index]
    key, separator, value = arg[2:].partition("=")
    if key not in value_flags:
        raise Refusal(f"unsupported worker option: {arg}")
    if not separator:
        index += 1
        if index >= len(args):
            raise Refusal(f"{arg} requires a value")
        value = args[index]
    if not value or value.startswith("--"):
        raise Refusal(f"--{key} requires a value")
    return key, value, index


def arguments(args: list[str]) -> tuple[dict, list[str]]:
    values = {}
    positional = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg in ("--scout", "--secondmate", "--relaunch"):
            values[arg[2:]] = True
        elif arg.startswith("--"):
            key, value, index = flag_value(args, index)
            values[key] = value
        else:
            positional.append(arg)
        index += 1
    return values, positional


def task_id(value: str, prefix: str) -> None:
    if len(value) > 64 or not re.fullmatch(re.escape(prefix) + r"-[A-Za-z0-9._-]{1,59}", value):
        raise Refusal(f"task id must start with '{prefix}-' and remain within 64 characters")


def lifecycle_shape(mode: str, values: dict, positional: list[str]) -> bool:
    restored = mode == "control" or values.get("relaunch", False)
    if mode == "control":
        if len(positional) != 2 or positional[1] not in ("interrupt", "exit", "relaunch"):
            raise Refusal("control requires one task id and a supported lifecycle action")
    elif restored and len(positional) != 1:
        raise Refusal("relaunch requires one task id without batch or project arguments")
    return restored


def spawn_shape(mode: str, values: dict, positional: list[str], prefix: str) -> tuple[bool, bool]:
    if values.get("secondmate"):
        raise Refusal("fmx does not manage secondmate homes; use ship or scout")
    if not positional:
        raise Refusal("a task id is required")
    task = positional[0]
    restored = lifecycle_shape(mode, values, positional)
    batch = not restored and "=" in task and "/" not in task.partition("=")[0]
    ids = [pair.partition("=")[0] for pair in positional] if batch else [task]
    for value in ids:
        task_id(value, prefix)
    if batch and any("=" not in pair or not pair.partition("=")[2] for pair in positional):
        raise Refusal("every batch entry must be a task=project pair")
    return restored, batch


def restored_identity(values: dict, record: dict) -> None:
    if record.get("kind") not in ("ship", "scout"):
        raise Refusal("unsupported restored task kind; secondmates are not managed")
    if any(key in values for key in ("scout", "backend", "mode", "yolo")):
        raise Refusal("relaunch cannot override recorded task identity")
    if record.get("harness") != "claude":
        raise Refusal("the recorded task is not a managed Claude worker")
    if record.get("backend") not in ("tmux", "herdr"):
        raise Refusal("the recorded task backend is missing or unsupported")


def selected_backend(home: Path, mode: str, values: dict, record: dict) -> str:
    backend = record.get("backend") or values.get("backend", os.environ.get("FM_BACKEND", ""))
    if not backend:
        path = home / "config/backend"
        backend = regular(path).decode().strip() if path.exists() else "tmux"
    if backend not in ("tmux", "herdr"):
        raise Refusal(f"unsupported backend: {backend}")
    if backend == "herdr" and mode == "spawn" and not (
        os.environ.get("HERDR_ENV") == "1" and os.environ.get("HERDR_PANE_ID")
    ):
        raise Refusal("a Herdr spawn requires the supervisor's real Herdr pane identity")
    return backend


def selected_harness(home: Path, values: dict, positional: list[str],
                     record: dict, batch: bool) -> None:
    harness = values.get("harness", record.get("harness", ""))
    if not harness and not batch and not record and len(positional) > 2:
        harness = positional[2]
    if not harness:
        if (home / "config/crew-dispatch.json").exists():
            raise Refusal("crew dispatch rules require an explicit resolved --harness")
        harness = regular(home / "config/crew-harness").decode().strip()
    if harness != "claude":
        raise Refusal("fmx manages Claude workers only; raw commands are not supported")


def selected_controls(home: Path, values: dict, record: dict) -> dict:
    aliases = native_json("model-map")
    available = native_json("model-catalog")
    dispatch_config(home, aliases, available)
    model = normalize_model(values.get("model", record.get("model", "default")), aliases, available)
    selected_effort = effort(values.get("effort", record.get("effort", "")))
    return {"model": model, "effort": selected_effort}


def admit_worker(home: Path, prefix: str, values: dict, positional: list[str]) -> dict:
    if len(positional) != 3:
        raise Refusal("worker admission requires task, kind, and backend")
    task, kind, backend = positional
    task_id(task, prefix)
    if kind not in ("ship", "scout") or backend not in ("tmux", "herdr"):
        raise Refusal("only ship/scout workers on tmux or Herdr are supported")
    recorded_worker(home, task, kind, backend)
    return selected_controls(home, values, {})


def worker_record_schema(registry, record):
    fields = {"schemaVersion", "profile", "task", "kind", "backend", "harness",
              "model", "effort", "instanceId", "profileRoot"}
    if isinstance(record, dict) and ("spawnOperationId" in record or "startupPid" in record):
        fields.update(("spawnOperationId", "startupPid"))
        if (not registry.UUID.fullmatch(str(record.get("spawnOperationId")))
            or type(record.get("startupPid")) is not int or not 1 <= record["startupPid"] <= 2147483647):
            raise Refusal("worker startup identity is invalid")
    registry.exact(record, fields, "named worker record")


def recorded_worker(home, task, kind, backend, idle=True):
    if not os.environ.get("FMX_INSTANCE_ID"):
        return
    registry = importlib.import_module("fmx-registry")
    root = home.parent / "workers" / task
    try:
        registry.safe(root, True, required=False, private=True)
        if not root.exists():
            return
        if registry.read(root / MARKER).decode().strip() != OWNER:
            raise Refusal("existing named worker home is not owned")
        record = registry.read_json(root / "worker.json", private=True)
        worker_record_schema(registry, record)
        expected = {"profile": os.environ["FMX_PROFILE"], "task": task, "kind": kind, "backend": backend,
                    "harness": "claude", "instanceId": os.environ["FMX_INSTANCE_ID"], "profileRoot": str(home.parent)}
        if any(record[key] != value for key, value in expected.items()):
            raise Refusal("existing worker home belongs to another instance or task")
        active = root / ".active"
        if idle and (active.exists() or active.is_symlink()):
            if registry.alive(registry.pid_text(registry.read(active, 32))):
                raise Refusal("existing worker is still active")
    except registry.Refusal as error:
        raise Refusal(str(error)) from error


def restored_worker(home, task, values, record, action):
    restored_identity(values, record)
    recorded_worker(home, task, record["kind"], record["backend"], idle=action == "relaunch")


def new_workers(home, values, positional, batch, backend):
    kind = "scout" if values.get("scout") else "ship"
    tasks = [pair.partition("=")[0] for pair in positional] if batch else positional[:1]
    for task in tasks:
        recorded_worker(home, task, kind, backend)


def fleet_records(home: Path, prefix: str, aliases: dict, available: list | None) -> None:
    for path in (home / "state").glob("*.meta"):
        task_id(path.stem, prefix)
        record = metadata(home, path.stem)
        restored_identity({}, record)
        normalize_model(record.get("model", "default"), aliases, available)
        effort(record.get("effort", ""))


def terminal_admission(home, prefix, mode, args):
    if mode == "namespace":
        return {"namespace": "firstmate-" + prefix}
    if mode == "endpoint":
        if len(args) != 2 or Path(args[1]) != home / "state" / (args[0] + ".meta"):
            raise Refusal("endpoint metadata must belong to this instance")
        task_id(args[0], prefix)
        record = metadata(home, args[0])
        live_recorded_target(home, prefix, record)
        return record
    if mode == "tmux-target" and len(args) == 1:
        return live_tmux_target(home, prefix, args[0])
    if mode == "selector":
        return owned_selector(home, prefix, args)
    raise Refusal("unsupported terminal admission")


def admit_lifecycle(home, prefix, mode, args):
    values, positional = arguments(args)
    if mode == "worker":
        return admit_worker(home, prefix, values, positional)
    restored, batch = spawn_shape(mode, values, positional, prefix)
    record = metadata(home, positional[0]) if restored else {}
    if restored:
        restored_worker(home, positional[0], values, record, positional[1] if mode == "control" else "relaunch")
        live_recorded_target(home, prefix, record)
    backend = selected_backend(home, mode, values, record)
    if not restored:
        new_workers(home, values, positional, batch, backend)
    selected_harness(home, values, positional, record, batch)
    if mode == "control" and positional[1] in ("interrupt", "exit"):
        return {}
    return selected_controls(home, values, record)


def admit(mode: str, args: list[str]) -> dict:
    home, prefix = context(published=mode not in ("config", "fleet"), verify_runtime=mode != "tmux-target")
    if mode in ("namespace", "endpoint", "selector", "tmux-target"):
        return terminal_admission(home, prefix, mode, args)
    if mode in ("config", "fleet"):
        aliases = native_json("model-map")
        available = None if args == ["--offline"] else native_json("model-catalog")
        dispatch_config(home, aliases, available)
        if mode == "fleet":
            fleet_records(home, prefix, aliases, available)
        return {}
    if mode == "remote":
        raise Refusal("fmx does not manage secondmate homes or remote provisioning")
    if mode not in ("worker", "spawn", "control"):
        raise Refusal("unknown worker admission mode")
    return admit_lifecycle(home, prefix, mode, args)


def owned_selector(home, prefix, args):
    if len(args) != 2 or args[1] != str(home / "state"):
        raise Refusal("terminal selection requires this instance's state directory")
    targets = []
    for path in (home / "state").glob("*.meta"):
        task_id(path.stem, prefix)
        record = metadata(home, path.stem)
        if args[0] in (path.stem, "fm-" + path.stem, record.get("window")):
            live_recorded_target(home, prefix, record)
            targets.append(record["window"])
    if len(targets) != 1:
        raise Refusal("terminal selector must identify one recorded instance task; bare/foreign targets are refused")
    return {"target": targets[0]}


def operation_admission(root, registry):
    lock = registry.shared_lock()
    if lock.exists() or lock.is_symlink():
        raise Refusal("shared Native maintenance is active")
    mutation = root / "locks/mutation"
    if mutation.exists() or mutation.is_symlink():
        pid, action = registry.lock_record(mutation)
        if registry.alive(pid) and action not in ("submit", "receipt", "doctor"):
            raise Refusal("instance maintenance is active")


@contextlib.contextmanager
def locked_operation(registry, root, target, exclusive=False):
    import fcntl

    registry.safe(target, private=True)
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        kind = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(handle.fileno(), kind | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise Refusal("worker startup handoff is still active")
                time.sleep(0.02)
        current = registry.safe(target, private=True)
        opened = os.fstat(handle.fileno())
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise Refusal("instance operation changed during worker handoff")
        yield registry.operation_record(target, root)


@contextlib.contextmanager
def worker_handoff(registry, root, task):
    prefix = os.environ.get("FMX_TASK_ID_PREFIX", "")
    task_id(task, prefix)
    pid = registry.pid_text(os.environ.get("FMX_SPAWN_OPERATION_PID", "").encode())
    operation_id = os.environ.get("FMX_SPAWN_OPERATION_ID", "")
    target = root / "locks/operations" / (str(pid) + ".json")
    with locked_operation(registry, root, target) as record:
        if (record["operation"] != "spawn" or record.get("operationId") != operation_id
            or task not in record.get("taskIds", []) or not registry.alive(pid)):
            raise Refusal("named worker requires its live owned spawn operation")
        yield {"operationId": operation_id, "taskId": task}


def publish_operation(registry, root, target, value):
    if len(registry.canonical(value)) > LIMIT:
        raise Refusal("instance operation exceeds its size limit")
    operation_admission(root, registry)
    registry.atomic_json(target, value)
    try:
        operation_admission(root, registry)
    except BaseException:
        if registry.operation_record(target, root) == value:
            target.unlink()
        raise


def worker_owns_handoff(registry, root, operation_id, task):
    for path in (root / "locks/operations").iterdir():
        if re.fullmatch(r"\.[1-9][0-9]{0,9}\.json\.[a-f0-9]{32}", path.name):
            continue
        try:
            record = registry.operation_record(path, root)
        except FileNotFoundError:
            continue
        if record.get("handoff") == {"operationId": operation_id, "taskId": task} and registry.alive(record["pid"]):
            return True
    worker = root / "workers" / task
    if not worker.exists():
        return False
    registry.safe(worker, True, private=True)
    record_path = worker / "worker.json"
    if not record_path.exists():
        return False
    record = registry.read_json(record_path, private=True)
    recorded_worker(root / "home", task, record.get("kind"), record.get("backend"), idle=False)
    if record.get("spawnOperationId") != operation_id:
        return False
    return registry.pid_text(registry.read(worker / ".active", 32, private=True)) == record["startupPid"]


def wait_for_worker(registry, root, target, task):
    task_id(task, os.environ.get("FMX_TASK_ID_PREFIX", ""))
    record = registry.operation_record(target, root)
    if record["operation"] != "spawn" or "operationId" not in record or task not in record.get("taskIds", []):
        raise Refusal("worker handoff requires the owning spawn operation")
    seconds = os.environ.get("FMX_WORKER_START_WAIT_SECONDS", "30")
    if not re.fullmatch(r"[1-9]|[12][0-9]|30", seconds):
        raise Refusal("worker startup wait must be 1 through 30 seconds")
    deadline = time.monotonic() + int(seconds)
    while registry.alive(record["pid"]):
        if worker_owns_handoff(registry, root, record["operationId"], task):
            return {}
        if time.monotonic() >= deadline:
            raise Refusal("worker startup was not acknowledged; inspect this task before retrying")
        time.sleep(0.05)
    raise Refusal("owning spawn stopped before worker startup")


def spawn_tasks(args):
    values, positional = arguments(list(args))
    _, batch = spawn_shape("spawn", values, positional, os.environ.get("FMX_TASK_ID_PREFIX", ""))
    tasks = [pair.partition("=")[0] for pair in positional] if batch else positional[:1]
    if len(tasks) != len(set(tasks)):
        raise Refusal("spawn task authority is ambiguous")
    return tasks


def instance_operation(mode, pid, operation="", *args):
    registry = importlib.import_module("fmx-registry")
    root, _, descriptor = registry.resolve(os.environ.get("FMX_PROFILE", ""), os.environ.get("FMX_INSTANCE_ID", ""), complete=True)
    if descriptor is None or not registry.is_published(root, descriptor) or str(os.getppid()) != pid:
        raise Refusal("instance activity requires the exact calling process and published UUID")
    target = root / "locks/operations" / (pid + ".json")
    if mode == "operation-wait":
        return wait_for_worker(registry, root, target, operation)
    if mode == "operation-leave":
        if target.exists():
            with locked_operation(registry, root, target, exclusive=True):
                target.unlink()
        return {}
    if operation not in ("spawn", "control", "worker"):
        raise Refusal("unsupported instance operation")
    operation_admission(root, registry)
    registry.ensure_chain(target.parent)
    registry.safe(target.parent, True, private=True)
    if target.exists() or target.is_symlink():
        registry.operation_record(target, root)
    value = {"schemaVersion": 1, "owner": OWNER, "instanceId": root.name, "pid": int(pid),
             "operation": operation, "operationId": str(uuid.uuid4())}
    if operation == "worker":
        if len(args) != 1:
            raise Refusal("worker startup requires one task")
        with worker_handoff(registry, root, args[0]) as handoff:
            value["handoff"] = handoff
            publish_operation(registry, root, target, value)
    else:
        if operation == "spawn":
            value["taskIds"] = spawn_tasks(args)
        publish_operation(registry, root, target, value)
    return {"operationId": value["operationId"]}


def safe_instance_operation(args):
    registry = importlib.import_module("fmx-registry")
    try:
        return instance_operation(*args)
    except registry.Refusal as error:
        raise Refusal(str(error)) from error


def main() -> int:
    try:
        if len(sys.argv) < 2:
            raise Refusal("an admission mode is required")
        if sys.argv[1] in ("operation-enter", "operation-leave", "operation-wait"):
            print(json.dumps(safe_instance_operation(sys.argv[1:])))
            return 0
        print(json.dumps(admit(sys.argv[1], sys.argv[2:]), separators=(",", ":")))
        return 0
    except (Refusal, OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
        print(f"fmx admission: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
