#!/usr/bin/env python3

import argparse
import json
import os
import random
import re
import shlex
import socket
import stat
import sys
import tempfile
import time
from pathlib import Path

MAX_HOOK_BYTES = 1024 * 1024
MAX_SETTINGS_BYTES = 8 * 1024 * 1024
AGENTS = {"copilot", "codex", "claude"}
SAFE_PROFILE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")


class BridgeError(Exception):
    pass


def require_pattern(value, pattern, label):
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise BridgeError(f"{label} is missing or invalid")
    return value


def read_hook_input():
    source = sys.stdin.buffer.read(MAX_HOOK_BYTES + 1)
    if len(source) > MAX_HOOK_BYTES:
        raise BridgeError("hook input is too large")
    if not source.strip():
        return {}
    try:
        value = json.loads(source)
    except json.JSONDecodeError as error:
        raise BridgeError(f"hook input is not valid JSON: {error.msg}") from error
    if not isinstance(value, dict):
        raise BridgeError("hook input must be a JSON object")
    return value


def text_field(payload, *names):
    for name in names:
        value = payload.get(name)
        if isinstance(value, str) and value:
            return value
    return None


def normalized_event(payload):
    event = text_field(payload, "hook_event_name", "hookEventName")
    return "" if event is None else event.replace("_", "").replace("-", "").lower()


def session_from_hook(agent, payload):
    event = normalized_event(payload)
    if event and event != "sessionstart":
        raise BridgeError("hook event is not SessionStart")
    if agent == "copilot" and not event:
        non_session_fields = (
            "prompt", "tool_name", "toolName", "notification_type", "notificationType",
            "stop_reason", "stopReason", "reason",
        )
        if any(payload.get(name) is not None for name in non_session_fields):
            raise BridgeError("Copilot hook input is not a session start")
    if agent == "claude" and payload.get("agent_id"):
        raise BridgeError("Claude subagent sessions are not eligible")

    session_id = text_field(payload, "session_id", "sessionId")
    require_pattern(session_id, SAFE_SESSION_ID, "session ID")
    transcript_path = text_field(payload, "transcript_path", "transcriptPath")
    if agent in {"codex", "claude"} and transcript_path is None:
        raise BridgeError("transcript path is missing")
    inherited_codex_id = os.environ.get("CODEX_THREAD_ID")
    if agent == "codex" and inherited_codex_id and inherited_codex_id != session_id:
        raise BridgeError("Codex inherited session ID conflicts with the hook input")
    return {"session_id": session_id, "transcript_path": transcript_path}


def send_herdr_request(request):
    socket_path = os.environ.get("HERDR_SOCKET_PATH")
    if os.environ.get("HERDR_ENV") != "1" or not socket_path or not os.environ.get("HERDR_PANE_ID"):
        return None
    encoded = (json.dumps(request, separators=(",", ":")) + "\n").encode()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(0.5)
        client.connect(socket_path)
        client.sendall(encoded)
        response = bytearray()
        while b"\n" not in response:
            chunk = client.recv(4096)
            if not chunk:
                raise BridgeError("Herdr metadata socket closed without a response")
            response.extend(chunk)
            if len(response) > 65536:
                raise BridgeError("Herdr metadata response is too large")
    try:
        envelope = json.loads(bytes(response).split(b"\n", 1)[0])
    except (UnicodeError, json.JSONDecodeError) as error:
        raise BridgeError("Herdr metadata response is not valid JSON") from error
    if not isinstance(envelope, dict) or envelope.get("id") != request["id"]:
        raise BridgeError("Herdr metadata response ID does not match")
    if envelope.get("error") is not None:
        raise BridgeError(f"Herdr metadata request failed: {envelope['error']}")
    return envelope.get("result")


def require_herdr_agent(result, pane_id, agent):
    info = result.get("agent") if isinstance(result, dict) else None
    sequence = info.get("state_change_seq") if isinstance(info, dict) else None
    if (
        not isinstance(sequence, int)
        or isinstance(sequence, bool)
        or sequence < 0
        or sequence > (2**53 - 2) // 2
        or info.get("pane_id") != pane_id
        or info.get("agent") != agent
        or info.get("agent_status") != "working"
    ):
        raise BridgeError("Herdr did not return the current working agent")
    return sequence


def require_herdr_process_group(result, pane_id):
    process_info = result.get("process_info") if isinstance(result, dict) else None
    process_group = process_info.get("foreground_process_group_id") if isinstance(process_info, dict) else None
    if (
        not isinstance(process_group, int)
        or isinstance(process_group, bool)
        or process_group <= 0
        or process_info.get("pane_id") != pane_id
    ):
        raise BridgeError("Herdr did not return the current foreground process group")
    return process_group


def herdr_agent_context(agent):
    pane_id = os.environ.get("HERDR_PANE_ID")
    agent_result = send_herdr_request(
        {
            "id": f"trellage.agent-get:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}",
            "method": "agent.get",
            "params": {"target": pane_id},
        }
    )
    process_result = send_herdr_request(
        {
            "id": f"trellage.process-info:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}",
            "method": "pane.process_info",
            "params": {"pane_id": pane_id},
        }
    )
    return (
        require_herdr_agent(agent_result, pane_id, agent),
        require_herdr_process_group(process_result, pane_id),
    )


