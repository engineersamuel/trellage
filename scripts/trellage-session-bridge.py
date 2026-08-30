#!/usr/bin/env python3

import argparse
import fcntl
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
MAX_MAPPING_BYTES = 16 * 1024
MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
MAX_TRANSCRIPT_HEAD_BYTES = 512 * 1024
MAX_ANSWER_CHARS = 60_000
AGENTS = {"copilot", "codex", "claude"}
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
SAFE_PROFILE_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$")
SAFE_INVOCATION_ID = re.compile(r"^[a-f0-9]{32}$")


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
            "prompt",
            "tool_name",
            "toolName",
            "notification_type",
            "notificationType",
            "stop_reason",
            "stopReason",
            "reason",
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
    if envelope.get("id") != request["id"]:
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
    process_group = (
        process_info.get("foreground_process_group_id")
        if isinstance(process_info, dict)
        else None
    )
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
    request_id = f"trellage.agent-get:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}"
    agent_result = send_herdr_request(
        {
            "id": request_id,
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
    request = {
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
    send_herdr_request(request)


def bridge_directory():
    home = Path(os.environ.get("HOME", ""))
    if not home.is_absolute():
        raise BridgeError("HOME must be an absolute path")
    current = home
    for name in (".trellage", "herdr-session-bridge"):
        metadata = current.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise BridgeError(f"{current} is not a regular directory")
        current /= name
        try:
            current.mkdir(mode=0o700)
        except FileExistsError:
            pass
    metadata = current.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise BridgeError("session bridge path is not a regular directory")
    os.chmod(current, 0o700)
    return current


def atomic_write_json(target, value):
    descriptor, temporary = tempfile.mkstemp(prefix=".mapping-", dir=target.parent)
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


def read_json_object(file_path):
    if not file_path.exists():
        return {}
    source = read_bounded_regular_file(file_path, MAX_TRANSCRIPT_BYTES)
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
    if not config_dir.is_absolute() or not hook_path.is_absolute():
        raise BridgeError("hook installation paths must be absolute")
    if not hook_path.is_file() or hook_path.is_symlink():
        raise BridgeError("session bridge hook path must be a regular file")
    config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    command = shlex.join(
        [str(hook_path), f"{mode}-hook", "--agent", agent, "--profile", profile]
    )
    if agent == "copilot":
        install_copilot_hook(config_dir, command)
    else:
        install_nested_hook(config_dir, agent, command)


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


def read_mapping(invocation_id):
    mapping_path = bridge_directory() / f"{invocation_id}.json"
    source = read_bounded_regular_file(mapping_path, MAX_MAPPING_BYTES)
    try:
        mapping = json.loads(source)
    except json.JSONDecodeError as error:
        raise BridgeError("session mapping is not valid JSON") from error
    if not isinstance(mapping, dict) or mapping.get("version") != 1:
        raise BridgeError("session mapping has an unsupported format")
    if mapping.get("conflict") is True:
        raise BridgeError("session mapping contains conflicting session identities")
    return mapping


def write_sandbox_mapping(agent, profile, invocation_id, session):
    directory = bridge_directory()
    target = directory / f"{invocation_id}.json"
    lock_path = directory / f"{invocation_id}.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        lock_descriptor = os.open(lock_path, flags, 0o600)
    except OSError as error:
        raise BridgeError(f"cannot open the session mapping lock: {error.strerror}") from error
    try:
        os.fchmod(lock_descriptor, 0o600)
        fcntl.flock(lock_descriptor, fcntl.LOCK_EX)
        current = None
        if target.exists():
            current = read_mapping(invocation_id)
        mapping = {
            "version": 1,
            "agent": agent,
            "profile": profile,
            "session_id": session["session_id"],
            "transcript_path": session["transcript_path"],
            "updated_at_ns": time.time_ns(),
        }
        if current is not None:
            identity = ("agent", "profile", "session_id", "transcript_path")
            if any(current.get(name) != mapping.get(name) for name in identity):
                mapping = {
                    "version": 1,
                    "conflict": True,
                    "agent": agent,
                    "profile": profile,
                    "updated_at_ns": time.time_ns(),
                }
        atomic_write_json(target, mapping)
    finally:
        os.close(lock_descriptor)


def parse_jsonl(source):
    records = []
    for line in source.splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def meaningful_text(value):
    return value if isinstance(value, str) and value.strip() else None


def nested_copilot_record(record, data):
    return meaningful_text(record.get("agentId")) is not None or meaningful_text(
        data.get("parentToolCallId")
    ) is not None


def copilot_task_completion(record, data):
    if record.get("type") != "session.task_complete":
        return None
    return meaningful_text(data.get("summary")) or meaningful_text(record.get("summary"))


def copilot_assistant_message(record, data):
    if record.get("type") != "assistant.message":
        return None
    content = meaningful_text(data.get("content")) or meaningful_text(record.get("content"))
    if content is None:
        return None
    return content


def copilot_final_message(records):
    latest = None
    for record in records:
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        if nested_copilot_record(record, data):
            continue
        task_completion = copilot_task_completion(record, data)
        if task_completion is not None:
            latest = task_completion
            continue
        assistant_message = copilot_assistant_message(record, data)
        if assistant_message is not None:
            latest = assistant_message
    return latest


def codex_message_text(payload):
    content = payload.get("content")
    if not isinstance(content, list):
        return None
    parts = []
    for part in content:
        if not isinstance(part, dict) or part.get("type") not in {"output_text", "text"}:
            continue
        text = meaningful_text(part.get("text"))
        if text is not None:
            parts.append(text)
    return "\n".join(parts) if parts else None


def codex_final_message(records):
    latest = None
    for record in records:
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        if record.get("type") == "response_item" and payload.get("type") == "message":
            if payload.get("role") == "assistant":
                latest = codex_message_text(payload) or latest
        if record.get("type") == "event_msg" and payload.get("type") == "agent_message":
            latest = meaningful_text(payload.get("message")) or latest
    return latest


def append_claude_text(current, part):
    if not isinstance(part, dict) or part.get("type") != "text":
        return
    text = meaningful_text(part.get("text"))
    if text is None or text in current["seen"]:
        return
    current["seen"].add(text)
    current["texts"].append(text)


def append_claude_record(messages, record, index):
    message = record.get("message")
    if record.get("type") != "assistant" or not isinstance(message, dict):
        return
    message_id = meaningful_text(message.get("id"))
    if message_id is None:
        return
    current = messages.setdefault(
        message_id, {"texts": [], "seen": set(), "end_turn": False, "index": index}
    )
    content = message.get("content") if isinstance(message.get("content"), list) else []
    for part in content:
        append_claude_text(current, part)
    current["end_turn"] = current["end_turn"] or message.get("stop_reason") == "end_turn"
    current["index"] = index


def claude_final_message(records):
    messages = {}
    for index, record in enumerate(records):
        append_claude_record(messages, record, index)
    completed = [message for message in messages.values() if message["end_turn"] and message["texts"]]
    if not completed:
        return None
    return "\n".join(max(completed, key=lambda message: message["index"])["texts"])


def is_inside(root, candidate):
    try:
        return os.path.commonpath((root, candidate)) == root
    except ValueError:
        return False


def transcript_root(agent):
    home = os.path.abspath(os.environ.get("HOME", ""))
    if agent == "copilot":
        return os.path.join(home, ".copilot", "session-state")
    if agent == "codex":
        return os.path.join(home, ".codex", "sessions")
    return os.path.join(home, ".claude", "projects")


def transcript_path(mapping):
    agent = mapping["agent"]
    configured = mapping.get("transcript_path")
    if agent == "copilot":
        return os.path.join(transcript_root(agent), mapping["session_id"], "events.jsonl")
    if not isinstance(configured, str) or not os.path.isabs(configured):
        raise BridgeError("mapped transcript path is missing or invalid")
    return configured


def path_without_symlinks(root, candidate):
    home = os.path.abspath(os.environ.get("HOME", ""))
    root = os.path.abspath(root)
    candidate = os.path.abspath(candidate)
    if not is_inside(home, root) or not is_inside(root, candidate):
        raise BridgeError("mapped transcript resolves outside the harness state root")
    current = home
    relative = os.path.relpath(candidate, home)
    for component in relative.split(os.sep):
        current = os.path.join(current, component)
        try:
            metadata = os.lstat(current)
        except OSError as error:
            raise BridgeError(f"cannot inspect the mapped transcript path: {error.strerror}") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise BridgeError("mapped transcript path must not traverse symlinks")
    return candidate


def read_transcript(mapping):
    root = transcript_root(mapping["agent"])
    candidate = path_without_symlinks(root, transcript_path(mapping))
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(candidate, flags)
    except OSError as error:
        raise BridgeError(f"cannot open the mapped transcript: {error.strerror}") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise BridgeError("mapped transcript is not a regular file")
        head_length = min(metadata.st_size, MAX_TRANSCRIPT_HEAD_BYTES)
        head = os.read(descriptor, head_length)
        length = min(metadata.st_size, MAX_TRANSCRIPT_BYTES)
        os.lseek(descriptor, metadata.st_size - length, os.SEEK_SET)
        source = os.read(descriptor, length)
    finally:
        os.close(descriptor)
    if metadata.st_size > MAX_TRANSCRIPT_BYTES:
        newline = source.find(b"\n")
        source = b"" if newline < 0 else source[newline + 1 :]
    return candidate, head.decode("utf-8", errors="ignore"), source.decode("utf-8", errors="strict")


def codex_transcript_session_id(head):
    for record in parse_jsonl(head):
        payload = record.get("payload")
        if record.get("type") != "session_meta" or not isinstance(payload, dict):
            continue
        session_id = meaningful_text(payload.get("id")) or meaningful_text(payload.get("session_id"))
        if session_id is not None:
            return session_id
    if re.search(r'"type"\s*:\s*"session_meta"', head) is None:
        return None
    match = re.search(r'"(?:id|session_id)"\s*:\s*("(?:\\.|[^"\\])*")', head)
    if match is None:
        return None
    try:
        return meaningful_text(json.loads(match.group(1)))
    except json.JSONDecodeError:
        return None


def validate_transcript_identity(mapping, candidate, head, records):
    expected = mapping["session_id"]
    if mapping["agent"] == "copilot":
        if os.path.basename(os.path.dirname(candidate)) != expected:
            raise BridgeError("Copilot transcript path conflicts with the mapped session ID")
        return
    if mapping["agent"] == "codex":
        if codex_transcript_session_id(head) != expected:
            raise BridgeError("Codex transcript content conflicts with the mapped session ID")
        return
    session_ids = {
        record.get("sessionId")
        for record in records
        if isinstance(record.get("sessionId"), str) and record.get("sessionId")
    }
    if session_ids != {expected}:
        raise BridgeError("Claude transcript content conflicts with the mapped session ID")


def validate_mapping(mapping, agent, profile):
    mapped_agent = require_pattern(mapping.get("agent"), SAFE_NAME, "mapped agent")
    mapped_profile = require_pattern(mapping.get("profile"), SAFE_PROFILE_NAME, "mapped profile")
    require_pattern(mapping.get("session_id"), SAFE_SESSION_ID, "mapped session ID")
    if mapped_agent not in AGENTS or mapped_agent != agent:
        raise BridgeError("mapped agent does not match the requested agent")
    if mapped_profile != profile:
        raise BridgeError("mapped profile does not match the requested profile")


def final_message(agent, profile, invocation_id):
    mapping = read_mapping(invocation_id)
    validate_mapping(mapping, agent, profile)
    candidate, head, source = read_transcript(mapping)
    records = parse_jsonl(source)
    validate_transcript_identity(mapping, candidate, head, records)
    if agent == "copilot":
        answer = copilot_final_message(records)
    elif agent == "codex":
        answer = codex_final_message(records)
    else:
        answer = claude_final_message(records)
    if answer is None:
        raise BridgeError("mapped transcript does not contain a completed assistant message")
    if len(answer) > MAX_ANSWER_CHARS:
        raise BridgeError(f"completed assistant message exceeds {MAX_ANSWER_CHARS} characters")
    return {
        "version": 1,
        "agent": agent,
        "profile": profile,
        "session_id": mapping["session_id"],
        "answer": answer,
    }


def parse_arguments():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("native-hook", "sandbox-hook"):
        hook = subparsers.add_parser(command)
        hook.add_argument("--agent", choices=sorted(AGENTS), required=True)
        hook.add_argument("--profile", required=True)
    install = subparsers.add_parser("install-hook")
    install.add_argument("--agent", choices=sorted(AGENTS), required=True)
    install.add_argument("--profile", required=True)
    install.add_argument("--mode", choices=("native", "sandbox"), required=True)
    install.add_argument("--config-dir", type=Path, required=True)
    install.add_argument("--hook-path", type=Path, required=True)
    final = subparsers.add_parser("final-message")
    final.add_argument("--agent", choices=sorted(AGENTS), required=True)
    final.add_argument("--profile", required=True)
    final.add_argument("--invocation", required=True)
    return parser.parse_args()


def run_hook(arguments):
    profile = require_pattern(arguments.profile, SAFE_PROFILE_NAME, "profile")
    session = session_from_hook(arguments.agent, read_hook_input())
    if arguments.command == "native-hook":
        report_native_session(arguments.agent, profile, session)
        return
    invocation_id = require_pattern(
        os.environ.get("TRELLAGE_HERDR_INVOCATION_ID"),
        SAFE_INVOCATION_ID,
        "Trellage attachment invocation ID",
    )
    write_sandbox_mapping(arguments.agent, profile, invocation_id, session)


def serialize_result(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def main():
    arguments = parse_arguments()
    try:
        if arguments.command in {"native-hook", "sandbox-hook"}:
            run_hook(arguments)
            return 0
        if arguments.command == "install-hook":
            profile = require_pattern(arguments.profile, SAFE_PROFILE_NAME, "profile")
            install_hook(
                arguments.agent,
                profile,
                arguments.mode,
                arguments.config_dir,
                arguments.hook_path,
            )
            return 0
        profile = require_pattern(arguments.profile, SAFE_PROFILE_NAME, "profile")
        invocation_id = require_pattern(
            arguments.invocation, SAFE_INVOCATION_ID, "Trellage attachment invocation ID"
        )
        print(serialize_result(final_message(arguments.agent, profile, invocation_id)))
        return 0
    except (BridgeError, OSError, UnicodeError) as error:
        if arguments.command == "final-message":
            print(f"trellage session final-message: {error}", file=sys.stderr)
            return 1
        if arguments.command == "install-hook":
            print(f"trellage session bridge install: {error}", file=sys.stderr)
            return 1
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