def report_native_session(agent, profile, session):
    pane_id = os.environ.get("HERDR_PANE_ID")
    if not pane_id:
        return
    state_change_seq, process_group = herdr_agent_context(agent)
    source = "trellage.guide-handoff"
    send_herdr_request(
        {
            "id": f"{source}:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}",
            "method": "pane.report_metadata",
            "params": {
                "pane_id": pane_id,
                "source": source,
                "agent": agent,
                "tokens": {
                    "trellage_surface": "native",
                    "trellage_agent": agent,
                    "trellage_profile": profile,
                    "trellage_session_id": session["session_id"],
                    "trellage_state_seq": str(state_change_seq),
                    "trellage_pgrp": str(process_group),
                },
                "seq": state_change_seq * 2 + 1,
            },
        }
    )


def atomic_write_json(target, value):
    descriptor, temporary = tempfile.mkstemp(prefix=".settings-", dir=target.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            json.dump(value, handle, separators=(",", ":"), sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        directory_descriptor = os.open(target.parent, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def read_bounded_regular_file(file_path, maximum):
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(file_path, flags)
    except OSError as error:
        raise BridgeError(f"cannot open {file_path}: {error.strerror}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise BridgeError(f"{file_path} is not a regular file")
        if metadata.st_size > maximum:
            raise BridgeError(f"{file_path} is too large")
        source = os.read(descriptor, maximum + 1)
    finally:
        os.close(descriptor)
    if len(source) > maximum:
        raise BridgeError(f"{file_path} is too large")
    return source


def read_json_object(file_path):
    if not file_path.exists():
        return {}
    source = read_bounded_regular_file(file_path, MAX_SETTINGS_BYTES)
    try:
        value = json.loads(source)
    except json.JSONDecodeError as error:
        raise BridgeError(f"{file_path} is not valid JSON: {error.msg}") from error
    if not isinstance(value, dict):
        raise BridgeError(f"{file_path} must contain a JSON object")
    return value


def hooks_object(settings, file_path):
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise BridgeError(f"{file_path} hooks must be a JSON object")
    return hooks


def event_entries(hooks, file_path):
    entries = hooks.setdefault("SessionStart", [])
    if not isinstance(entries, list):
        raise BridgeError(f"{file_path} SessionStart hooks must be a JSON array")
    return entries


def install_copilot_hook(config_dir, command):
    settings_path = config_dir / "settings.json"
    settings = read_json_object(settings_path)
    entries = event_entries(hooks_object(settings, settings_path), settings_path)
    installed = any(
        isinstance(entry, dict)
        and entry.get("type") == "command"
        and (entry.get("bash") == command or entry.get("command") == command)
        for entry in entries
    )
    if not installed:
        entries.append({"type": "command", "bash": command, "timeoutSec": 10})
        atomic_write_json(settings_path, settings)


def install_nested_hook(config_dir, agent, command):
    file_path = config_dir / ("hooks.json" if agent == "codex" else "settings.json")
    settings = read_json_object(file_path)
    entries = event_entries(hooks_object(settings, file_path), file_path)
    installed = any(
        isinstance(entry, dict)
        and isinstance(entry.get("hooks"), list)
        and any(
            isinstance(hook, dict)
            and hook.get("type") == "command"
            and hook.get("command") == command
            for hook in entry["hooks"]
        )
        for entry in entries
    )
    if installed:
        return
    entry = {"hooks": [{"type": "command", "command": command, "timeout": 10}]}
    if agent == "claude":
        entry["matcher"] = "*"
    entries.append(entry)
    atomic_write_json(file_path, settings)


def install_hook(agent, profile, mode, config_dir, hook_path):
    if mode != "native":
        raise BridgeError("hook mode must be native")
    if not config_dir.is_absolute() or not hook_path.is_absolute():
        raise BridgeError("hook installation paths must be absolute")
    if not hook_path.is_file() or hook_path.is_symlink():
        raise BridgeError("session bridge hook path must be a regular file")
    config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    command = shlex.join(
        [str(hook_path), "native-hook", "--agent", agent, "--profile", profile]
    )
    if agent == "copilot":
        install_copilot_hook(config_dir, command)
    else:
        install_nested_hook(config_dir, agent, command)


def parse_arguments():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    hook = subparsers.add_parser("native-hook")
    hook.add_argument("--agent", choices=sorted(AGENTS), required=True)
    hook.add_argument("--profile", required=True)
    install = subparsers.add_parser("install-hook")
    install.add_argument("--agent", choices=sorted(AGENTS), required=True)
    install.add_argument("--profile", required=True)
    install.add_argument("--mode", choices=("native",), required=True)
    install.add_argument("--config-dir", type=Path, required=True)
    install.add_argument("--hook-path", type=Path, required=True)
    return parser.parse_args()


def main():
    arguments = parse_arguments()
    try:
        profile = require_pattern(arguments.profile, SAFE_PROFILE_NAME, "profile")
        if arguments.command == "install-hook":
            install_hook(
                arguments.agent,
                profile,
                arguments.mode,
                arguments.config_dir,
                arguments.hook_path,
            )
            return 0
        session = session_from_hook(arguments.agent, read_hook_input())
        report_native_session(arguments.agent, profile, session)
        return 0
    except (BridgeError, OSError, UnicodeError) as error:
        if arguments.command == "install-hook":
            print(f"trellage session bridge install: {error}", file=sys.stderr)
            return 1
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
